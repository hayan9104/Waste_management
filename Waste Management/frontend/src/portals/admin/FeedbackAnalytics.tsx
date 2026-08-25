import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Star, MessageSquare, TrendingUp, Filter, CheckCircle2, AlertCircle, Sparkles, RefreshCw } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { api, errorMessage } from '../../lib/api';
import { Card, Badge, toast } from '../../components/ui';

const RATING_COLORS = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];
const PIE_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899'];

export default function FeedbackAnalytics() {
  const queryClient = useQueryClient();
  const [selectedWard, setSelectedWard] = useState<string>('');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['admin-feedback-analytics', selectedWard],
    queryFn: async () => {
      const params = selectedWard ? { wardId: selectedWard } : {};
      const res = await api('admin').get('/admin/feedback/analytics', { params });
      return res.data;
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) =>
      api('admin').patch(`/admin/feedback/${id}/status`, { status }),
    onSuccess: () => {
      toast.success('Feedback status updated');
      queryClient.invalidateQueries({ queryKey: ['admin-feedback-analytics'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const distributionData = [1, 2, 3, 4, 5].map((star) => ({
    name: `${star} ⭐`,
    count: data?.distribution?.[star] || 0,
  }));

  const categoryData = Object.entries(data?.categories || {}).map(([cat, count]) => ({
    name: cat.replace(/_/g, ' '),
    value: count as number,
  }));

  return (
    <div className="space-y-6 pb-16">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-fluid-2xl font-extrabold text-ink">Citizen Feedback & Quality Analytics</h1>
          <p className="text-fluid-xs text-muted">Real-time citizen ratings, sentiment telemetry, and complaint satisfaction scores.</p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="btn-secondary py-2 px-3 text-fluid-xs font-semibold self-start sm:self-auto flex items-center gap-2"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Refresh Data</span>
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 border border-line space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted">Average Rating</span>
          <div className="flex items-center gap-2">
            <span className="text-fluid-2xl font-black text-ink">{data?.avgRating || '0.0'}</span>
            <div className="flex text-amber-400">
              <Star className="h-5 w-5 fill-current" />
            </div>
          </div>
          <p className="text-[11px] text-muted">Out of 5.0 stars total</p>
        </Card>

        <Card className="p-4 border border-line space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted">Total Reviews</span>
          <div className="flex items-center gap-2">
            <span className="text-fluid-2xl font-black text-ink">{data?.total || 0}</span>
            <MessageSquare className="h-5 w-5 text-brand" />
          </div>
          <p className="text-[11px] text-muted">Citizen reviews recorded</p>
        </Card>

        <Card className="p-4 border border-line space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted">Positive Sentiment</span>
          <div className="flex items-center gap-2">
            <span className="text-fluid-2xl font-black text-emerald-600">
              {data?.total ? Math.round(((data.sentiments?.POSITIVE || 0) / data.total) * 100) : 0}%
            </span>
            <Sparkles className="h-5 w-5 text-emerald-500" />
          </div>
          <p className="text-[11px] text-muted">{data?.sentiments?.POSITIVE || 0} positive remarks</p>
        </Card>

        <Card className="p-4 border border-line space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted">Negative Alerts</span>
          <div className="flex items-center gap-2">
            <span className="text-fluid-2xl font-black text-rose-600">
              {data?.sentiments?.NEGATIVE || 0}
            </span>
            <AlertCircle className="h-5 w-5 text-rose-500" />
          </div>
          <p className="text-[11px] text-muted">Low ratings requiring officer review</p>
        </Card>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Rating Distribution Bar Chart */}
        <Card className="p-5 border border-line space-y-4">
          <h3 className="text-fluid-sm font-bold text-ink">Star Rating Distribution</h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={distributionData} layout="vertical" margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
                <XAxis type="number" allowDecimals={false} />
                <YAxis dataKey="name" type="category" width={50} />
                <Tooltip />
                <Bar dataKey="count" fill="#15803d" radius={[0, 8, 8, 0]}>
                  {distributionData.map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={RATING_COLORS[index]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Category Breakdown Donut Chart */}
        <Card className="p-5 border border-line space-y-4">
          <h3 className="text-fluid-sm font-bold text-ink">Feedback by Category</h3>
          <div className="h-64 w-full flex items-center justify-center">
            {categoryData.length === 0 ? (
              <p className="text-fluid-xs text-muted">No category data available yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={categoryData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={85}
                    paddingAngle={3}
                    dataKey="value"
                    label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                  >
                    {categoryData.map((_entry, index) => (
                      <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </div>

      {/* Moderation Table */}
      <Card className="p-5 border border-line space-y-4">
        <h3 className="text-fluid-sm font-bold text-ink">Recent Citizen Reviews & Moderation</h3>
        
        {isLoading ? (
          <p className="text-fluid-xs text-muted">Loading reviews…</p>
        ) : !data?.recentFeedback || data.recentFeedback.length === 0 ? (
          <p className="text-fluid-xs text-muted">No feedback recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-fluid-xs">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="pb-3 font-semibold">Citizen</th>
                  <th className="pb-3 font-semibold">Rating</th>
                  <th className="pb-3 font-semibold">Category</th>
                  <th className="pb-3 font-semibold">Comment</th>
                  <th className="pb-3 font-semibold">Ticket</th>
                  <th className="pb-3 font-semibold">Status</th>
                  <th className="pb-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.recentFeedback.map((f: any) => (
                  <tr key={f.id} className="hover:bg-sunken/40">
                    <td className="py-3 font-medium text-ink">{f.citizen?.name || 'Anonymous'}</td>
                    <td className="py-3">
                      <div className="flex text-amber-400">
                        {Array.from({ length: f.rating }).map((_, i) => (
                          <Star key={i} className="h-3.5 w-3.5 fill-current" />
                        ))}
                      </div>
                    </td>
                    <td className="py-3 text-muted">{f.category.replace(/_/g, ' ')}</td>
                    <td className="py-3 max-w-xs truncate text-ink font-normal">
                      {f.comment ? `"${f.comment}"` : <span className="text-muted italic">No comment</span>}
                    </td>
                    <td className="py-3 font-mono text-muted">
                      {f.complaint ? `#${f.complaint.code}` : '—'}
                    </td>
                    <td className="py-3">
                      <Badge tone={f.status === 'RESOLVED' ? 'ok' : f.status === 'REVIEWED' ? 'warn' : 'neutral'}>
                        {f.status}
                      </Badge>
                    </td>
                    <td className="py-3 text-right">
                      {f.status !== 'RESOLVED' && (
                        <button
                          type="button"
                          onClick={() => statusMutation.mutate({ id: f.id, status: f.status === 'NEW' ? 'REVIEWED' : 'RESOLVED' })}
                          className="btn-secondary py-1 px-2 text-[10px] font-bold"
                        >
                          {f.status === 'NEW' ? 'Mark Reviewed' : 'Mark Resolved'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
