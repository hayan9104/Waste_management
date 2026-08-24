import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Menu, X, ChevronLeft, User, Settings, Shield, Sparkles, Navigation, Globe, Moon, Sun, Check } from 'lucide-react';
import { useAuth, LOGIN_ROUTE, type SessionUser } from '../lib/auth';
import { LanguageSwitcher, ThemeToggle, useTheme } from './ui';
import { SpotlightNav, type SpotlightNavItem } from './SpotlightNav';
import { useT, useI18n, LOCALES, LOCALE_LIST } from '../lib/i18n';
import { initials } from '../lib/format';
import { assetUrl } from '../lib/api';

/** Real photo when uploaded, otherwise the colored-initials circle. Shared by every header account button and the account modal. */
function AccountAvatar({ user, fallbackColor, className }: { user: SessionUser | null; fallbackColor: string; className: string }) {
  if (user?.avatarUrl) {
    return <img src={assetUrl(user.avatarUrl)} alt="" className={`${className} object-cover`} />;
  }
  return (
    <span className={`grid place-items-center font-bold text-white ${className}`} style={{ background: user?.avatarColor || fallbackColor }}>
      {initials(user?.name)}
    </span>
  );
}

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: number;
}

/**
 * MobileShell — Citizen and Driver.
 * Equipped with SpotlightNavbar (interactive mouse spotlight + active ambience beam)
 * across desktop & tablet, with clean thumb-bar on mobile phones.
 */
