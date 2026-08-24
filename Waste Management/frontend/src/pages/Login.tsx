import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Check, KeyRound, Loader2, Shield, Smartphone, Truck, User, Building2 } from 'lucide-react';
import { api, errorMessage, type Portal, BASE } from '../lib/api';
import { useAuth, HOME_ROUTE } from '../lib/auth';
import { LanguageSwitcher, ThemeToggle, toast } from '../components/ui';
import { SpotlightNav, type SpotlightNavItem } from '../components/SpotlightNav';
import { useT } from '../lib/i18n';

/**
 * One login screen per portal (plan §3) — no shared screen with a role
 * dropdown. The component is parameterised by portal, but each is mounted at
 * its own route with its own auth provider, so sessions never mix.
 */

interface PortalCopy {
  icon: typeof User;
  accent: string;
  hasNote?: boolean;
}

/** Copy lives in the locale files; only icon and accent stay here. */
const PORTAL_COPY: Record<Portal, PortalCopy> = {
  citizen: { icon: User, accent: 'text-brand' },
  driver: { icon: Truck, accent: 'text-info', hasNote: true },
  officer: { icon: Building2, accent: 'text-warn', hasNote: true },
  admin: { icon: Shield, accent: 'text-danger', hasNote: true },
};

/** Each portal's own login route (plan §3 — no shared screen with a role dropdown). */
const PORTAL_LOGIN_ROUTE: Record<Portal, string> = {
  citizen: '/login',
  driver: '/driver/login',
  officer: '/officer/login',
  admin: '/admin/login',
};
const PORTAL_ORDER: Portal[] = ['citizen', 'driver', 'officer', 'admin'];

/**
 * Jumps directly to another role's login screen — the same SpotlightNav used
 * on every console/mobile shell (spotlight hover, sliding active pill, ambient
 * glow), so the login page's switcher doesn't look like a one-off control.
 */
function PortalTabs({ className = '' }: { className?: string }) {
  const t = useT();
  const items: SpotlightNavItem[] = PORTAL_ORDER.map((p) => ({
    to: PORTAL_LOGIN_ROUTE[p],
    label: t(`auth.switchPortal.${p}`),
    icon: PORTAL_COPY[p].icon,
  }));
  return <SpotlightNav items={items} accent="brand" className={`bg-elevated/80 backdrop-blur ${className}`} />;
}

/**
 * Phone version of the same switcher. The SpotlightNav pill lays its four
 * icon+label items out in a row that measures ~368px, so on a 320-393px handset
 * the last tab ("Admin") was cut off at the card's edge — invisible as a page
 * scrollbar because the shell clips overflow-x, but unreachable all the same.
 * As a four-column grid the labels sit under their icons and every tab stays
 * fully readable and tappable down to 320px.
 */
