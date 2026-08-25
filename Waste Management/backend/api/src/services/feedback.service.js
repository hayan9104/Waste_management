import { prisma } from '../lib/prisma.js';
/**
 * The realtime gateway lives at sockets/realtime.js and exports `getIO`.
 *
 * This imported `getIo` from `../realtime/gateway.js`, a path that exists
 * nowhere in the repo, so the API refused to boot at all — every portal was
 * down, not just feedback. The `try` below would have swallowed a wrong-name
 * export, but an unresolvable module fails at import time, before any handler
 * runs.
 */
import { getIO } from '../sockets/realtime.js';

export async function submitFeedback({ citizenId, complaintId, rating, category, comment }) {
  let sentiment = 'NEUTRAL';
  if (comment) {
    const text = comment.toLowerCase();
    if (rating >= 4 || text.includes('good') || text.includes('great') || text.includes('fast') || text.includes('clean') || text.includes('helpful')) {
      sentiment = 'POSITIVE';
    } else if (rating <= 2 || text.includes('bad') || text.includes('slow') || text.includes('dirty') || text.includes('worst') || text.includes('poor')) {
      sentiment = 'NEGATIVE';
    }
  } else {
    sentiment = rating >= 4 ? 'POSITIVE' : rating <= 2 ? 'NEGATIVE' : 'NEUTRAL';
  }

  const feedback = await prisma.feedback.create({
    data: {
      citizenId,
      complaintId: complaintId || null,
      rating: Math.min(5, Math.max(1, Number(rating))),
      category: category || 'SERVICE_QUALITY',
      comment: comment?.trim() || null,
      sentiment,
      status: 'NEW',
    },
    include: {
      citizen: { select: { id: true, name: true, phone: true } },
      complaint: { select: { id: true, code: true, category: true, wardId: true } },
    },
  });

  // Emit realtime notification to Admin & Officers
  try {
    const io = getIO();
    io.emit('feedback:submitted', {
      id: feedback.id,
      rating: feedback.rating,
      category: feedback.category,
      sentiment: feedback.sentiment,
      citizenName: feedback.citizen.name,
      complaintCode: feedback.complaint?.code,
    });
  } catch {
    // ignore realtime error
  }

  return feedback;
}

export async function getCitizenFeedback(citizenId) {
  return prisma.feedback.findMany({
    where: { citizenId },
    orderBy: { createdAt: 'desc' },
    include: {
      complaint: { select: { id: true, code: true, category: true } },
    },
  });
}

export async function getFeedbackAnalytics({ wardId, from, to } = {}) {
  const where = {};
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (wardId) {
    where.complaint = { wardId };
  }

  const feedbacks = await prisma.feedback.findMany({
    where,
    include: {
      citizen: { select: { id: true, name: true } },
      complaint: { select: { id: true, code: true, wardId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const total = feedbacks.length;
  const avgRating = total > 0 ? Number((feedbacks.reduce((sum, f) => sum + f.rating, 0) / total).toFixed(1)) : 0;

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const categories = {};
  const sentiments = { POSITIVE: 0, NEUTRAL: 0, NEGATIVE: 0 };

  feedbacks.forEach((f) => {
    distribution[f.rating] = (distribution[f.rating] || 0) + 1;
    categories[f.category] = (categories[f.category] || 0) + 1;
    if (f.sentiment) sentiments[f.sentiment] = (sentiments[f.sentiment] || 0) + 1;
  });

  return {
    total,
    avgRating,
    distribution,
    categories,
    sentiments,
    recentFeedback: feedbacks.slice(0, 30),
  };
}

export async function updateFeedbackStatus(id, status) {
  return prisma.feedback.update({
    where: { id },
    data: { status },
  });
}