export function MobileShell({
  nav,
  title,
  children,
  headerRight,
  accent = 'brand',
}: {
  nav: NavItem[];
  title: string;
  children: ReactNode;
  headerRight?: ReactNode;
  accent?: 'brand' | 'orange';
}) {
  const { user, signOut, portal } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh bg-surface pt-[calc(4rem+env(safe-area-inset-top))] pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-10">
      {/* Top Navbar — fixed, same 4rem height on every portal and the landing page. */}
      <header className="fixed inset-x-0 top-0 z-40 h-[calc(4rem+env(safe-area-inset-top))] border-b border-line bg-surface/95 pt-[env(safe-area-inset-top)] shadow-xs backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-2 px-3 sm:gap-4 sm:px-6 lg:px-8 xl:px-10">
          {/* Logo & Portal Title */}
          <div className="flex min-w-0 items-center gap-3">
            <Link
              to={user?.role === 'DRIVER' ? '/driver' : '/app'}
              className="group flex min-w-0 items-center gap-2 transition"
            >
              <img src="/icon.svg" alt="Safaai Sarathi" className="h-8 w-8 shrink-0 animate-logo-pop sm:h-9 sm:w-9" />
              <div className="flex min-w-0 flex-col leading-none">
                <span className="whitespace-nowrap text-fluid-sm font-extrabold leading-tight tracking-tight text-ink">
                  Safaai <span className={accent === 'orange' ? 'text-orange-600 dark:text-orange-400' : 'text-brand'}>Sarathi</span>
                </span>
                <span
                  className={`mt-0.5 inline-block whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.14em] sm:text-[11px] ${
                    accent === 'orange' ? 'text-orange-600/90 dark:text-orange-400/90' : 'text-brand/90'
                  }`}
                >
                  {title}
                </span>
              </div>
            </Link>
          </div>

          {/* Inline nav from lg only. At the old md breakpoint five icon+label
              pills plus the brand mark and the right-hand controls needed more
              than 768px, so the nav overlapped the logo and pushed the account
              button off the edge; a tablet keeps the bottom tab bar instead. */}
          <div className="hidden lg:flex items-center justify-center">
            <SpotlightNav items={nav} accent={accent} />
          </div>

          {/* Right Header Actions.
              Below md the language + theme controls collapse into the account
              sheet — three separate pills plus the logo simply do not fit a
              360px phone without the brand mark wrapping onto two lines. */}
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
            {headerRight}
            <div className="hidden items-center gap-2.5 md:flex">
              <LanguageSwitcher compact />
              <ThemeToggle />
            </div>
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="flex shrink-0 items-center gap-2 rounded-xl border border-line bg-elevated p-1.5 transition hover:bg-sunken shadow-xs cursor-pointer lg:pr-3"
              aria-label="Account, language and theme menu"
            >
              <AccountAvatar
                user={user}
                fallbackColor={accent === 'orange' ? '#ea580c' : '#15803d'}
                className="h-7 w-7 shrink-0 rounded-lg text-fluid-xs shadow-xs"
              />
              <span className="hidden lg:block text-fluid-xs font-semibold text-ink max-w-[110px] truncate">
                {user?.name?.split(' ')[0]}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 xl:px-10">{children}</main>

      {/* Bottom tabs — Mobile & Tablet only */}
      <nav className="tabbar lg:hidden" aria-label="Primary">
        {nav.slice(0, 5).map((item) => {
          const active = item.end ? location.pathname === item.to : location.pathname.startsWith(item.to);
          return (
            <Link key={item.to} to={item.to} className="tabbar-item" data-active={active}>
              <span className="relative">
                <item.icon className="h-5 w-5" />
                {item.badge ? (
                  <span className="absolute -right-2 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[0.6rem] font-bold text-white">
                    {item.badge > 9 ? '9+' : item.badge}
                  </span>
                ) : null}
              </span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <AccountModal
        isOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
        user={user}
        signOut={signOut}
        navigate={navigate}
        t={t}
        portalPath={user?.role === 'DRIVER' ? '/driver' : '/app'}
        loginRoute={LOGIN_ROUTE[portal]}
      />
    </div>
  );
}

/**
 * ConsoleShell — Officer and Admin.
 * Equipped with SpotlightNavbar with Green accent for Officer and Orange accent for Super Admin.
 */
export function ConsoleShell({
  nav,
  title,
  subtitle,
  children,
  headerRight,
  accent = 'brand',
}: {
  nav: NavItem[];
  title: string;
  subtitle?: string;
  children: ReactNode;
  headerRight?: ReactNode;
  accent?: 'brand' | 'orange';
}) {
  const { user, signOut, portal } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
    setMobileNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-dvh bg-surface pt-[calc(4rem+env(safe-area-inset-top))] pb-12">
      {/* Top Navbar — fixed, same 4rem height on every portal and the landing page. */}
      <header className="fixed inset-x-0 top-0 z-40 h-[calc(4rem+env(safe-area-inset-top))] border-b border-line bg-surface/95 pt-[env(safe-area-inset-top)] shadow-xs backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-2 px-3 sm:gap-4 sm:px-6 lg:px-8 xl:px-10">
          {/* Logo & Console Title */}
          <div className="flex min-w-0 shrink items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-line lg:hidden text-ink cursor-pointer"
              aria-label="Open Navigation"
            >
              <Menu className="h-5 w-5" />
            </button>

            <Link
              to={accent === 'orange' ? '/admin' : '/officer'}
              className="group flex min-w-0 shrink items-center gap-2 transition"
            >
              <img src="/icon.svg" alt="Safaai Sarathi" className="h-8 w-8 shrink-0 animate-logo-pop sm:h-9 sm:w-9" />
              <div className="flex min-w-0 flex-col leading-none">
                <span className="whitespace-nowrap text-fluid-sm font-extrabold leading-tight tracking-tight text-ink">
                  Safaai <span className={accent === 'orange' ? 'text-orange-600 dark:text-orange-400' : 'text-brand'}>Sarathi</span>
                </span>
                <span
                  className={`mt-0.5 inline-block whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.14em] sm:text-[11px] ${
                    accent === 'orange' ? 'text-orange-600/90 dark:text-orange-400/90' : 'text-brand/90'
                  }`}
                >
                  {title}
                </span>
              </div>
            </Link>
          </div>

          {/* Desktop Interactive Spotlight Navigation Bar — full icon+label pills.
              7-8 tabs plus the logo and account controls genuinely don't fit
              until 2xl (1536px); at xl they used to fall back to a silent
              horizontal scrollbar, which read as broken rather than as a
              fallback. Below 2xl the hamburger drawer (below) carries
              navigation instead — a vertical list has no width limit to run
              into. */}
          <div className="hidden min-w-0 flex-1 items-center justify-center lg:flex">
            <SpotlightNav items={nav} accent={accent} className="shrink-0" compactUntil2xl />
          </div>

          {/* Right Header Actions — language + theme fold into the account
              sheet below md, same as the citizen/driver shell. */}
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
            {headerRight}
            <div className="hidden items-center gap-2.5 md:flex">
              <LanguageSwitcher compact />
              <ThemeToggle />
            </div>
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="flex shrink-0 items-center gap-2 rounded-xl border border-line bg-elevated p-1.5 transition hover:bg-sunken shadow-xs cursor-pointer lg:pr-3"
              aria-label="Account, language and theme menu"
            >
              <AccountAvatar
                user={user}
                fallbackColor={accent === 'orange' ? '#ea580c' : '#15803d'}
                className="h-7 w-7 shrink-0 rounded-lg text-fluid-xs shadow-xs"
              />
              <span className="hidden lg:block text-fluid-xs font-semibold text-ink max-w-[110px] truncate">
                {user?.name?.split(' ')[0]}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Drawer Navigation for Tablet / Mobile */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 2xl:hidden">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="relative w-64 max-w-[80vw] h-full bg-elevated border-r border-line p-4 space-y-4 animate-slide-in flex flex-col">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <img src="/icon.svg" alt="" className="h-7 w-7 animate-logo-pop" />
                <span className="font-bold text-fluid-sm text-ink">{title}</span>
              </div>
              <button onClick={() => setMobileNavOpen(false)} className="p-1 text-muted hover:bg-sunken rounded-lg cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>

            <nav className="space-y-1 flex-1 overflow-y-auto">
              {nav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setMobileNavOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-fluid-sm font-semibold transition ${
                      isActive
                        ? accent === 'orange'
                          ? 'bg-orange-600 text-white shadow-sm font-bold'
                          : 'bg-brand text-brand-ink shadow-sm font-bold'
                        : 'text-muted hover:bg-sunken hover:text-ink'
                    }`
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {item.badge ? (
                    <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[0.65rem] font-bold text-white">
                      {item.badge}
                    </span>
                  ) : null}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 xl:px-10">{children}</main>

      <AccountModal
        isOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
        user={user}
        signOut={signOut}
        navigate={navigate}
        t={t}
        portalPath={accent === 'orange' ? '/admin' : '/officer'}
        loginRoute={LOGIN_ROUTE[portal]}
      />
    </div>
  );
}

export function BackLink({ to, label }: { to: string; label?: string }) {
  const t = useT();
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-fluid-xs font-semibold text-muted transition hover:bg-sunken hover:text-ink"
    >
      <ChevronLeft className="h-4 w-4" />
      {label ?? t('common.back')}
    </Link>
  );
}

/**
 * Language + theme, laid out as full-width rows for the account sheet. On a
 * phone the header has room for the brand mark and one control, so these two
 * move down here rather than being squeezed into 28px pills up top.
 */
function MobilePreferences() {
  const { locale, setLocale, t } = useI18n();
  const { dark, toggle } = useTheme();

  return (
    <div className="space-y-3 rounded-2xl border border-line bg-surface p-3">
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-faint">
          <Globe className="h-3.5 w-3.5" /> {t('common.language')}
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          {LOCALE_LIST.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLocale(code)}
              className={`flex min-h-touch items-center justify-center gap-1 rounded-xl border px-2 text-fluid-xs font-semibold transition ${
                locale === code
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-line bg-elevated text-muted hover:bg-sunken hover:text-ink'
              }`}
            >
              {locale === code && <Check className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{LOCALES[code].native}</span>
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={toggle}
        className="flex min-h-touch w-full items-center justify-between gap-3 rounded-xl border border-line bg-elevated px-3 text-fluid-xs font-semibold text-ink transition hover:bg-sunken"
      >
        <span className="flex items-center gap-2">
          {dark ? <Sun className="h-4 w-4 text-warn" /> : <Moon className="h-4 w-4 text-muted" />}
          {dark ? t('common.lightMode') : t('common.darkMode')}
        </span>
        <span
          aria-hidden
          className={`relative h-5 w-9 shrink-0 rounded-full transition ${dark ? 'bg-brand' : 'bg-line'}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
              dark ? 'left-[1.125rem]' : 'left-0.5'
            }`}
          />
        </span>
      </button>
    </div>
  );
}

function AccountModal({
  isOpen,
  onClose,
  user,
  signOut,
  navigate,
  t,
  portalPath,
  loginRoute,
}: {
  isOpen: boolean;
  onClose: () => void;
  user: any;
  signOut: () => Promise<void>;
  navigate: (to: string) => void;
  t: (key: string) => string;
  portalPath: string;
  loginRoute: string;
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[92dvh] w-full max-w-sm overflow-y-auto rounded-t-3xl border border-line bg-elevated p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl animate-sheet-up sm:rounded-2xl sm:pb-5 sm:animate-fade-up">
        <div className="flex items-center justify-between pb-3 border-b border-line">
          <h2 className="text-fluid-base font-bold text-ink">{t('common.account') || 'Account'}</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-xl border border-line text-muted transition hover:bg-sunken hover:text-ink cursor-pointer">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <AccountAvatar user={user} fallbackColor="#15803d" className="h-12 w-12 shrink-0 rounded-2xl text-fluid-base shadow-sm" />
          <div className="min-w-0 flex-1">
            <p className="font-bold text-fluid-sm text-ink truncate">{user?.name}</p>
            <p className="text-fluid-xs text-muted truncate">{user?.email || user?.phone}</p>
            <span className="inline-block mt-0.5 rounded-md bg-brand/10 px-2 py-0.5 text-[10px] font-bold text-brand uppercase tracking-wider">
              {user?.role}
            </span>
          </div>
        </div>

        {/* The header only carries these from md up; on a phone this sheet is
            where language and theme live, so the top bar stays uncluttered. */}
        <div className="mt-5 md:hidden">
          <MobilePreferences />
        </div>

        <div className="mt-5 space-y-2">
          {user?.role === 'CITIZEN' && (
            <button
              onClick={() => {
                onClose();
                navigate('/app/profile');
              }}
              className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface p-2.5 text-fluid-xs font-semibold text-ink transition hover:bg-sunken cursor-pointer"
            >
              <User className="h-4 w-4 text-muted" />
              <span>Edit Profile & Language</span>
            </button>
          )}

          <button
            onClick={async () => {
              onClose();
              await signOut();
              navigate(loginRoute);
            }}
            className="flex w-full items-center gap-2.5 rounded-xl border border-danger/30 bg-danger/10 p-2.5 text-fluid-xs font-semibold text-danger transition hover:bg-danger/20 cursor-pointer"
          >
            <LogOut className="h-4 w-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