function PortalTabsCompact({ current }: { current: Portal }) {
  const t = useT();
  return (
    <div className="grid w-full grid-cols-4 gap-1 rounded-2xl border border-line/60 bg-sunken/60 p-1">
      {PORTAL_ORDER.map((p) => {
        const Icon = PORTAL_COPY[p].icon;
        const active = p === current;
        return (
          <Link
            key={p}
            to={PORTAL_LOGIN_ROUTE[p]}
            aria-current={active ? 'page' : undefined}
            className={`flex flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-[11px] font-semibold leading-none transition ${
              active ? 'bg-brand text-brand-ink shadow-sm' : 'text-muted hover:bg-elevated hover:text-ink'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="w-full truncate text-center">{t(`auth.switchPortal.${p}`)}</span>
          </Link>
        );
      })}
    </div>
  );
}

interface DemoAccount {
  name: string;
  email: string;
  phone: string;
  role: string;
}

/**
 * Long, soft ramp so the sharp photo melts into the blurred copy behind it.
 * A short ramp would read as an edge, which is the one thing to avoid here.
 */
const FADE_RIGHT =
  'linear-gradient(to right, #000 0%, #000 42%, rgba(0,0,0,0.85) 58%, rgba(0,0,0,0.45) 72%, rgba(0,0,0,0.15) 84%, transparent 94%)';

export default function Login({ portal }: { portal: Portal }) {
  const t = useT();
  const copy = PORTAL_COPY[portal];
  const Icon = copy.icon;
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [demo, setDemo] = useState<{ password: string; accounts: DemoAccount[]; googleEnabled: boolean } | null>(null);

  const isDemo = demo && demo.accounts.length > 0;
  const redirectTo = (location.state as { from?: string })?.from || HOME_ROUTE[portal];

  useEffect(() => {
    if (user) navigate(redirectTo, { replace: true });
  }, [user, navigate, redirectTo]);

  useEffect(() => {
    api(portal)
      .get('/auth/demo-accounts')
      .then((r) => setDemo(r.data))
      .catch(() => setDemo(null));
  }, [portal]);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {

      const { data, status } = await api(portal).post(`/auth/${portal}/login`, { email, password });
      if (status === 202 && data.twoFactorRequired) {
        setChallenge(data.challengeToken);
        toast.info(t('auth.enterAuthCode'));
        return;
      }
      signIn(data.accessToken, data.user);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(errorMessage(err, t('auth.signInFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function submitTwoFactor(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await api(portal).post('/auth/2fa/verify', { challengeToken: challenge, code, portal });
      signIn(data.accessToken, data.user);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(errorMessage(err, t('auth.invalidCode')));
    } finally {
      setBusy(false);
    }
  }

  const relevantDemo = demo?.accounts.filter((a) => a.role === portal.toUpperCase()).slice(0, 3) ?? [];

  return (
    /*
      The photo covers the whole viewport; the form floats on it as a card.
      A light scrim keeps text legible without washing the picture out, and it
      is built from the `surface` token so it turns dark automatically in the
      AMOLED theme rather than needing a second artwork.
    */
    /*
      The card is left to size itself and the page scrolls like any normal
      webpage if a short viewport can't fit it — that's the one scroll a user
      already expects, and it's what keeps the card's own content (the
      sign-in button specifically) from ever being trapped behind a
      scrollbar of its own, at any window size.
    */
    <div className="relative flex min-h-dvh flex-col bg-surface">
      {/*
        Two copies of the same photo, both drawn from the same pixels so the
        colours always agree:

          back  — over-scaled and heavily blurred, filling the whole viewport
          front — sharp, flush to the left edge at natural aspect

        The front copy is faded out with a mask rather than clipped, so it
        dissolves into the blur instead of meeting it at a seam. There is no
        edge anywhere for the eye to read as a partition.
      */}
      {/* Pinned to the viewport, not the document — below lg the page can now
          scroll taller than one screen, and the artwork should stay put
          rather than stretching or scrolling along with the card. */}
      <img
        src="/auth-bg.jpg"
        alt=""
        aria-hidden
        className="fixed inset-0 h-full w-full scale-125 object-cover blur-3xl"
      />
      <img
        src="/auth-bg.jpg"
        alt=""
        aria-hidden
        className="fixed inset-y-0 left-0 h-full w-auto max-w-none object-cover object-left"
        style={{ maskImage: FADE_RIGHT, WebkitMaskImage: FADE_RIGHT }}
      />
      <div aria-hidden className="fixed inset-0 bg-surface/40" />
      {/* Heavier wash on the left: the brand copy has no card of its own. */}
      <div
        aria-hidden
        className="fixed inset-0 bg-gradient-to-r from-surface/90 via-surface/45 to-surface/60 lg:via-surface/30 lg:to-surface/70"
      />

      {/* Top bar floats over the photo. No chip on the logo, so the icon starts
          on exactly the same left edge as the headline below it. */}
      <header className="relative z-20 flex shrink-0 items-center justify-between gap-2 px-3 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] short:py-2 sm:gap-3 sm:px-8 sm:py-4">
        <Link to="/" className="flex min-w-0 items-center gap-2 sm:gap-2.5">
          <img src="/icon.svg" alt="" className="h-7 w-7 shrink-0 animate-logo-pop drop-shadow sm:h-8 sm:w-8" />
          <span className="whitespace-nowrap text-fluid-base font-bold tracking-tight">
            Safaai <span className="text-brand">Sarathi</span>
          </span>
        </Link>

        {/* Centered on the header's own width (not just between the side items), so
            it sits perfectly mid-line with the logo regardless of side content width. */}
        <div className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 lg:block">
          <PortalTabs />
        </div>

        {/* The Home label and full language name collapse below sm — the
            wordmark plus three full pills don't fit a 360px header, and this
            is the room the card downstairs needs back. */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <Link to="/" aria-label={t('common.home')} className="btn-ghost btn-sm shrink-0 bg-elevated/80 px-2 backdrop-blur sm:px-3">
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">{t('common.home')}</span>
          </Link>
          <LanguageSwitcher compact className="bg-elevated/80 backdrop-blur sm:hidden" />
          <LanguageSwitcher className="hidden bg-elevated/80 backdrop-blur sm:flex" />
          <ThemeToggle className="shrink-0 bg-elevated/80 backdrop-blur" />
        </div>
      </header>

      {/*
        Free to grow past one viewport at any width — the page itself scrolls
        (see the wrapper above) rather than the card, so nothing here is ever
        trapped behind a scrollbar of its own.
      */}
      <div className="relative z-10 grid w-full flex-1 items-center gap-6 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:px-8 sm:pb-4 lg:gap-12 lg:grid-cols-2">
        {/*
          Brand copy sits directly on the photo — no card. Dropping the panel is
          what lets the text start on the same left edge as the logo above it;
          any padding would have pushed it inwards. The left-hand scrim below
          carries the contrast instead.
        */}
        <section className="hidden max-w-xl lg:block">
          <h2 className="text-fluid-2xl font-bold leading-tight tracking-tight">
            {t(`auth.${portal}.headline`)} <span className="text-brand">{t(`auth.${portal}.highlight`)}</span>
          </h2>
          <p className="mt-3 max-w-lg text-fluid-sm text-muted">{t(`auth.${portal}.blurb`)}</p>

          <ul className="mt-5 space-y-2">
            {[1, 2, 3].map((n) => t(`auth.${portal}.point${n}`)).map((point) => (
              <li key={point} className="flex items-start gap-2.5 text-fluid-sm">
                <span className="mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-brand text-brand-ink">
                  <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                </span>
                <span>{point}</span>
              </li>
            ))}
          </ul>

          <p className="mt-6 text-fluid-xs text-faint">
            {t('auth.orgLine')}
          </p>
        </section>

        {/* Form card — no height cap at any breakpoint. It just takes the
            height it needs and the page scrolls to it, so the sign-in button
            can never end up trapped behind the card's own scrollbar. */}
        <main className="mx-auto flex w-full max-w-md flex-col rounded-3xl border border-line/40 bg-elevated/55 p-4 shadow-lift backdrop-blur-2xl short:p-3 sm:p-6 lg:p-7">
          <div className="flex w-full flex-col">
          {/* Mobile-only fallback — the header carries this centered on the logo's line at lg: and up, but there's no room for it there on a phone. */}
          <div className="mb-3.5 short:mb-2 lg:hidden">
            <p className="mb-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-faint short:hidden">
              {t('auth.switchPortal.label')}
            </p>
            <PortalTabsCompact current={portal} />
          </div>

          <div className="flex items-center gap-3">
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-sunken ${copy.accent}`}>
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 className="text-fluid-xl font-bold leading-tight tracking-tight">{t(`auth.${portal}.title`)}</h1>
              <p className="mt-0.5 text-fluid-xs text-muted short:hidden lg:block">{t(`auth.${portal}.subtitle`)}</p>
            </div>
          </div>

          {copy.hasNote && (
            <p className="mt-3 rounded-xl border border-line bg-sunken px-3 py-2 text-fluid-xs text-muted">{t(`auth.${portal}.note`)}</p>
          )}

          <div className="mt-3 rounded-xl border border-brand/30 bg-brand/5 px-3 py-2 text-fluid-xs text-ink">
            <strong>Demo:</strong> tap a tag below, or use password{' '}
            <code className="font-mono select-all font-bold">safaai@2026</code>
          </div>

          {error && (
            <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-fluid-xs text-danger">
              {error}
            </p>
          )}

          {/* ---- Two-factor step ---- */}
          {challenge ? (
            <form onSubmit={submitTwoFactor} className="mt-4 space-y-3">
              <div>
                <label className="label" htmlFor="code">{t('auth.authCode')}</label>
                <input
                  id="code"
                  className="field text-center text-fluid-lg tracking-[0.4em]"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  autoFocus
                  required
                />
              </div>
              <button className="btn-primary w-full" disabled={busy || code.length < 6}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {t('auth.verifyContinue')}
              </button>
              <button type="button" className="btn-ghost w-full" onClick={() => setChallenge(null)}>
                {t('common.back')}
              </button>
            </form>
          ) : (
            /* ---- Password ---- */
            <form onSubmit={submitPassword} className="mt-4 space-y-3 short:mt-3 short:space-y-2">
              <div>
                <label className="label short:sr-only" htmlFor="email">{t('auth.email')}</label>
                <input
                  id="email"
                  type="email"
                  className="field"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  placeholder="you@example.com"
                  required
                />
              </div>
              <div>
                <label className="label short:sr-only" htmlFor="password">{t('auth.password')}</label>
                <input
                  id="password"
                  type="password"
                  className="field"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder={t('auth.password')}
                  required
                />
              </div>

              <button className="btn-primary w-full" disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('common.signIn')}
              </button>

              {portal === 'citizen' && (
                <>
                  {/* Flex rules rather than an overlapping chip — the card is
                      translucent, so an opaque label would read as a blob. */}
                  <div className="flex items-center gap-3">
                    <span className="h-px flex-1 bg-line" />
                    <span className="text-fluid-xs text-faint">{t('auth.orDivider')}</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                  <a
                    href={demo?.googleEnabled ? `${BASE}/api/auth/citizen/google` : undefined}
                    onClick={(e) => {
                      if (!demo?.googleEnabled) {
                        e.preventDefault();
                        toast.warn('Google sign-in is not configured. Add GOOGLE_CLIENT_ID to api/.env.');
                      }
                    }}
                    className="btn-ghost w-full"
                  >
                    <GoogleMark /> {t('auth.continueGoogle')}
                  </a>
                  <p className="text-center text-fluid-xs text-muted">
                    {t('auth.newHere')}{' '}
                    <Link to="/register" className="font-semibold text-brand hover:underline">
                      {t('auth.createAccount')}
                    </Link>
                  </p>
                </>
              )}
            </form>
          )}

          {/*
            Seeded accounts as one compact row of chips, so a judge never has to
            guess a password and the card still fits a single screen.
          */}
          {relevantDemo.length > 0 && !challenge && (
            <div className="mt-4 border-t border-dashed border-line pt-3 short:mt-3 short:pt-2">
              <p className="text-fluid-xs font-medium text-faint">{t('auth.demoAccounts')}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {relevantDemo.map((account) => (
                  <button
                    key={account.email}
                    type="button"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(demo!.password);
                    }}
                    className="rounded-lg border border-line px-2 py-1 text-fluid-xs font-medium text-muted transition hover:border-brand hover:bg-brand/5 hover:text-brand"
                  >
                    {account.email.split('@')[0]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.4a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.6-5.2 3.6-8.8Z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3a7.2 7.2 0 0 1-10.7-3.8H1.4v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.1 7.1 0 0 1 0-4.6V6.6H1.4a12 12 0 0 0 0 10.8l3.9-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.5-3.5A12 12 0 0 0 1.4 6.6l3.9 3.1A7.2 7.2 0 0 1 12 4.8Z" />
    </svg>
  );
}
