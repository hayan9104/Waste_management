import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// A dynamic import (lazy-loaded portal chunk) can 404 right after a fresh
// deploy replaces the file it was pointing at. Recover with one silent
// reload instead of dumping the user on the ErrorBoundary crash screen —
// the reload picks up the new build's chunk manifest. Guarded so a
// genuinely broken deploy still surfaces the crash screen rather than
// reload-looping forever.
window.addEventListener('vite:preloadError', () => {
  const key = 'ss_reloaded_after_preload_error';
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, '1');
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
