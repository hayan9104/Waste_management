import { ConsoleShell } from '../components/shells';
import { useAdminNav } from '../portals/admin/AdminPortal';
import ModelHealth from '../portals/admin/ModelHealth';
import { useT } from '../lib/i18n';

/**
 * Standalone page at /ai.health — deliberately not in the admin tab bar
 * (see useAdminNav), only reachable by URL, still gated behind the admin
 * login like every other admin surface.
 */
export default function AiHealth() {
  const t = useT();
  const nav = useAdminNav();

  return (
    <ConsoleShell nav={nav} title={t('admin.title')} subtitle={t('admin.subtitle')} accent="orange">
      <ModelHealth />
    </ConsoleShell>
  );
}
