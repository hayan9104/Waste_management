import { useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, RequireRole } from './lib/auth';
import { I18nProvider } from './lib/i18n';
import { tokenStore } from './lib/api';
import { Toaster } from './components/ui';
import { Chatbot } from './components/Chatbot';
import ErrorBoundary from './components/ErrorBoundary';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';

const Splash = lazy(() => import('./pages/Splash'));
const CitizenPortal = lazy(() => import('./portals/citizen/CitizenPortal'));
const DriverPortal = lazy(() => import('./portals/driver/DriverPortal'));
const OfficerPortal = lazy(() => import('./portals/officer/OfficerPortal'));
const AdminPortal = lazy(() => import('./portals/admin/AdminPortal'));
const AiHealth = lazy(() => import('./pages/AiHealth'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function PortalLoader() {
  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-3">
        <div className="h-10 w-10 animate-spin rounded-full border-3 border-line border-t-brand" />
        <p className="text-fluid-xs font-semibold text-muted">Loading Portal Console…</p>
      </div>
    </div>
  );
}

/** Brief branded boot screen shown on every fresh page load / hard refresh, on every route. */
function BootLoader() {
  return (
    <div className="fixed inset-0 z-[100] flex min-h-dvh w-full flex-col items-center justify-center gap-4 bg-surface">
      <div className="relative flex h-14 w-14 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-brand/20" />
        <img src="/icon.svg" alt="" className="relative h-9 w-9 animate-logo-pop" />
      </div>
      <div className="h-1 w-40 overflow-hidden rounded-full bg-line/60">
        <div className="h-full w-1/2 animate-[boot-bar_0.9s_ease-in-out_infinite] rounded-full bg-brand" />
      </div>
      <style>{`@keyframes boot-bar { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }`}</style>
    </div>
  );
}

/** Google redirects back here with the access token in the query string. */
function GoogleReturn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }
    tokenStore.set('citizen', token);
    navigate('/app', { replace: true });
  }, [params, navigate]);

  return <PortalLoader />;
}

const suspense = (node: React.ReactNode) => (
  <Suspense fallback={<PortalLoader />}>{node}</Suspense>
);

export default function App() {
  // The 3D intro is the front door: every fresh open of '/' (new tab, typed
  // URL, or a hard refresh) replays it — it is not a one-time-per-session gate.
  const [showSplash, setShowSplash] = useState(() => {
    const isRoot = window.location.pathname === '/' || window.location.pathname === '';
    return isRoot;
  });

  // Every other route still gets a brief branded boot screen on a genuine
  // fresh load / hard refresh (client-side navigation never remounts App,
  // so this never re-fires when just clicking around inside the app).
  const [booting, setBooting] = useState(() => !showSplash);

  useEffect(() => {
    if (booting) {
      const timer = setTimeout(() => setBooting(false), 550);
      return () => clearTimeout(timer);
    }
  }, [booting]);

  const handleSplashDone = () => {
    setShowSplash(false);
  };

  if (showSplash) {
    return (
      <Suspense fallback={<div className="min-h-dvh bg-black" />}>
        <Splash onDone={handleSplashDone} />
      </Suspense>
    );
  }

  return (
    <ErrorBoundary>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            {booting && <BootLoader />}
            <Toaster />
            <Chatbot />
            <Routes>
              {/* ---- Public Landing ---- */}
              <Route path="/" element={<Landing />} />

              {/* ---- Citizen portal ---- */}
              <Route
                path="/login"
                element={
                  <AuthProvider portal="citizen">
                    <Login portal="citizen" />
                  </AuthProvider>
                }
              />
              <Route
                path="/register"
                element={
                  <AuthProvider portal="citizen">
                    <Register />
                  </AuthProvider>
                }
              />
              <Route
                path="/auth/google/return"
                element={
                  <AuthProvider portal="citizen">
                    <GoogleReturn />
                  </AuthProvider>
                }
              />
              <Route
                path="/app/*"
                element={
                  <AuthProvider portal="citizen">
                    <RequireRole role="CITIZEN">{suspense(<CitizenPortal />)}</RequireRole>
                  </AuthProvider>
                }
              />

              {/* ---- Driver portal ---- */}
              <Route
                path="/driver/login"
                element={
                  <AuthProvider portal="driver">
                    <Login portal="driver" />
                  </AuthProvider>
                }
              />
              <Route
                path="/driver/*"
                element={
                  <AuthProvider portal="driver">
                    <RequireRole role="DRIVER">{suspense(<DriverPortal />)}</RequireRole>
                  </AuthProvider>
                }
              />

              {/* ---- Officer console ---- */}
              <Route
                path="/officer/login"
                element={
                  <AuthProvider portal="officer">
                    <Login portal="officer" />
                  </AuthProvider>
                }
              />
              <Route
                path="/officer/*"
                element={
                  <AuthProvider portal="officer">
                    <RequireRole role="OFFICER">{suspense(<OfficerPortal />)}</RequireRole>
                  </AuthProvider>
                }
              />

              {/* ---- Super Admin console ---- */}
              <Route
                path="/admin/login"
                element={
                  <AuthProvider portal="admin">
                    <Login portal="admin" />
                  </AuthProvider>
                }
              />
              <Route
                path="/admin/*"
                element={
                  <AuthProvider portal="admin">
                    <RequireRole role="ADMIN">{suspense(<AdminPortal />)}</RequireRole>
                  </AuthProvider>
                }
              />
              {/* Moved out of the admin tab bar — reachable only by URL, still admin-gated. */}
              <Route
                path="/ai.health"
                element={
                  <AuthProvider portal="admin">
                    <RequireRole role="ADMIN">{suspense(<AiHealth />)}</RequireRole>
                  </AuthProvider>
                }
              />

              {/* Catch-all route gracefully navigates to Landing */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </QueryClientProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}
