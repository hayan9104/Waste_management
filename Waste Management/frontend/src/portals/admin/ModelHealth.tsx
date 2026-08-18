import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Activity,
  CheckCircle2,
  Brain,
  MapPin,
  Route as RouteIcon,
  Bot,
  Zap,
  ShieldCheck,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from 'recharts';
import { api } from '../../lib/api';
import { Badge, Card, ErrorState, Loading, SectionTitle, Stat, type Tone } from '../../components/ui';
import { pct } from '../../lib/format';

type DailyCount = { date: string; count: number };

type ModelHealthResponse = {
  windowDays: number;
  samples: number;
  avgConfidence: number;
  lowConfidenceRate: number;
  humanAgreementRate: number;
  retrainingSuggested: boolean;
  daily: Array<{ date: string; avgConfidence: number; humanAgreementRate: number; lowConfidenceRate: number }>;
  service: { reachable: boolean; url?: string; status?: string };
  models: {
    visionClassifier: { reachable: boolean; status: string };
    hotspotEngine: {
      reachable: boolean;
      status: string;
      predictions: number;
      avgConfidence: number;
      avgRiskScore: number;
      lastGeneratedAt: string | null;
      daily: DailyCount[];
    };
    routeSolver: {
      reachable: boolean;
      status: string;
      routesGenerated: number;
      avgSavedKm: number;
      avgSolveMs: number;
      totalCo2SavedKg: number;
      daily: DailyCount[];
    };
    whatIfSimulator: { reachable: boolean; status: string };
    chatbot: { reachable: boolean; status: string; engine: string };
  };
};

/** Static descriptive metadata — the parts that don't change at runtime (name, algorithm, icon). */
const MODEL_META = [
  {
    key: 'visionClassifier' as const,
    name: 'YOLOv8 Custom Waste Classifier',
    type: 'Computer Vision / Deep Learning',
    algorithm: 'YOLOv8 Object Detection & Bounding Box',
    purpose: 'Real-time multi-class waste recognition from citizen photo uploads with auto-approval threshold.',
    classes: ['overflowing_bin', 'dead_animal', 'medical_waste', 'construction_debris', 'illegal_dumping', 'garbage_pile'],
    icon: Brain,
  },
  {
    key: 'hotspotEngine' as const,
    name: 'AI Spatial Hotspot Engine',
    type: 'Geospatial Forecasting',
    algorithm: 'LightGBM Gradient Boosted Trees',
    purpose: 'Predicts recurring dump sites and ward-level accumulation risk from 45-day temporal history.',
    classes: ['High Density Zone', 'Emerging Accumulation', 'Dispersed Incidents'],
    icon: MapPin,
  },
  {
    key: 'whatIfSimulator' as const,
    name: 'Predictive Ward What-If Forecaster',
    type: 'Simulation & Stochastic Modeling',
    algorithm: 'Local heuristic over live complaint velocity — no external dependency',
    purpose: 'Simulates how changing pickup frequency impacts overflow probability & forecast complaints.',
    classes: ['Overflow Probability %', 'Projected Inflow Rate', 'SLA Deficit Risk'],
    icon: Zap,
  },
  {
    key: 'routeSolver' as const,
    name: '2-Opt / Or-Opt Fleet Route Optimizer',
    type: 'Combinatorial Graph Optimization',
    algorithm: 'Nearest-Neighbour → 2-Opt → Or-Opt heuristic (safaai-node-2opt)',
    purpose: 'Generates shortest-distance collection routes, reducing municipal diesel usage & truck transit time.',
    classes: ['Sequential Turn-by-Turn', 'Saved Km Calculation', 'Dynamic Insertion'],
    icon: RouteIcon,
  },
  {
    key: 'chatbot' as const,
    name: 'AI Safaai Sahayak (NLP Assistant)',
    type: 'Multilingual Civic NLP Assistant',
    algorithm: 'Groq LLM, with a deterministic keyword-matched fallback reply',
    purpose: 'Handles civic inquiries in English, Hindi & Gujarati for waste sorting, rewards, and emergency assistance.',
    classes: ['English (EN)', 'Hindi (HI)', 'Gujarati (GU)'],
    icon: Bot,
  },
];

const confidenceTone = (v: number): Tone => (v >= 0.7 ? 'ok' : v >= 0.5 ? 'warn' : 'danger');
/** Lower is better here — this is the share flagged for human review. */
const lowRateTone = (v: number): Tone => (v <= 0.2 ? 'ok' : v <= 0.4 ? 'warn' : 'danger');
const agreementTone = (v: number): Tone => (v >= 0.8 ? 'ok' : v >= 0.6 ? 'warn' : 'danger');
const statusTone = (status: string): Tone => (status === 'ACTIVE' ? 'ok' : status === 'FALLBACK' ? 'warn' : 'danger');

