import { Route, Routes } from 'react-router-dom';
import {
  BarChart3,
  FileDown,
  LayoutDashboard,
  ScrollText,
  Truck,
  Users,
  MapPinned,
  IdCard,
  Building2,
  PackageCheck,
  Recycle,
} from 'lucide-react';
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
import Companies from './Companies';
import AssignmentOverview from './AssignmentOverview';
import WasteAnalytics from './WasteAnalytics';
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
    { to: '/admin/companies', label: t('admin.nav.companies'), icon: Building2 },
    { to: '/admin/assignments', label: t('admin.nav.assignments'), icon: PackageCheck },
    { to: '/admin/waste-analytics', label: t('admin.nav.wasteAnalytics'), icon: Recycle },
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
        <Route path="companies" element={<Companies />} />
        <Route path="assignments" element={<AssignmentOverview />} />
        <Route path="waste-analytics" element={<WasteAnalytics />} />
        <Route path="analytics" element={<CityAnalytics />} />
        <Route path="feedback" element={<FeedbackAnalytics />} />
        <Route path="compliance" element={<ComplianceExport />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="wards" element={<WardSettings />} />
      </Routes>
    </ConsoleShell>
  );
}
