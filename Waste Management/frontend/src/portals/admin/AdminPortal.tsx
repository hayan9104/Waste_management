import { Route, Routes } from 'react-router-dom';
import { BarChart3, FileDown, LayoutDashboard, ScrollText, Truck, Users, MapPinned, IdCard } from 'lucide-react';
import { ConsoleShell, type NavItem } from '../../components/shells';
import { useT } from '../../lib/i18n';
import AdminDashboard from './Dashboard';
import MasterFleet from './MasterFleet';
import UserManagement from './UserManagement';
import CityAnalytics from './CityAnalytics';
import ComplianceExport from './ComplianceExport';
import AuditLog from './AuditLog';
import WardSettings from './WardSettings';
import WardDrivers from './WardDrivers';
import FeedbackAnalytics from './FeedbackAnalytics';

/**
 * Shared by AdminPortal and the standalone /ai.health page, so both consoles
 * show the same tab bar minus whichever page isn't in it.
 */
export function useAdminNav(): NavItem[] {
  const t = useT();
  return [
    { to: '/admin', label: t('admin.nav.dashboard'), icon: LayoutDashboard, end: true },
    { to: '/admin/fleet', label: t('admin.nav.fleet'), icon: Truck },
    { to: '/admin/ward-drivers', label: t('admin.nav.wardDrivers'), icon: IdCard },
    { to: '/admin/users', label: t('admin.nav.users'), icon: Users },
    { to: '/admin/analytics', label: t('admin.nav.analytics'), icon: BarChart3 },
    { to: '/admin/feedback', label: 'Citizen Feedback', icon: Users },
    { to: '/admin/compliance', label: t('admin.nav.compliance'), icon: FileDown },
    { to: '/admin/audit', label: t('admin.nav.audit'), icon: ScrollText },
    { to: '/admin/wards', label: t('admin.nav.wards'), icon: MapPinned },
  ];
}

export default function AdminPortal() {
  const t = useT();
  const nav = useAdminNav();

  return (
    <ConsoleShell
      nav={nav}
      title={t('admin.title')}
      subtitle={t('admin.subtitle')}
      accent="orange"
    >
      <Routes>
        <Route index element={<AdminDashboard />} />
        <Route path="fleet" element={<MasterFleet />} />
        <Route path="ward-drivers" element={<WardDrivers />} />
        <Route path="users" element={<UserManagement />} />
        <Route path="analytics" element={<CityAnalytics />} />
        <Route path="feedback" element={<FeedbackAnalytics />} />
        <Route path="compliance" element={<ComplianceExport />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="wards" element={<WardSettings />} />
      </Routes>
    </ConsoleShell>
  );
}
