import { prisma } from '../lib/prisma.js';
import { CATEGORY_MAP } from '../config/constants.js';
import { predictHotspots } from './ai.service.js';
import { env } from '../config/env.js';
import { CALIBRATION } from '../config/calibration/index.js';

/**
 * Every dashboard number is derived here from real rows — no dashboard card
 * reads a hard-coded constant.
 */

const startOfDay = (offsetDays = 0) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d;
};
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const pctChange = (a, b) => (b ? Number((((a - b) / b) * 100).toFixed(1)) : 0);
const avg = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);

/** Scope helper: officers see their wards, admins see everything. */
const wardScope = (wardIds) => (wardIds === null ? {} : { wardId: { in: wardIds } });

export async function overview(wardIds) {
  const scope = wardScope(wardIds);
  const today = startOfDay();
  const yesterday = startOfDay(1);

  const [todayComplaints, yesterdayComplaints, open, vehicles, emergencies, resolvedRecent] = await Promise.all([
    prisma.complaint.count({ where: { ...scope, createdAt: { gte: today } } }),
    prisma.complaint.count({ where: { ...scope, createdAt: { gte: yesterday, lt: today } } }),
    prisma.complaint.findMany({
      where: { ...scope, status: { notIn: ['RESOLVED', 'REJECTED'] } },
      select: { id: true, severity: true, isEmergency: true, dueAt: true, reviewNeeded: true, status: true },
    }),
    prisma.vehicle.findMany({
      where: wardIds === null ? {} : { wardId: { in: wardIds } },
      select: { id: true, status: true, lastPingAt: true, maintenanceFlag: true },
    }),
    prisma.complaint.count({
      where: { ...scope, isEmergency: true, status: { notIn: ['RESOLVED', 'REJECTED'] } },
    }),
    prisma.complaint.findMany({
      where: { ...scope, resolvedAt: { gte: startOfDay(6) } },
      select: { createdAt: true, resolvedAt: true, dueAt: true },
    }),
  ]);

  const now = Date.now();
  const resolutionMinutes = resolvedRecent.map((c) => (c.resolvedAt - c.createdAt) / 60_000);
  const withinSla = resolvedRecent.filter((c) => !c.dueAt || c.resolvedAt <= c.dueAt).length;

  return {
    generatedAt: new Date(),
    kpis: {
      complaintsToday: todayComplaints,
      complaintsDeltaPct: pctChange(todayComplaints, yesterdayComplaints),
      openComplaints: open.length,
      overdue: open.filter((c) => c.dueAt && c.dueAt.getTime() < now).length,
      reviewNeeded: open.filter((c) => c.reviewNeeded).length,
      emergenciesOpen: emergencies,
      critical: open.filter((c) => c.severity === 'CRITICAL').length,
      unassigned: open.filter((c) => c.status === 'PENDING' || c.status === 'VERIFIED').length,
      vehiclesTotal: vehicles.length,
      vehiclesOnRoute: vehicles.filter((v) => v.status === 'ON_ROUTE').length,
      vehiclesOnline: vehicles.filter((v) => v.lastPingAt && now - v.lastPingAt.getTime() < 60_000).length,
      vehiclesMaintenance: vehicles.filter((v) => v.maintenanceFlag).length,
      resolvedLast7Days: resolvedRecent.length,
      avgResolutionMinutes: Math.round(avg(resolutionMinutes)),
      slaCompliancePct: resolvedRecent.length ? Math.round((withinSla / resolvedRecent.length) * 100) : 0,
    },
  };
}

export async function statusBreakdown(wardIds) {
  const rows = await prisma.complaint.groupBy({
    by: ['status'],
    where: wardScope(wardIds),
    _count: { _all: true },
  });
  return rows.map((r) => ({ status: r.status, count: r._count._all }));
}