/** Merges two per-day {date,count} series into one recharts-friendly dataset, keyed by date. */
function mergeDaily(a: DailyCount[] = [], b: DailyCount[] = [], keyA: string, keyB: string) {
  const byDate = new Map<string, Record<string, number | string>>();
  for (const d of a) byDate.set(d.date, { date: d.date, [keyA]: d.count });
  for (const d of b) {
    const row = byDate.get(d.date) ?? { date: d.date };
    row[keyB] = d.count;
    byDate.set(d.date, row);
  }
  return Array.from(byDate.values()).sort((x, y) => String(x.date).localeCompare(String(y.date)));
}

export default function ModelHealth() {
  const { data, isLoading, error, refetch } = useQuery<ModelHealthResponse>({
    queryKey: ['admin', 'model-health'],
    queryFn: async () => (await api('admin').get('/admin/model-health', { params: { days: 14 } })).data,
    refetchInterval: 60_000,
  });

  if (isLoading) return <Loading label="Loading AI telemetry…" />;
  if (error) return <ErrorState message="Could not load model health" onRetry={() => refetch()} />;

  const axis = { fontSize: 11, fill: 'rgb(var(--muted))' };
  const tooltipStyle = {
    background: 'rgb(var(--elevated))',
    border: '1px solid rgb(var(--line))',
    borderRadius: 12,
    fontSize: 12,
    color: 'rgb(var(--ink))',
  };

  const service = data?.service ?? { reachable: false };
  const models = data?.models;

  const avgConfidence = data?.avgConfidence ?? 0;
  const lowConfidenceRate = data?.lowConfidenceRate ?? 0;
  const humanAgreementRate = data?.humanAgreementRate ?? 0;
  const retrainingSuggested = !!data?.retrainingSuggested;
  const samples = data?.samples ?? 0;

  const statuses = models
    ? [
        models.visionClassifier.status,
        models.hotspotEngine.status,
        models.routeSolver.status,
        models.whatIfSimulator.status,
        models.chatbot.status,
      ]
    : [];
  const activeCount = statuses.filter((s) => s === 'ACTIVE').length;
  const totalCount = statuses.length;
  const allActive = totalCount > 0 && activeCount === totalCount;

  const activityData = mergeDaily(
    models?.hotspotEngine.daily,
    models?.routeSolver.daily,
    'hotspotPredictions',
    'routesGenerated'
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div>
          <h1 className="text-fluid-xl font-bold tracking-tight text-ink">AI Model Architecture & Health</h1>
          <p className="text-fluid-xs text-muted">
            Live telemetry computed from real complaint, route and hotspot rows — nothing on this page is hard-coded.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge tone={allActive ? 'ok' : 'warn'} className="text-fluid-xs font-bold py-1 px-3">
            {totalCount ? `${activeCount}/${totalCount} AI Models Active` : 'Loading…'}
          </Badge>
        </div>
      </div>

      {/* Connection Notice banner */}
      {!service.reachable && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-warn/40 bg-warn/10 p-4 text-fluid-xs text-warn shadow-xs">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold text-fluid-sm">
              Vision Service Unreachable — Deterministic Fallback Engaged (Classifier &amp; Hotspot Engine)
            </p>
            <p className="text-muted leading-relaxed">
              Configured endpoint at{' '}
              <code className="font-mono text-ink bg-sunken px-1.5 py-0.5 rounded">{service.url || '(not set)'}</code>.
              When running in cloud production, set{' '}
              <code className="font-mono text-ink bg-sunken px-1.5 py-0.5 rounded">AI_SERVICE_URL</code> to your
              deployed FastAPI Render URL (e.g.{' '}
              <code className="font-mono text-ink bg-sunken px-1.5 py-0.5 rounded">https://safaai-vision-api.onrender.com</code>
              ). Both models keep serving zero-downtime deterministic fallback logic in the meantime, but confidence
              will read lower than a live model — this is expected, not a bug.
            </p>
          </div>
        </div>
      )}

      {/* Top Metrics Row — real numbers, tone reflects the actual value, not a fixed color */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Avg Vision Confidence"
          value={pct(avgConfidence * 100)}
          hint={`${samples} complaints in the ${data?.windowDays ?? 14}-day window`}
          tone={confidenceTone(avgConfidence)}
          icon={<Activity className="h-4 w-4" />}
        />
        <Stat
          label="Low Confidence Flagged"
          value={pct(lowConfidenceRate * 100)}
          hint="Routed to Officer review"
          tone={lowRateTone(lowConfidenceRate)}
        />
        <Stat
          label="Officer Agreement"
          value={pct(humanAgreementRate * 100)}
          hint="Officer confirmed AI category"
          tone={agreementTone(humanAgreementRate)}
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <Stat
          label="Retraining Status"
          value={retrainingSuggested ? 'Suggested' : 'Model Accurate'}
          hint={retrainingSuggested ? 'Low confidence 3 days running' : undefined}
          tone={retrainingSuggested ? 'warn' : 'ok'}
          icon={<ShieldCheck className="h-4 w-4" />}
        />
      </div>

      {/* Active AI Models Suite Cards */}
      <section className="space-y-3">
        <SectionTitle
          title="Active AI Models Suite"
          subtitle="Every card's status and numbers below are read live from the database or the AI microservice's own reachability check"
        />

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {MODEL_META.map((meta) => {
            const Icon = meta.icon;
            const live = models?.[meta.key];
            const status = live?.status ?? 'LOADING';

            return (
              <Card
                key={meta.key}
                className="flex flex-col justify-between border border-line bg-surface p-5 shadow-xs hover:shadow-md transition"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
                      <Icon className="h-5 w-5" />
                    </span>
                    <Badge tone={statusTone(status)} className="font-bold">
                      {status}
                    </Badge>
                  </div>

                  <div>
                    <h3 className="text-fluid-sm font-bold text-ink">{meta.name}</h3>
                    <p className="text-[11px] font-semibold text-brand">{meta.type}</p>
                    <p className="mt-1 text-fluid-xs text-muted leading-relaxed">{meta.purpose}</p>
                  </div>

                  <div className="rounded-xl border border-line bg-sunken/40 p-2.5 space-y-1 text-[11px]">
                    <p className="text-muted">
                      Engine: <strong className="text-ink">{meta.algorithm}</strong>
                    </p>

                    {/* Real per-model telemetry — only what we actually measure, no filler numbers */}
                    {meta.key === 'hotspotEngine' && live && 'predictions' in live && (
                      <p className="text-muted">
                        {live.predictions} predictions in window · avg confidence{' '}
                        <strong className="text-ink">{pct(live.avgConfidence * 100)}</strong> · avg risk{' '}
                        <strong className="text-ink">{live.avgRiskScore}</strong>
                      </p>
                    )}
                    {meta.key === 'routeSolver' && live && 'routesGenerated' in live && (
                      <p className="text-muted">
                        {live.routesGenerated} routes solved · avg saved{' '}
                        <strong className="text-ink">{live.avgSavedKm} km</strong> · avg solve time{' '}
                        <strong className="text-ink">{live.avgSolveMs} ms</strong> ·{' '}
                        <strong className="text-ink">{live.totalCo2SavedKg} kg</strong> CO₂ saved
                      </p>
                    )}
                    {meta.key === 'chatbot' && live && 'engine' in live && (
                      <p className="text-muted">
                        Answering via{' '}
                        <strong className="text-ink">
                          {live.engine === 'groq-llm' ? 'Groq LLM' : 'rule-based fallback (no GROQ_API_KEY set)'}
                        </strong>
                      </p>
                    )}
                    {meta.key === 'visionClassifier' && (
                      <p className="text-muted">
                        {samples} classified in window · {pct(avgConfidence * 100)} avg confidence
                      </p>
                    )}
                    {meta.key === 'whatIfSimulator' && (
                      <p className="text-muted">Runs in-process on live complaint velocity — no external call to degrade.</p>
                    )}
                  </div>
                </div>

                <div className="mt-4 border-t border-line/60 pt-3">
                  <span className="block text-[10px] uppercase font-bold text-muted mb-1.5 tracking-wider">
                    Classes / Outputs:
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {meta.classes.map((cls) => (
                      <span
                        key={cls}
                        className="rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] font-medium text-ink"
                      >
                        {cls}
                      </span>
                    ))}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Vision Classifier Trend Chart */}
      <Card className="p-5 shadow-xs">
        <h3 className="mb-3 text-fluid-sm font-bold text-ink">
          Vision Classifier: Confidence &amp; Verification Trend ({data?.windowDays ?? 14} Days)
        </h3>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data?.daily ?? []} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" vertical={false} />
              <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={axis} tickLine={false} axisLine={false} width={40} domain={[0, 1]} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => `${Math.round(Number(v) * 100)}%`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="avgConfidence" name="Avg Confidence" stroke="#16a34a" strokeWidth={2} dot={false} />
              <Line
                type="monotone"
                dataKey="humanAgreementRate"
                name="Officer Agreement"
                stroke="#0ea5e9"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="lowConfidenceRate"
                name="Low Confidence"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Hotspot & Route Solver Activity Chart */}
      <Card className="p-5 shadow-xs">
        <h3 className="mb-3 text-fluid-sm font-bold text-ink">
          Hotspot Predictions &amp; Routes Solved per Day ({data?.windowDays ?? 14} Days)
        </h3>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={activityData} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" vertical={false} />
              <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={axis} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="hotspotPredictions" name="Hotspot Predictions" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
              <Bar dataKey="routesGenerated" name="Routes Solved" fill="#16a34a" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}
