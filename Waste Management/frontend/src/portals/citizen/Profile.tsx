import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Camera, Check, Loader2, Pencil } from 'lucide-react';
import { api, assetUrl, errorMessage } from '../../lib/api';
import { Card, toast } from '../../components/ui';
import { useI18n } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';

export default function Profile() {
  const { user, refresh } = useAuth();
  const { t } = useI18n();

  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(user?.name ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const saveName = useMutation({
    mutationFn: async (nextName: string) => (await api('citizen').patch('/citizen/profile', { name: nextName })).data,
    onSuccess: async () => {
      await refresh();
      setEditingName(false);
      toast.success(t('citizen.profile.saved'));
    },
    onError: (err) => toast.error(errorMessage(err, t('citizen.profile.saveFailed'))),
  });

  const uploadAvatar = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('avatar', file);
      return (await api('citizen').post('/citizen/profile/avatar', form)).data;
    },
    onSuccess: async () => {
      await refresh();
      toast.success(t('citizen.profile.saved'));
    },
    onError: (err) => toast.error(errorMessage(err, t('citizen.profile.saveFailed'))),
  });

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <h1 className="text-fluid-xl font-bold tracking-tight">{t('citizen.profile.title')}</h1>

      <Card className="flex items-center gap-3 p-4">
        <div className="relative shrink-0">
          {user?.avatarUrl ? (
            <img
              src={assetUrl(user.avatarUrl)}
              alt=""
              className="h-14 w-14 rounded-full object-cover"
            />
          ) : (
            <span
              className="grid h-14 w-14 place-items-center rounded-full text-fluid-lg font-bold text-white"
              style={{ background: user?.avatarColor || '#15803d' }}
            >
              {user?.name?.[0]}
            </span>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadAvatar.mutate(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadAvatar.isPending}
            className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full border-2 border-elevated bg-brand text-brand-ink shadow-xs disabled:opacity-60"
            aria-label={t('citizen.profile.uploadPhoto')}
          >
            {uploadAvatar.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
          </button>
        </div>
        <div className="min-w-0 flex-1">
          {editingName ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() && name.trim() !== user?.name) saveName.mutate(name.trim());
                else setEditingName(false);
              }}
            >
              <input
                autoFocus
                className="field min-h-0 py-1 text-fluid-sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('citizen.profile.namePlaceholder')}
                maxLength={80}
              />
              <button
                type="submit"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-brand-ink disabled:opacity-50"
                disabled={saveName.isPending}
                aria-label={t('citizen.profile.saveName')}
              >
                {saveName.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                setName(user?.name ?? '');
                setEditingName(true);
              }}
              className="group flex items-center gap-1.5 truncate text-fluid-base font-semibold"
            >
              <span className="truncate">{user?.name}</span>
              <Pencil className="h-3.5 w-3.5 shrink-0 text-faint transition group-hover:text-brand" />
            </button>
          )}
          <p className="truncate text-fluid-xs text-muted">{user?.email || user?.phone}</p>
          {user?.ward && <p className="truncate text-fluid-xs text-muted">{user.ward.name}</p>}
        </div>
      </Card>

      <p className="flex items-center justify-center gap-1.5 text-fluid-xs text-faint">
        <Check className="h-3.5 w-3.5" /> Safaai Sarathi v1.0
      </p>
    </div>
  );
}