export async function categoryBreakdown(wardIds, days = 7) {
  const rows = await prisma.complaint.groupBy({
    by: ['category'],
    where: { ...wardScope(wardIds), createdAt: { gte: startOfDay(days - 1) } },
    _count: { _all: true },
  });
  const total = rows.reduce((a, r) => a + r._count._all, 0) || 1;
  return rows
    .map((r) => ({
      category: r.category,
      label: CATEGORY_MAP[r.category]?.label || r.category,
      count: r._count._all,
      pct: Number(((r._count._all / total) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.count - a.count);
}

export async function trends(wardIds, days = 14) {
  const from = startOfDay(days - 1);
  const complaints = await prisma.complaint.findMany({
    where: { ...wardScope(wardIds), createdAt: { gte: from } },
    select: { createdAt: true, resolvedAt: true, isEmergency: true, dueAt: true },
  });

  const buckets = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const start = startOfDay(i);
    const end = startOfDay(i - 1);
    const reported = complaints.filter((c) => c.createdAt >= start && c.createdAt < end);
    const resolved = complaints.filter((c) => c.resolvedAt && c.resolvedAt >= start && c.resolvedAt < end);
    const onTime = resolved.filter((c) => !c.dueAt || c.resolvedAt <= c.dueAt).length;

    buckets.push({
      date: dayKey(start),
      label: start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      weekday: start.toLocaleDateString('en-IN', { weekday: 'short' }),
      reported: reported.length,
      resolved: resolved.length,
      emergencies: reported.filter((c) => c.isEmergency).length,
      slaPct: resolved.length ? Math.round((onTime / resolved.length) * 100) : null,
    });
  }
  return buckets;
}

export async function wardPerformance(wardIds) {
  const wards = await prisma.ward.findMany({
    where: wardIds === null ? {} : { id: { in: wardIds } },
    orderBy: { code: 'asc' },
  });
  const since = startOfDay(6);

  /**
   * Who actually runs each ward.
   *
   * The ward editor let an admin register an officer but never showed the
   * result, so there was no way to tell an unstaffed ward from a staffed one
   * — or to notice a ward that had quietly lost its officer.
   */
  const wardOfficers = await prisma.wardOfficer.findMany({
    where: wardIds === null ? {} : { wardId: { in: wardIds } },
    include: { officer: { select: { id: true, name: true, email: true, phone: true, isActive: true, avatarColor: true } } },
  });
  const officersByWard = new Map();
  for (const link of wardOfficers) {
    if (!officersByWard.has(link.wardId)) officersByWard.set(link.wardId, []);
    officersByWard.get(link.wardId).push({ ...link.officer, isPrimary: link.isPrimary });
  }

  const results = [];
  for (const ward of wards) {
    const [open, recent, vehicles] = await Promise.all([
      prisma.complaint.count({ where: { wardId: ward.id, status: { notIn: ['RESOLVED', 'REJECTED'] } } }),
      prisma.complaint.findMany({
        where: { wardId: ward.id, createdAt: { gte: since } },
        select: { createdAt: true, resolvedAt: true, dueAt: true, isEmergency: true, severity: true },
      }),
      prisma.vehicle.count({ where: { wardId: ward.id } }),
    ]);

    const resolved = recent.filter((c) => c.resolvedAt);
    const onTime = resolved.filter((c) => !c.dueAt || c.resolvedAt <= c.dueAt).length;

    results.push({
      id: ward.id,
      name: ward.name,
      code: ward.code,
      zone: ward.zone,
      center: { latitude: ward.centerLat, longitude: ward.centerLng },
      boundary: ward.boundary,
      population: ward.population,
      openComplaints: open,
      reported7d: recent.length,
      resolved7d: resolved.length,
      emergencies7d: recent.filter((c) => c.isEmergency).length,
      critical: recent.filter((c) => c.severity === 'CRITICAL').length,
      slaCompliancePct: resolved.length ? Math.round((onTime / resolved.length) * 100) : 0,
      avgResolutionMinutes: Math.round(avg(resolved.map((c) => (c.resolvedAt - c.createdAt) / 60_000))),
      vehicles,
      officers: officersByWard.get(ward.id) ?? [],
      /** 0-100 pressure score — drives the heatmap colour ramp. */
      load: Math.min(100, Math.round(open * 6 + recent.filter((c) => c.isEmergency).length * 12)),
    });
  }
  return results;
}

/**
 * Fuel and expenditure.
 *
 * Fuel logs carry a driver and a vehicle but no ward of their own, so ward
 * scoping has to go through the vehicle. The officer analytics endpoint used
 * to query fuelLog with no scope at all, which quietly showed a ward officer
 * the whole city's spend.
 *
 * Cost is only ever summed from what was actually logged. Where a driver
 * recorded litres but left the cost blank we report the litres and say how
 * many entries had no cost, rather than multiplying by an assumed price and
 * presenting the guess as spend.
 */
export async function fuelAndExpenditure(wardIds, days = 30) {
  const since = startOfDay(days - 1);

  const vehicles = await prisma.vehicle.findMany({
    where: wardIds === null ? {} : { wardId: { in: wardIds } },
    select: {
      id: true,
      registrationNumber: true,
      model: true,
      wardId: true,
      ward: { select: { id: true, name: true, code: true } },
      driver: { select: { id: true, name: true } },
    },
  });
  const vehicleIds = vehicles.map((v) => v.id);
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

  const [logs, routes] = await Promise.all([
    prisma.fuelLog.findMany({
      where: { vehicleId: { in: vehicleIds }, loggedAt: { gte: since } },
      orderBy: { loggedAt: 'desc' },
      select: {
        id: true, vehicleId: true, driverId: true, liters: true, cost: true,
        odometerKm: true, notes: true, receiptUrl: true, loggedAt: true,
      },
    }),
    // Distance actually driven, so cost-per-km is a real ratio rather than
    // fuel volume divided by a planned figure nobody drove.
    prisma.route.findMany({
      where: { vehicleId: { in: vehicleIds }, date: { gte: dayKey(since) } },
      select: { vehicleId: true, distanceKm: true, actualKm: true, date: true },
    }),
  ]);

  const litres = logs.reduce((n, l) => n + (l.liters ?? 0), 0);
  const cost = logs.reduce((n, l) => n + (l.cost ?? 0), 0);
  const missingCost = logs.filter((l) => l.liters != null && l.cost == null).length;
  const km = routes.reduce((n, r) => n + (r.actualKm || r.distanceKm || 0), 0);

  // Per-day series for the trend chart.
  const byDay = new Map();
  for (const l of logs) {
    const key = dayKey(l.loggedAt);
    const row = byDay.get(key) ?? { date: key, litres: 0, cost: 0, entries: 0 };
    row.litres += l.liters ?? 0;
    row.cost += l.cost ?? 0;
    row.entries += 1;
    byDay.set(key, row);
  }
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(startOfDay(i));
    const row = byDay.get(key);
    series.push({
      date: key,
      litres: Number((row?.litres ?? 0).toFixed(1)),
      cost: Number((row?.cost ?? 0).toFixed(0)),
      entries: row?.entries ?? 0,
    });
  }

  // Per-vehicle and per-ward rollups.
  const kmByVehicle = new Map();
  for (const r of routes) {
    kmByVehicle.set(r.vehicleId, (kmByVehicle.get(r.vehicleId) ?? 0) + (r.actualKm || r.distanceKm || 0));
  }

  const perVehicle = [];
  const wardAgg = new Map();
  for (const v of vehicles) {
    const mine = logs.filter((l) => l.vehicleId === v.id);
    if (!mine.length && !kmByVehicle.get(v.id)) continue;

    const vLitres = mine.reduce((n, l) => n + (l.liters ?? 0), 0);
    const vCost = mine.reduce((n, l) => n + (l.cost ?? 0), 0);
    const vKm = kmByVehicle.get(v.id) ?? 0;

    perVehicle.push({
      vehicleId: v.id,
      registrationNumber: v.registrationNumber,
      model: v.model,
      ward: v.ward,
      driver: v.driver,
      litres: Number(vLitres.toFixed(1)),
      cost: Number(vCost.toFixed(0)),
      km: Number(vKm.toFixed(1)),
      entries: mine.length,
      // Null rather than 0 when there is nothing to divide by: "0 km/l" reads
      // as a catastrophically thirsty truck, not as "no data yet".
      kmPerLitre: vLitres > 0 && vKm > 0 ? Number((vKm / vLitres).toFixed(2)) : null,
      costPerKm: vKm > 0 && vCost > 0 ? Number((vCost / vKm).toFixed(2)) : null,
    });

    if (v.ward) {
      const w = wardAgg.get(v.ward.id) ?? { ward: v.ward, litres: 0, cost: 0, km: 0, vehicles: 0 };
      w.litres += vLitres;
      w.cost += vCost;
      w.km += vKm;
      w.vehicles += 1;
      wardAgg.set(v.ward.id, w);
    }
  }

  perVehicle.sort((a, b) => b.cost - a.cost || b.litres - a.litres);

  const perWard = [...wardAgg.values()]
    .map((w) => ({
      ward: w.ward,
      vehicles: w.vehicles,
      litres: Number(w.litres.toFixed(1)),
      cost: Number(w.cost.toFixed(0)),
      km: Number(w.km.toFixed(1)),
      kmPerLitre: w.litres > 0 && w.km > 0 ? Number((w.km / w.litres).toFixed(2)) : null,
      costPerKm: w.km > 0 && w.cost > 0 ? Number((w.cost / w.km).toFixed(2)) : null,
    }))
    .sort((a, b) => b.cost - a.cost);

  const reporting = new Set(logs.map((l) => l.vehicleId)).size;

  return {
    days,
    since,
    totals: {
      litres: Number(litres.toFixed(1)),
      cost: Number(cost.toFixed(0)),
      km: Number(km.toFixed(1)),
      entries: logs.length,
      vehiclesReporting: reporting,
      fleetSize: vehicles.length,
      kmPerLitre: litres > 0 && km > 0 ? Number((km / litres).toFixed(2)) : null,
      costPerKm: km > 0 && cost > 0 ? Number((cost / km).toFixed(2)) : null,
      avgCostPerDay: Number((cost / days).toFixed(0)),
    },
    /** Stated so a reader can tell "cheap month" from "half the crew forgot to log". */
    coverage: {
      entriesMissingCost: missingCost,
      vehiclesWithNoEntries: vehicles.length - reporting,
    },
    series,
    perVehicle,
    perWard,
    recent: logs.slice(0, 20).map((l) => ({
      ...l,
      vehicle: vehicleById.get(l.vehicleId)
        ? {
            id: l.vehicleId,
            registrationNumber: vehicleById.get(l.vehicleId).registrationNumber,
            ward: vehicleById.get(l.vehicleId).ward,
          }
        : null,
    })),
  };
}

/**
 * SLA resolution analytics.
 *
 * Compliance is measured only over complaints that have actually been
 * resolved *and* carried a due date. Counting still-open work as compliant
 * would make a ward that never closes anything look perfect, so open breaches
 * are reported as their own number instead of being folded into the rate.
 */
export async function slaPerformance(wardIds, days = 30) {
  const since = startOfDay(days - 1);
  const scope = wardScope(wardIds);

  const [resolved, openOverdue, wards] = await Promise.all([
    prisma.complaint.findMany({
      where: { ...scope, resolvedAt: { gte: since } },
      select: {
        id: true, code: true, wardId: true, category: true, severity: true,
        isEmergency: true, createdAt: true, resolvedAt: true, dueAt: true, slaMinutes: true,
      },
    }),
    prisma.complaint.findMany({
      where: { ...scope, status: { notIn: ['RESOLVED', 'REJECTED'] }, dueAt: { lt: new Date() } },
      select: { id: true, code: true, wardId: true, category: true, isEmergency: true, dueAt: true, createdAt: true },
    }),
    prisma.ward.findMany({
      where: wardIds === null ? {} : { id: { in: wardIds } },
      select: { id: true, name: true, code: true },
      orderBy: { code: 'asc' },
    }),
  ]);

  const measurable = resolved.filter((c) => c.dueAt);
  const onTime = (c) => c.resolvedAt <= c.dueAt;
  const minutes = (c) => (c.resolvedAt - c.createdAt) / 60_000;
  const rate = (rows) => (rows.length ? Math.round((rows.filter(onTime).length / rows.length) * 100) : null);

  // Daily compliance trend.
  const byDay = new Map();
  for (const c of measurable) {
    const key = dayKey(c.resolvedAt);
    const row = byDay.get(key) ?? { date: key, resolved: 0, onTime: 0 };
    row.resolved += 1;
    if (onTime(c)) row.onTime += 1;
    byDay.set(key, row);
  }
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(startOfDay(i));
    const row = byDay.get(key);
    series.push({
      date: key,
      resolved: row?.resolved ?? 0,
      onTime: row?.onTime ?? 0,
      // null, not 0: a day with nothing resolved has no compliance rate, and
      // plotting it as 0% draws a cliff that never happened.
      compliancePct: row?.resolved ? Math.round((row.onTime / row.resolved) * 100) : null,
    });
  }

  const byCategory = [...new Set(measurable.map((c) => c.category))]
    .map((category) => {
      const rows = measurable.filter((c) => c.category === category);
      const target = CATEGORY_MAP[category]?.slaMinutes ?? null;
      return {
        category,
        label: CATEGORY_MAP[category]?.label ?? category,
        resolved: rows.length,
        breached: rows.filter((c) => !onTime(c)).length,
        compliancePct: rate(rows),
        targetMinutes: target,
        avgResolutionMinutes: Math.round(avg(rows.map(minutes))),
      };
    })
    .sort((a, b) => (a.compliancePct ?? 101) - (b.compliancePct ?? 101));

  const byWard = wards.map((ward) => {
    const rows = measurable.filter((c) => c.wardId === ward.id);
    return {
      ward,
      resolved: rows.length,
      breached: rows.filter((c) => !onTime(c)).length,
      compliancePct: rate(rows),
      avgResolutionMinutes: Math.round(avg(rows.map(minutes))),
      openBreaches: openOverdue.filter((c) => c.wardId === ward.id).length,
    };
  });

  const emergencyRows = measurable.filter((c) => c.isEmergency);
  const routineRows = measurable.filter((c) => !c.isEmergency);

  return {
    days,
    since,
    totals: {
      resolved: resolved.length,
      measurable: measurable.length,
      /** Resolved without a due date - excluded from the rate, and said so. */
      unmeasurable: resolved.length - measurable.length,
      breached: measurable.filter((c) => !onTime(c)).length,
      compliancePct: rate(measurable),
      avgResolutionMinutes: Math.round(avg(measurable.map(minutes))),
      medianResolutionMinutes: median(measurable.map(minutes)),
      openBreaches: openOverdue.length,
      emergencyCompliancePct: rate(emergencyRows),
      routineCompliancePct: rate(routineRows),
    },
    series,
    byCategory,
    byWard,
    worstOpen: openOverdue
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
      .slice(0, 15)
      .map((c) => ({
        ...c,
        minutesOverdue: Math.round((Date.now() - new Date(c.dueAt).getTime()) / 60_000),
      })),
  };
}

/** Median resists the long tail a handful of week-old tickets puts on the mean. */
function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** Complaint points for the officer heatmap, already filtered to their scope. */
export async function heatmapPoints(wardIds, { days = 14, status } = {}) {
  const complaints = await prisma.complaint.findMany({
    where: {
      ...wardScope(wardIds),
      createdAt: { gte: startOfDay(days - 1) },
      ...(status ? { status } : {}),
      duplicateOfId: null,
    },
    select: {
      id: true,
      code: true,
      latitude: true,
      longitude: true,
      category: true,
      severity: true,
      status: true,
      isEmergency: true,
      upvotes: true,
      createdAt: true,
    },
    take: 2000,
  });

  return complaints.map((c) => ({
    ...c,
    // Weight duplicates up: five people reporting one pile matters more.
    weight: (c.isEmergency ? 3 : 1) + Math.min(4, c.upvotes),
  }));
}

/**
 * Hotspot forecast. Aggregates real history and hands it to the model service;
 * if that is down, a seasonal-naive baseline computed here still produces a
 * usable forecast rather than an empty panel.
 */
export async function hotspotForecast(wardIds, forDate) {
  const target = forDate || dayKey(startOfDay(-1));
  const wards = await prisma.ward.findMany({ where: wardIds === null ? {} : { id: { in: wardIds } } });

  const history = await prisma.complaint.findMany({
    where: { ...wardScope(wardIds), createdAt: { gte: startOfDay(60) } },
    select: { wardId: true, createdAt: true, category: true, isEmergency: true },
  });

  const series = wards.map((w) => ({
    wardId: w.id,
    name: w.name,
    counts: bucketByDay(history.filter((h) => h.wardId === w.id)),
  }));

  const remote = await predictHotspots({ forDate: target, series });
  if (!remote.degraded && remote.predictions?.length) {
    await persistPredictions(remote.predictions, target, remote.modelVersion);
    return { forDate: target, modelVersion: remote.modelVersion, source: 'ai-service', predictions: remote.predictions };
  }

  const predictions = series.map((s) => baselineForecast(s, target));
  await persistPredictions(predictions, target, 'baseline-seasonal-v1');
  return {
    forDate: target,
    modelVersion: 'baseline-seasonal-v1',
    source: 'api-fallback',
    note: 'Model service unavailable — seasonal baseline used.',
    predictions,
  };
}

function bucketByDay(rows) {
  const counts = {};
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Seasonal-naive with recency weighting: the same weekday over recent weeks,
 * weighted so last week counts more than five weeks ago. A real baseline, not
 * a random number — and it is labelled as a baseline in the response.
 */
function baselineForecast(series, forDate) {
  const targetWeekday = new Date(forDate).getDay();
  const samples = [];

  for (const [date, count] of Object.entries(series.counts)) {
    const d = new Date(date);
    if (d.getDay() !== targetWeekday) continue;
    const ageWeeks = (Date.now() - d.getTime()) / (7 * 864e5);
    samples.push({ count, weight: Math.exp(-ageWeeks / 3) });
  }

  const totalWeight = samples.reduce((a, s) => a + s.weight, 0);
  const predicted = totalWeight ? samples.reduce((a, s) => a + s.count * s.weight, 0) / totalWeight : 0;

  const allCounts = Object.values(series.counts);
  const mean = avg(allCounts);
  const risk = Math.min(100, Math.round((predicted / Math.max(1, mean || 1)) * 45 + Math.min(predicted, 12) * 4));

  return {
    wardId: series.wardId,
    name: series.name,
    predictedCount: Number(predicted.toFixed(1)),
    riskScore: risk,
    confidence: samples.length >= 4 ? 0.62 : samples.length >= 2 ? 0.4 : 0.2,
    drivers: [
      { feature: 'same_weekday_history', value: Number(predicted.toFixed(1)) },
      { feature: 'ward_daily_mean', value: Number(mean.toFixed(1)) },
      { feature: 'samples', value: samples.length },
    ],
  };
}

async function persistPredictions(predictions, forDate, modelVersion) {
  for (const p of predictions) {
    if (!p.wardId) continue;
    await prisma.hotspotPrediction.upsert({
      where: { wardId_forDate: { wardId: p.wardId, forDate } },
      create: {
        wardId: p.wardId,
        forDate,
        predictedCount: p.predictedCount,
        riskScore: p.riskScore,
        confidence: p.confidence ?? 0,
        drivers: p.drivers ?? undefined,
        modelVersion,
      },
      update: {
        predictedCount: p.predictedCount,
        riskScore: p.riskScore,
        confidence: p.confidence ?? 0,
        drivers: p.drivers ?? undefined,
        modelVersion,
      },
    });
  }
}

/** AI model health panel (plan §2.4). */
export async function modelHealth(days = 14) {
  const since = startOfDay(days - 1);
  const rows = await prisma.complaint.findMany({
    where: { createdAt: { gte: since }, aiCategory: { not: null } },
    select: { aiConfidence: true, reviewNeeded: true, status: true, category: true, aiCategory: true, createdAt: true },
  });

  const byDay = {};
  for (const r of rows) {
    const key = dayKey(r.createdAt);
    byDay[key] = byDay[key] || { date: key, confidences: [], lowConfidence: 0, rejected: 0, agreed: 0, total: 0 };
    byDay[key].confidences.push(r.aiConfidence);
    byDay[key].total += 1;
    if (r.reviewNeeded) byDay[key].lowConfidence += 1;
    if (r.status === 'REJECTED') byDay[key].rejected += 1;
    if (r.category === r.aiCategory) byDay[key].agreed += 1;
  }

  const daily = Object.values(byDay)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      samples: d.total,
      avgConfidence: Number(avg(d.confidences).toFixed(3)),
      lowConfidenceRate: Number((d.lowConfidence / d.total).toFixed(3)),
      humanAgreementRate: Number((d.agreed / d.total).toFixed(3)),
      rejectedRate: Number((d.rejected / d.total).toFixed(3)),
    }));

  return {
    windowDays: days,
    samples: rows.length,
    avgConfidence: Number(avg(rows.map((r) => r.aiConfidence)).toFixed(3)),
    lowConfidenceRate: rows.length ? Number((rows.filter((r) => r.reviewNeeded).length / rows.length).toFixed(3)) : 0,
    humanAgreementRate: rows.length
      ? Number((rows.filter((r) => r.category === r.aiCategory).length / rows.length).toFixed(3))
      : 0,
    daily,
    retrainingSuggested: daily.slice(-3).every((d) => d.lowConfidenceRate > 0.4),
  };
}

