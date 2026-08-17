import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Camera,
  BrainCircuit,
  Truck,
  ShieldCheck,
  Siren,
  MapPinned,
  TrendingUp,
  Phone,
  MessageCircle,
  Building2,
  Zap,
  Sparkles,
  Users,
  CheckCircle2,
  MapPin,
  Flame,
  Activity,
  Layers,
  HelpCircle,
} from 'lucide-react';
import { publicApi } from '../lib/api';
import { LanguageSwitcher, ThemeToggle, Reveal } from '../components/ui';
import { FaqAccordion } from '../components/FaqAccordion';
import { useT } from '../lib/i18n';
import { formatNumber } from '../lib/format';

interface Stats {
  city: string;
  complaintsTotal: number;
  complaintsResolved: number;
  resolutionRatePct: number;
  avgResolutionHours: number;
  wards: number;
  vehicles: number;
  citizens: number;
}

/** Counts up to the real value once it arrives — never a decorative number. */
function Counter({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const duration = 1100;
    let frame: number;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setShown(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  const decimals = value % 1 !== 0 ? 1 : 0;
  return (
    <span className="tabular-nums">
      {decimals ? shown.toFixed(1) : formatNumber(shown)}
      {suffix}
    </span>
  );
}

const STEPS = [
  { icon: Camera, key: '1' },
  { icon: BrainCircuit, key: '2' },
  { icon: Truck, key: '3' },
  { icon: ShieldCheck, key: '4' },
];

const DIFFERENTIATORS = [
  { icon: Siren, key: '1' },
  { icon: MapPinned, key: '2' },
  { icon: TrendingUp, key: '3' },
  { icon: ShieldCheck, key: '4' },
];

export default function Landing() {
  const t = useT();
  const [stats, setStats] = useState<Stats | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    publicApi
      .get<Stats>('/stats')
      .then((r) => setStats(r.data))
      .catch(() => setStats(null));

    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll);

    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className="min-h-dvh bg-surface">
      {/* ---- Nav — fixed, same 4rem row height as every portal shell ---- */}
      <header className="fixed top-0 z-40 w-full transition-all duration-500">
        {/* Tricolor strip — always visible at top */}
        <div className={`flex h-1 w-full transition-all duration-500 ${scrolled ? 'opacity-0 h-0' : 'opacity-100'}`}>
          <div className="flex-1 bg-[#FF9933]" />
          <div className="flex-1 bg-white" />
          <div className="flex-1 bg-[#138808]" />
        </div>

        {scrolled ? (
          /* Scrolled: centered floating pill */
          <div className="px-4 pt-2.5 sm:px-6">
            <div className="mx-auto flex h-16 max-w-5xl items-center justify-between rounded-full bg-surface/95 px-4 shadow-2xl backdrop-blur-xl ring-1 ring-line/60 sm:px-6">
              {/* Left Brand */}
              <div className="flex items-center gap-1.5 shrink-0">
                <img src="/icon.svg" alt="" className="h-9 w-9 shrink-0 animate-logo-pop" />
                <div className="flex flex-col">
                  <span className="text-fluid-sm font-extrabold tracking-tight text-ink whitespace-nowrap">
                    Safaai <span className="text-brand">Sarathi</span>
                  </span>
                  <span className="text-[9px] font-semibold text-muted tracking-wider uppercase leading-none">
                    Civic AI Platform
                  </span>
                </div>
              </div>

              {/* Center: Nav links with unique custom symbols in a sleek pill */}
              <nav className="hidden xl:flex items-center gap-1 rounded-full bg-surface/80 px-2 py-1 ring-1 ring-line/50 backdrop-blur-md shadow-sm">
                <a
                  href="#how"
                  className="flex items-center gap-2 rounded-full px-3 py-1 text-fluid-xs font-medium leading-tight text-muted transition-all duration-200 hover:bg-brand/10 hover:text-brand"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-brand text-xs">
                    <Zap className="h-3 w-3" />
                  </span>
                  <span>{t('landing.nav.how')}</span>
                </a>
                <span className="h-3.5 w-px bg-line/60" />
                <a
                  href="#why"
                  className="flex items-center gap-2 rounded-full px-3 py-1 text-fluid-xs font-medium leading-tight text-muted transition-all duration-200 hover:bg-brand/10 hover:text-brand"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-brand text-xs">
                    <Sparkles className="h-3 w-3" />
                  </span>
                  <span>{t('landing.nav.why')}</span>
                </a>
                <span className="h-3.5 w-px bg-line/60" />
                <a
                  href="#faq"
                  className="flex items-center gap-2 rounded-full px-3 py-1 text-fluid-xs font-medium leading-tight text-muted transition-all duration-200 hover:bg-brand/10 hover:text-brand"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-brand text-xs">
                    <HelpCircle className="h-3 w-3" />
                  </span>
                  <span>{t('landing.nav.faq')}</span>
                </a>
                <span className="h-3.5 w-px bg-line/60" />
                <a
                  href="#staff"
                  className="flex items-center gap-2 rounded-full px-3 py-1 text-fluid-xs font-medium leading-tight text-muted transition-all duration-200 hover:bg-brand/10 hover:text-brand"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-brand text-xs">
                    <Building2 className="h-3 w-3" />
                  </span>
                  <span>{t('landing.nav.staff')}</span>
                </a>
              </nav>

              {/* Right: Actions */}
              <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
                <LanguageSwitcher compact />
                <ThemeToggle />
                <Link
                  to="/login"
                  className="btn-primary btn-sm rounded-full px-3.5 sm:px-5 py-1.5 sm:py-2 text-xs sm:text-fluid-sm font-semibold shadow-md shadow-brand/20 whitespace-nowrap hover:shadow-lg transition-all"
                >
                  {t('common.signIn')}
                </Link>
              </div>
            </div>
          </div>
        ) : (
          /* Not scrolled: full-width white frosted bar with corner-to-corner layout */
          <div className="w-full border-b border-line/30 bg-surface/90 backdrop-blur-md transition-all duration-300">
            <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8 xl:px-12">
              {/* Left: Brand Logo & Title at Left Corner */}
              <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
                <img
                  src="/icon.svg"
                  alt=""
                  className="h-9 w-9 shrink-0 animate-logo-pop transition-transform duration-300 hover:scale-105"
                />
                <div className="flex flex-col">
                  <span className="text-sm sm:text-fluid-base font-extrabold tracking-tight text-ink whitespace-nowrap leading-none">
                    Safaai <span className="text-brand">Sarathi</span>
                  </span>
                  <span className="text-[9px] sm:text-[10px] font-semibold text-muted tracking-wider uppercase leading-tight mt-0.5">
                    Civic AI Platform
                  </span>
                </div>
              </div>

              {/* Center: Nav links with unique custom symbols in a sleek pill & strictly single line */}
              <nav className="hidden xl:flex items-center gap-1 rounded-full bg-surface/80 px-2 py-1 ring-1 ring-line/50 backdrop-blur-md shadow-sm">
                <a
                  href="#how"
                  className="flex items-center gap-2 rounded-full px-3 py-1 text-fluid-xs font-medium leading-tight text-muted transition-all duration-200 hover:bg-brand/10 hover:text-brand"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-brand text-xs">
                    <Zap className="h-3 w-3" />
                  </span>
                  <span>{t('landing.nav.how')}</span>
                </a>
                <span className="h-3.5 w-px bg-line/60" />
                <a
                  href="#why"
                  className="flex items-center gap-2 rounded-full px-3 py-1 text-fluid-xs font-medium leading-tight text-muted transition-all duration-200 hover:bg-brand/10 hover:text-brand"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-brand text-xs">
                    <Sparkles className="h-3 w-3" />
                  </span>
                  <span>{t('landing.nav.why')}</span>
                </a>
                <span className="h-3.5 w-px bg-line/60" />
                <a
                  href="#faq"
                  className="flex items-center gap-2 rounded-full px-3 py-1 text-fluid-xs font-medium leading-tight text-muted transition-all duration-200 hover:bg-brand/10 hover:text-brand"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-brand text-xs">
                    <HelpCircle className="h-3 w-3" />
                  </span>
                  <span>{t('landing.nav.faq')}</span>
                </a>
                <span className="h-3.5 w-px bg-line/60" />
                <a
                  href="#staff"
                  className="flex items-center gap-2 rounded-full px-3 py-1 text-fluid-xs font-medium leading-tight text-muted transition-all duration-200 hover:bg-brand/10 hover:text-brand"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-brand text-xs">
                    <Building2 className="h-3 w-3" />
                  </span>
                  <span>{t('landing.nav.staff')}</span>
                </a>
              </nav>

              {/* Right: Actions at Right Corner */}
              <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
                <LanguageSwitcher compact />
                <ThemeToggle />
                <Link
                  to="/login"
                  className="btn-primary btn-sm rounded-full px-3.5 sm:px-5 py-1.5 sm:py-2 text-xs sm:text-fluid-sm font-semibold shadow-md shadow-brand/20 whitespace-nowrap hover:shadow-lg transition-all"
                >
                  {t('common.signIn')}
                </Link>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* ---- Hero Section: Redesigned with Smooth, Modern Aesthetics ---- */}
      <section className="relative overflow-hidden pt-20 pb-10 lg:pt-24 lg:pb-14">
        {/* Soft, modern ambient glow background */}
        <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div className="absolute -top-32 left-1/2 -translate-x-1/2 h-[500px] w-[900px] rounded-full bg-gradient-to-tr from-brand/15 via-emerald-400/10 to-teal-400/5 blur-3xl" />
          <div className="absolute top-1/3 -right-20 h-72 w-72 rounded-full bg-amber-400/10 blur-3xl" />
          <div className="absolute top-1/2 -left-20 h-72 w-72 rounded-full bg-brand/10 blur-3xl" />
          <div className="absolute inset-0 bg-[radial-gradient(#15803d_1px,transparent_1px)] [background-size:24px_24px] opacity-[0.03] dark:opacity-[0.07]" />
        </div>

        <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 xl:px-12">
          <div className="grid items-center gap-8 lg:grid-cols-12 lg:gap-10">
            {/* Left Content (7 Columns) */}
            <Reveal as="div" className="space-y-5 text-left lg:col-span-7">
              {/* Official Badges */}
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="inline-flex items-center gap-2 rounded-full border border-orange-500/30 bg-orange-500/10 px-3 py-1 text-fluid-xs font-bold text-orange-700 dark:text-orange-400 shadow-xs">
                  <span className="text-[#000080] dark:text-[#6699ff]">🔵</span>
                  भारत सरकार &nbsp;·&nbsp; Government of India
                </span>

                <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-fluid-xs font-bold text-brand shadow-xs">
                  <Building2 className="h-3.5 w-3.5" />
                  {t('landing.hero.badge') || 'Built for Gujarat ULBs & Smart Cities'}
                </span>
              </div>

              {/* Main Headline */}
              <h1 className="text-fluid-3xl font-extrabold tracking-tight text-ink sm:text-5xl lg:text-6xl leading-[1.12]">
                {t('landing.hero.title1')}{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-600 via-teal-500 to-green-600 dark:from-emerald-400 dark:to-teal-300">
                  {t('landing.hero.title2')}
                </span>
              </h1>

              {/* Subtitle */}
              <p className="max-w-2xl text-fluid-base text-muted leading-relaxed">{t('landing.hero.body')}</p>

              {/* Call-to-Action Buttons */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Link
                  to="/login"
                  className="btn-primary rounded-2xl px-6 py-3 text-fluid-sm font-bold shadow-lg shadow-brand/25 hover:shadow-xl hover:shadow-brand/35 transition-all flex items-center gap-2"
                >
                  <span>{t('landing.hero.cta') || 'Report an issue'}</span>
                  <ArrowRight className="h-4 w-4" />
                </Link>

                <a
                  href="#staff"
                  className="inline-flex items-center gap-2 rounded-2xl border border-line bg-elevated/80 px-6 py-3 text-fluid-sm font-semibold text-ink backdrop-blur shadow-xs hover:bg-sunken transition"
                >
                  <Building2 className="h-4 w-4 text-muted" />
                  <span>{t('landing.hero.staffCta') || "I'm municipal staff"}</span>
                </a>
              </div>

              {/* Live Database Stat Metrics */}
              <div className="pt-3 border-t border-line/60">
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted mb-2.5 flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-brand" /> {t('landing.hero.telemetry')}
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: t('landing.stat.handled') || 'Complaints Handled', value: stats?.complaintsTotal ?? 3, suffix: '' },
                    { label: t('landing.stat.rate') || 'Resolution Rate', value: stats?.resolutionRatePct ?? 33, suffix: '%' },
                    { label: t('landing.stat.avg') || 'Avg Resolution', value: stats?.avgResolutionHours ?? 24, suffix: 'h' },
                    { label: t('landing.stat.wards') || 'Wards Covered', value: stats?.wards ?? 8, suffix: '' },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-2xl border border-line bg-surface/90 p-3 shadow-xs transition hover:shadow-sm"
                    >
                      <div className="text-fluid-xl font-extrabold text-ink tracking-tight">
                        {stats ? <Counter value={item.value} suffix={item.suffix} /> : <span>{item.value}{item.suffix}</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] font-medium text-muted truncate">{item.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>

            {/* Right Live Interactive Showcase Visual Card (5 Columns) */}
            <Reveal as="div" delayMs={150} className="lg:col-span-5">
              <div className="relative mx-auto max-w-md lg:max-w-none rounded-3xl border border-line bg-surface/80 p-5 shadow-2xl backdrop-blur-xl ring-1 ring-white/10 space-y-4">
                {/* Visual Image with Neural Detection Box */}
                <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-slate-950 border border-line/80 shadow-inner">
                  <img
                    src="https://images.unsplash.com/photo-1530587191325-3db32d826c18?w=800&q=80&auto=format&fit=crop"
                    alt="AI Waste Detection Preview"
                    className="h-full w-full object-cover brightness-95"
                  />

                  {/* Simulated Neural Bounding Box */}
                  <div className="absolute inset-x-6 inset-y-8 rounded-xl border-2 border-dashed border-emerald-400 bg-emerald-500/10 p-2 backdrop-blur-[1px] animate-pulse">
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white shadow-xs">
                      <Sparkles className="h-3 w-3" /> {t('landing.showcase.aiLabel')}
                    </span>
                  </div>

                  {/* Live HUD Badge */}
                  <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 rounded-xl bg-black/75 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur-md">
                    <span className="flex min-w-0 items-center gap-1.5 text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{t('landing.showcase.autoApproved')}</span>
                    </span>
                    <span className="shrink-0 truncate text-slate-300 font-mono">{t('landing.showcase.location')}</span>
                  </div>
                </div>

                {/* Live Action Flow Cards */}
                <div className="space-y-2.5">
                  {/* Step 1: Officer Auto-Escalation */}
                  <div className="flex items-center justify-between rounded-2xl border border-line bg-sunken/60 p-3 text-fluid-xs">
                    <div className="flex items-center gap-2.5">
                      <div className="grid h-8 w-8 place-items-center rounded-xl bg-brand/10 text-brand">
                        <MapPin className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="font-bold text-ink">{t('landing.showcase.officerAssigned')}</p>
                        <p className="text-[11px] text-muted">{t('landing.showcase.officerAssignedBody')}</p>
                      </div>
                    </div>
                    <span className="rounded-lg bg-ok/10 px-2 py-1 text-[10px] font-bold text-ok uppercase">
                      {t('landing.showcase.active')}
                    </span>
                  </div>

                  {/* Step 2: Collection Truck GPS */}
                  <div className="flex items-center justify-between rounded-2xl border border-line bg-sunken/60 p-3 text-fluid-xs">
                    <div className="flex items-center gap-2.5">
                      <div className="grid h-8 w-8 place-items-center rounded-xl bg-brand/10 text-brand">
                        <Truck className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="font-bold text-ink">{t('landing.showcase.truckPlate')}</p>
                        <p className="text-[11px] text-muted">{t('landing.showcase.routeBody')}</p>
                      </div>
                    </div>
                    <span className="rounded-lg bg-brand/15 px-2 py-1 text-[10px] font-bold text-brand uppercase font-mono">
                      {t('landing.showcase.gpsLive')}
                    </span>
                  </div>
                </div>

                {/* Green Credit Perk */}
                <div className="flex items-center justify-between rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2.5 text-fluid-xs text-emerald-800 dark:text-emerald-300">
                  <span className="flex items-center gap-1.5 font-bold">
                    <Sparkles className="h-4 w-4 text-brand" /> {t('landing.showcase.incentive')}
                  </span>
                  <span className="font-bold text-brand">{t('landing.showcase.credits')}</span>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ---- How it works ---- */}
      <section id="how" className="border-t border-line bg-elevated px-4 py-12 sm:py-16">
        <div className="mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="text-fluid-2xl font-bold tracking-tight text-ink">{t('landing.how.title')}</h2>
            <p className="mt-2 text-fluid-sm text-muted">
              {t('landing.how.body')}
            </p>
          </Reveal>

          <div className="relative mx-auto mt-12 max-w-4xl">
            {/* Vertical Line */}
            <div className="absolute bottom-4 left-[27px] top-4 w-0.5 bg-brand/20 md:left-1/2 md:-ml-px" />

            <div className="space-y-8 md:space-y-12">
              {STEPS.map((step, i) => (
                <Reveal
                  key={step.key}
                  delayMs={i * 90}
                  className={`relative flex flex-col md:flex-row md:items-center gap-4 md:gap-8 ${
                    i % 2 === 1 ? 'md:flex-row-reverse' : ''
                  }`}
                >
                  {/* Timeline Dot */}
                  <div className="absolute left-2 top-2 flex h-10 w-10 items-center justify-center rounded-full bg-brand/10 text-brand ring-4 ring-elevated md:left-1/2 md:top-1/2 md:-ml-5 md:-mt-5 shadow-xs">
                    <step.icon className="h-5 w-5" />
                  </div>

                  {/* Content Card */}
                  <div
                    className={`ml-14 md:ml-0 md:w-1/2 ${
                      i % 2 === 0 ? 'md:pr-12 text-left md:text-right' : 'md:pl-12 text-left'
                    }`}
                  >
                    <div className="card group relative overflow-hidden p-5 sm:p-6 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:shadow-brand/5 border border-line bg-surface">
                      <div
                        className={`absolute top-3 right-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand/5 opacity-40 transition-transform duration-500 group-hover:scale-110 group-hover:opacity-70 ${
                          i % 2 === 0 ? 'md:left-3 md:right-auto' : ''
                        }`}
                      >
                        <step.icon className="h-7 w-7 text-brand" />
                      </div>
                      <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-brand">
                        {t('landing.how.step', { n: i + 1 })}
                      </span>
                      <h3 className="text-fluid-lg font-bold text-ink">{t(`landing.how.${step.key}.title`)}</h3>
                      <p className="mt-2 text-fluid-sm leading-relaxed text-muted">
                        {t(`landing.how.${step.key}.body`)}
                      </p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---- Differentiators ---- */}
      <section id="why" className="px-4 py-12 sm:py-16">
        <div className="mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="text-fluid-2xl font-bold tracking-tight text-ink">{t('landing.why.title')}</h2>
            <p className="mt-2 text-fluid-sm text-muted">
              {t('landing.why.body')}
            </p>
          </Reveal>

          <div className="mt-8 grid gap-4 md:grid-cols-2 md:auto-rows-fr">
            {DIFFERENTIATORS.map((item, i) => (
              <Reveal key={item.key} delayMs={i * 80} className="card flex h-full flex-col p-5 border border-line bg-surface shadow-xs hover:shadow-sm transition">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand">
                  <item.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-3 text-fluid-base font-bold text-ink">{t(`landing.why.${item.key}.title`)}</h3>
                <p className="mt-1.5 text-fluid-sm text-muted leading-relaxed">{t(`landing.why.${item.key}.body`)}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Zero-install channels ---- */}
      <section className="border-y border-line bg-elevated px-4 py-12 sm:py-16">
        <div className="mx-auto grid max-w-6xl items-center gap-8 md:grid-cols-2">
          <Reveal>
            <h2 className="text-fluid-2xl font-bold tracking-tight text-ink">{t('landing.channels.title')}</h2>
            <p className="mt-2 text-fluid-sm text-muted">
              {t('landing.channels.body')}
            </p>
            <div className="mt-5 space-y-3">
              <div className="flex gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
                  <MessageCircle className="h-4 w-4" />
                </span>
                <div>
                  <h3 className="text-fluid-base font-bold text-ink">{t('landing.channels.whatsapp')}</h3>
                  <p className="text-fluid-sm text-muted">{t('landing.channels.whatsappBody')}</p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
                  <Phone className="h-4 w-4" />
                </span>
                <div>
                  <h3 className="text-fluid-base font-bold text-ink">{t('landing.channels.ivr')}</h3>
                  <p className="text-fluid-sm text-muted">{t('landing.channels.ivrBody')}</p>
                </div>
              </div>
            </div>
          </Reveal>

          <Reveal delayMs={120} className="card p-6 border border-line bg-surface shadow-xs">
            <h3 className="text-fluid-base font-bold text-ink">{t('landing.models.title')}</h3>
            <p className="mt-1.5 text-fluid-sm text-muted">
              {t('landing.models.body')}
            </p>
            <ul className="mt-4 grid gap-2 text-fluid-sm">
              {['landing.models.item1', 'landing.models.item2', 'landing.models.item3', 'landing.models.item4', 'landing.models.item5'].map((key) => (
                <li key={key} className="flex items-center gap-2.5 text-muted">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-brand" />
                  <span className="text-ink text-fluid-xs font-medium">{t(key)}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      {/* ---- FAQ Section (Custom Accordion Component) ---- */}
      <section id="faq" className="px-4 py-12 sm:py-16 bg-surface">
        <Reveal>
          <FaqAccordion />
        </Reveal>
      </section>

      {/* ---- Staff entry points ---- */}
      <section id="staff" className="border-t border-line bg-elevated px-4 py-12 sm:py-16">
        <div className="mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="text-fluid-2xl font-bold tracking-tight text-ink">{t('landing.portals.title')}</h2>
            <p className="mt-2 text-fluid-sm text-muted">
              {t('landing.portals.body')}
            </p>
          </Reveal>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {[
              { to: '/driver/login', title: t('landing.portal.driver'), body: t('landing.portal.driverBody'), icon: Truck },
              { to: '/officer/login', title: t('landing.portal.officer'), body: t('landing.portal.officerBody'), icon: MapPinned },
              { to: '/admin/login', title: t('landing.portal.admin'), body: t('landing.portal.adminBody'), icon: ShieldCheck },
            ].map((portal, i) => (
              <Reveal key={portal.to} delayMs={i * 90} as="div">
                <Link to={portal.to} className="card group block p-5 border border-line bg-surface transition hover:shadow-md hover:border-brand/30">
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand/10 text-brand">
                    <portal.icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 flex items-center gap-1.5 text-fluid-lg font-bold text-ink">
                    {portal.title}
                    <ArrowRight className="h-4 w-4 text-muted transition group-hover:translate-x-1 group-hover:text-brand" />
                  </h3>
                  <p className="mt-1.5 text-fluid-sm text-muted leading-relaxed">{portal.body}</p>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Deep-green footer with Indian Government official styling */}
      <footer className="bg-[#0f4d2a] text-white">
        {/* Tricolor top strip */}
        <div className="flex h-1.5">
          <div className="flex-1 bg-[#FF9933]" />
          <div className="flex-1 bg-white/70" />
          <div className="flex-1 bg-[#138808]" />
        </div>

        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex items-center gap-3">
            <img src="/icon.svg" alt="" className="h-8 w-8 animate-logo-pop" />
            <div>
              <div className="text-fluid-base font-bold tracking-tight">
                Safaai Sarathi &nbsp;<span className="font-normal opacity-70">·</span>&nbsp;{' '}
                <span className="font-semibold opacity-90">सफाई सारथी</span>
              </div>
              <div className="text-[0.65rem] font-medium uppercase tracking-widest text-white/60">
                Government of India &nbsp;·&nbsp; भारत सरकार
              </div>
            </div>
          </div>

          <p className="mt-3 max-w-2xl text-fluid-xs text-white/75 leading-relaxed">
            {t('landing.footer.body', { city: stats?.city ?? 'Gandhinagar' })}
          </p>

          <div className="mt-3 space-y-0.5 text-fluid-xs text-white/60">
            <p>{t('landing.footer.org')}</p>
            <p>{t('landing.footer.helplines')}</p>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-white/15 pt-4">
            <p className="text-fluid-xs text-white/50">
              {t('landing.footer.rights', { year: new Date().getFullYear() })}
            </p>
            <span className="text-fluid-sm text-white/50 flex items-center gap-2">
              <img src="/emblem-india.png" alt="National Emblem of India" className="h-7 w-auto shrink-0 opacity-90" />
              Satyameva Jayate &nbsp;·&nbsp; सत्यमेव जयते
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
