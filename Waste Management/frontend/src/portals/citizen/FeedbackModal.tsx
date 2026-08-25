import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Star, Send, X, CheckCircle, Sparkles } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Badge, toast } from '../../components/ui';

interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
  complaintId?: string;
  complaintCode?: string;
}

export function FeedbackModal({ open, onClose, complaintId, complaintCode }: FeedbackModalProps) {
  const queryClient = useQueryClient();
  const [rating, setRating] = useState(5);
  const [category, setCategory] = useState('SERVICE_QUALITY');
  const [comment, setComment] = useState('');

  const mutation = useMutation({
    mutationFn: async () =>
      api('citizen').post('/citizen/feedback', {
        complaintId: complaintId || null,
        rating,
        category,
        comment,
      }),
    onSuccess: () => {
      toast.success('⭐ Thank you for rating the service! +10 Green Credits added.');
      queryClient.invalidateQueries({ queryKey: ['citizen-feedback'] });
      queryClient.invalidateQueries({ queryKey: ['citizen', 'home'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 animate-in fade-in">
      <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 shadow-2xl space-y-4 relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-muted hover:text-ink cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="text-center space-y-1">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand/15 text-brand shadow-xs">
            <CheckCircle className="h-6 w-6 text-brand" />
          </div>
          <h3 className="text-fluid-base font-extrabold text-ink">Complaint Resolved!</h3>
          <p className="text-fluid-xs text-muted">
            {complaintCode ? `How was the cleanup service for ticket #${complaintCode}?` : 'How was your recent municipal pickup service?'}
          </p>
        </div>

        {/* 5-Star Rating */}
        <div className="flex justify-center gap-2 py-2">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              onClick={() => setRating(star)}
              className="p-1 transition hover:scale-120 cursor-pointer focus:outline-none"
            >
              <Star
                className={`h-8 w-8 transition-colors ${
                  star <= rating ? 'fill-amber-400 text-amber-400' : 'text-line'
                }`}
              />
            </button>
          ))}
        </div>

        <div className="space-y-2 text-fluid-xs">
          <label className="font-bold text-ink block">Service Aspect</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="field w-full"
          >
            <option value="SERVICE_QUALITY">Service Quality & Site Cleanliness</option>
            <option value="RESPONSE_TIME">Response Time / Fast Pickup</option>
            <option value="STAFF_BEHAVIOR">Staff & Driver Conduct</option>
            <option value="APP_EXPERIENCE">App Experience</option>
            <option value="OTHER">Other Suggestions</option>
          </select>
        </div>

        <div className="space-y-1 text-fluid-xs">
          <label className="font-bold text-ink block">Comment (Optional)</label>
          <textarea
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Share any note about the cleanup…"
            className="field w-full text-fluid-xs"
            maxLength={500}
          />
        </div>

        <div className="flex items-center justify-between rounded-xl bg-brand/10 border border-brand/20 p-2.5 text-[11px] text-brand font-medium">
          <span className="flex items-center gap-1.5 font-bold">
            <Sparkles className="h-3.5 w-3.5" /> Civic Feedback Bonus
          </span>
          <span>+10 Green Credits</span>
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="btn-primary w-full py-2.5 text-fluid-xs font-bold flex items-center justify-center gap-2 cursor-pointer shadow-md shadow-brand/20"
          >
            <Send className="h-3.5 w-3.5" />
            <span>{mutation.isPending ? 'Submitting…' : 'Submit Review'}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost py-2.5 px-4 text-fluid-xs font-semibold cursor-pointer"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
