import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// A dynamic import (lazy-loaded portal chunk) can 404 right after a fresh
// deploy replaces the file it was pointing at. Recover with one silent
// reload instead of dumping the user on the ErrorBoundary crash screen —
// the reload picks up the new build's chunk manifest. Keyed by which
// module actually failed (not just "has this tab ever reloaded"), so a tab
// left open across several deploys in a row still recovers from each new
// one instead of the very first reload permanently using up its only
// attempt; a genuinely broken deploy (the *same* module failing again right
// after the reload meant to fix it) still falls through to the crash
// screen instead of looping forever.
window.addEventListener('vite:preloadError', (event) => {
  const failedModule = String(event?.payload ?? 'unknown');
  const key = 'ss_reloaded_after_preload_error';
  if (sessionStorage.getItem(key) === failedModule) return;
  sessionStorage.setItem(key, failedModule);
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Installable PWA for the citizen and driver builds. Registered only in
// production so the dev server is never served from a stale cache.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is a progressive enhancement, never a hard requirement */
    });
  });
}
