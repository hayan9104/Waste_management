import { useEffect, useState } from 'react';
import { Phone, WifiOff, Flame, Ambulance, Shield, Bug, Dog, Headphones } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Card } from '../../components/ui';

const CACHE_KEY = 'ss_directory_cache';

interface ContactItem {
  id?: string;
  name: string;
  category: string;
  phone: string;
}

const DEFAULT_DIRECTORY: ContactItem[] = [
  { id: '1', name: 'Animal Control — GMC', category: 'animal_control', phone: '079-23224466' },
  { id: '2', name: 'Dead Animal Removal Squad', category: 'animal_control', phone: '079-23225913' },
  { id: '3', name: 'Fire & Emergency Services', category: 'fire', phone: '101' },
  { id: '4', name: 'GMC Health Department', category: 'helpline', phone: '079-23223751' },
  { id: '5', name: 'GMC Sanitation Helpline', category: 'helpline', phone: '079-23227980' },
  { id: '6', name: 'Sector 1-7 Zonal Sanitation Office', category: 'helpline', phone: '079-23220000' },
  { id: '7', name: 'Ambulance', category: 'hospital', phone: '108' },
  { id: '8', name: 'Pest Control Cell', category: 'pest_control', phone: '079-23223311' },
  { id: '9', name: 'Police Control Room', category: 'police', phone: '100' },
];

const CATEGORY_META: Record<string, { label: string; icon: typeof Phone; color: string }> = {
  animal_control: {
    label: 'Animal control',
    icon: Dog,
    color: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400',
  },
  fire: {
    label: 'Fire & emergency',
    icon: Flame,
    color: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400',
  },
  helpline: {
    label: 'Municipal helplines',
    icon: Headphones,
    color: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400',
  },
  hospital: {
    label: 'Medical',
    icon: Ambulance,
    color: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400',
  },
  pest_control: {
    label: 'Pest control',
    icon: Bug,
    color: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400',
  },
  police: {
    label: 'Police',
    icon: Shield,
    color: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400',
  },
};

export default function Directory() {
  const [cached, setCached] = useState<ContactItem[] | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) setCached(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const { data } = useQuery({
    queryKey: ['citizen', 'directory'],
    queryFn: async () => {
      try {
        const res = await api('citizen').get('/citizen/directory');
        if (Array.isArray(res.data) && res.data.length > 0) {
          localStorage.setItem(CACHE_KEY, JSON.stringify(res.data));
          return res.data;
        }
      } catch {
        /* fallback to cache or defaults */
      }
      return DEFAULT_DIRECTORY;
    },
    initialData: cached ?? DEFAULT_DIRECTORY,
  });

  const contacts: ContactItem[] = (data && data.length > 0) ? data : (cached ?? DEFAULT_DIRECTORY);

  // Group contacts in defined display order
  const order = ['animal_control', 'fire', 'helpline', 'hospital', 'pest_control', 'police'];
  const grouped = contacts.reduce((acc: Record<string, ContactItem[]>, c: ContactItem) => {
    const cat = c.category || 'helpline';
    (acc[cat] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      {/* Page Header */}
      <div className="space-y-1">
        <h1 className="text-fluid-2xl font-extrabold tracking-tight text-ink">
          Helpline directory
        </h1>
        <p className="text-fluid-xs text-muted">
          Saved on your device so it works without a connection.
        </p>
      </div>

      {offline && (
        <div className="flex items-center gap-2 rounded-2xl border border-warn/30 bg-warn/10 p-3 text-fluid-xs text-warn">
          <WifiOff className="h-4 w-4 shrink-0" />
          <span>You are currently offline — displaying emergency numbers saved locally.</span>
        </div>
      )}

      {/* Directory Sections */}
      <div className="space-y-6">
        {order.map((catKey) => {
          const items = grouped[catKey];
          if (!items || items.length === 0) return null;
          const meta = CATEGORY_META[catKey] ?? {
            label: catKey.replace(/_/g, ' '),
            icon: Phone,
            color: 'bg-emerald-500/10 text-emerald-600',
          };
          const Icon = meta.icon;

          return (
            <section key={catKey} className="space-y-2.5">
              <h2 className="text-fluid-sm font-bold text-ink">
                {meta.label}
              </h2>

              <div className="space-y-2">
                {items.map((c, idx) => {
                  const telUrl = `tel:${c.phone.replace(/[^0-9]/g, '')}`;
                  return (
                    <Card
                      key={c.id || `${catKey}-${idx}`}
                      className="flex items-center justify-between p-3.5 sm:p-4 border border-line bg-surface hover:border-brand/40 transition shadow-xs rounded-2xl"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${meta.color}`}>
                          <Icon className="h-5 w-5" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-fluid-xs sm:text-fluid-sm font-bold text-ink truncate">
                            {c.name}
                          </p>
                          <p className="text-[12px] font-mono text-muted tracking-wide mt-0.5">
                            {c.phone}
                          </p>
                        </div>
                      </div>

                      <a
                        href={telUrl}
                        aria-label={`Call ${c.name}`}
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/20 transition cursor-pointer ml-3"
                      >
                        <Phone className="h-4 w-4" />
                      </a>
                    </Card>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
