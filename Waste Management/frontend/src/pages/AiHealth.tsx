import { BackLink } from '../components/shells';
import ModelHealth from '../portals/admin/ModelHealth';

/**
 * Standalone page at /ai.health — no console shell, no tab bar, just a way
 * back to the admin dashboard. Only reachable by URL, still gated behind
 * the admin login like every other admin surface.
 */
export default function AiHealth() {
  return (
    <div className="min-h-dvh bg-surface">
      <div className="mx-auto w-full max-w-[1440px] px-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 lg:px-8 xl:px-10">
        <BackLink to="/admin" />
      </div>
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 xl:px-10">
        <ModelHealth />
      </main>
    </div>
  );
}