/**
 * Per-model breakdown for the admin Model Health screen. Every number here is
 * read straight off real rows (Complaint / Route / HotspotPrediction) or the
 * live AI microservice reachability check — nothing hard-coded, so a model
 * that is actually degraded shows up as degraded instead of a blanket
 * "ACTIVE" badge.
 */
export async function perModelHealth(days = 14, visionReachable = false) {
  const since = startOfDay(days - 1);

  const [hotspots, routes] = await Promise.all([
    prisma.hotspotPrediction.findMany({
      where: { createdAt: { gte: since } },
      select: { confidence: true, riskScore: true, createdAt: true },
    }),
    prisma.route.findMany({
      where: { createdAt: { gte: since } },
      select: { savedKm: true, distanceKm: true, baselineKm: true, solveMs: true, co2SavedKg: true, createdAt: true },
    }),
  ]);

  const byDayCount = (rows) => {
    const byDay = {};
    for (const r of rows) {
      const key = dayKey(r.createdAt);
      byDay[key] = (byDay[key] || 0) + 1;
    }
    return Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  };

  return {
    visionClassifier: {
      // Shares the FastAPI vision microservice, so its live reachability is the classifier's real status.
      reachable: visionReachable,
      status: visionReachable ? 'ACTIVE' : 'FALLBACK',
      calibration: CALIBRATION.classifier,
    },
    hotspotEngine: {
      // Same microservice boundary as the classifier — degrades together.
      reachable: visionReachable,
      status: visionReachable ? 'ACTIVE' : 'FALLBACK',
      predictions: hotspots.length,
      avgConfidence: Number(avg(hotspots.map((h) => h.confidence)).toFixed(3)),
      avgRiskScore: Number(avg(hotspots.map((h) => h.riskScore)).toFixed(1)),
      lastGeneratedAt: hotspots.length ? hotspots.reduce((m, h) => (h.createdAt > m ? h.createdAt : m), hotspots[0].createdAt) : null,
      daily: byDayCount(hotspots),
      calibration: CALIBRATION.hotspot,
    },
    routeSolver: {
      // Runs entirely in-process (2-opt/Or-opt over Node), no external dependency to degrade.
      reachable: true,
      status: 'ACTIVE',
      routesGenerated: routes.length,
      avgSavedKm: Number(avg(routes.map((r) => r.savedKm)).toFixed(2)),
      avgSolveMs: Number(avg(routes.map((r) => r.solveMs)).toFixed(0)),
      totalCo2SavedKg: Number(routes.reduce((s, r) => s + (r.co2SavedKg || 0), 0).toFixed(1)),
      daily: byDayCount(routes),
      calibration: CALIBRATION.tsp,
    },
    whatIfSimulator: {
      // Pure local heuristic (officer.routes.js /simulate) — cannot go down independently of the API itself.
      reachable: true,
      status: 'ACTIVE',
      calibration: CALIBRATION.whatif,
    },
    chatbot: {
      // Always answers (LLM when GROQ_API_KEY is set, deterministic rule-based reply otherwise) — engine varies, never down.
      reachable: true,
      status: 'ACTIVE',
      engine: env.groq.apiKey ? 'groq-llm' : 'rule-based-fallback',
      calibration: CALIBRATION.nlp,
    },
  };
}

export { startOfDay, dayKey, median };
export default {
  overview,
  statusBreakdown,
  categoryBreakdown,
  trends,
  wardPerformance,
  heatmapPoints,
  hotspotForecast,
  modelHealth,
  perModelHealth,
  fuelAndExpenditure,
  slaPerformance,
};
