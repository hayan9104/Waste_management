import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Star, Send, MessageSquare, CheckCircle, Clock, Heart, ThumbsUp, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Card, Badge, toast } from '../../components/ui';

export default function Feedback() {
  const queryClient = useQueryClient();
  const [rating, setRating] = useState(5);
  const [category, setCategory] = useState('SERVICE_QUALITY');
  const [comment, setComment] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['citizen-feedback'],
    queryFn: async () => {
      const res = await api('citizen').get('/citizen/feedback');
      return res.data.feedback;
    },
  });

  const mutation = useMutation({
    mutationFn: async () =>
      api('citizen').post('/citizen/feedback', { rating, category, comment }),
    onSuccess: () => {
      toast.success('Thank you! Your feedback has been submitted to the municipal control team.');
      setComment('');
      queryClient.invalidateQueries({ queryKey: ['citizen-feedback'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-16">
      <div>
        <h1 className="text-fluid-2xl font-extrabold text-ink">Citizen Feedback & Ratings</h1>
        <p className="text-fluid-xs text-muted">Help us maintain clean, fast and transparent sanitation services across Gandhinagar.</p>
      </div>

      <Card className="p-5 sm:p-6 border border-line space-y-5 shadow-sm rounded-3xl">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-brand/10 text-brand">
            <Heart className="h-5 w-5 fill-current" />
          </span>
          <div>
            <h2 className="text-fluid-base font-bold text-ink">Rate Municipal Sanitation Service</h2>
            <p className="text-fluid-xs text-muted">Your genuine reviews directly affect driver ratings and SLA monitoring.</p>
          </div>
        </div>
        
        {/* Star Rating */}
        <div className="space-y-1.5 pt-1">
          <label className="text-fluid-xs font-bold text-ink block">Overall Satisfaction (1 to 5 Stars)</label>
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRating(star)}
                className="p-1 text-2xl transition hover:scale-115 cursor-pointer focus:outline-none"
              >
                <Star
                  className={`h-8 w-8 transition-colors ${
                    star <= rating ? 'fill-amber-400 text-amber-400' : 'text-line'
                  }`}
                />
              </button>
            ))}
            <span className="ml-2 text-fluid-xs font-bold text-amber-600 dark:text-amber-400">
              {rating === 5 ? 'Excellent ⭐⭐⭐⭐⭐' : rating === 4 ? 'Very Good ⭐⭐⭐⭐' : rating === 3 ? 'Average ⭐⭐⭐' : rating === 2 ? 'Needs Improvement ⭐⭐' : 'Poor ⭐'}
            </span>
          </div>
        </div>

        {/* Category */}
        <div className="space-y-1.5">
          <label className="text-fluid-xs font-bold text-ink block">Feedback Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="field w-full text-fluid-xs font-medium"
          >
            <option value="SERVICE_QUALITY">Service Quality & Site Cleanliness</option>
            <option value="RESPONSE_TIME">Response Time & SLA Speed</option>
            <option value="STAFF_BEHAVIOR">Staff & Driver Conduct</option>
            <option value="APP_EXPERIENCE">Mobile App & Realtime Tracking Experience</option>
            <option value="OTHER">Other Suggestions & Ideas</option>
          </select>
        </div>

        {/* Comment */}
        <div className="space-y-1.5">
          <label className="text-fluid-xs font-bold text-ink block">Comments, Compliments or Suggestions</label>
          <textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="e.g. The garbage was cleared within 30 minutes, staff was courteous and clean…"
            className="field w-full text-fluid-xs"
            maxLength={1000}
          />
        </div>

        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="btn-primary py-3 px-6 text-fluid-xs font-bold flex items-center justify-center gap-2 shadow-md shadow-brand/20 cursor-pointer"
        >
          <Send className="h-4 w-4" />
          <span>{mutation.isPending ? 'Submitting Feedback…' : 'Submit Review'}</span>
        </button>
      </Card>

      {/* History */}
      <div className="space-y-3 pt-2">
        <h3 className="text-fluid-sm font-bold text-ink flex items-center gap-2">
          <Clock className="h-4 w-4 text-brand" />
          <span>Your Submitted Feedback History</span>
        </h3>
        {isLoading ? (
          <p className="text-fluid-xs text-muted">Loading your feedback history…</p>
        ) : !data || data.length === 0 ? (
          <Card className="p-6 text-center text-fluid-xs text-muted border border-line">
            No feedback submitted yet. Your submitted ratings will show up here.
          </Card>
        ) : (
          <div className="space-y-2.5">
            {data.map((f: any) => (
              <Card key={f.id} className="p-4 border border-line flex items-start justify-between gap-4 rounded-2xl">
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="flex text-amber-400">
                      {Array.from({ length: f.rating }).map((_, i) => (
                        <Star key={i} className="h-4 w-4 fill-current" />
                      ))}
                    </div>
                    <span className="text-fluid-xs font-bold text-ink">
                      {f.category.replace(/_/g, ' ')}
                    </span>
                    {f.complaint && (
                      <span className="font-mono text-[11px] text-muted">
                        (#{f.complaint.code})
                      </span>
                    )}
                  </div>
                  {f.comment && <p className="text-fluid-xs text-muted leading-relaxed">"{f.comment}"</p>}
                </div>
                <Badge tone={f.status === 'RESOLVED' ? 'ok' : f.status === 'REVIEWED' ? 'warn' : 'neutral'}>
                  {f.status}
                </Badge>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
