import {
  LayoutDashboard,
  Store,
  Users,
  ArrowLeftRight,
  CreditCard,
  ClipboardList,
  MapPin,
  Activity,
  Cable,
  Anchor,
  ShieldAlert,
  UserCog,
  SlidersHorizontal,
  Cpu,
} from 'lucide-react';

/**
 * Single source of truth for the admin left-rail navigation, consumed by
 * AppShell's `navSections` prop. Keep this in sync with ADMIN_ROUTE_LABELS
 * below and with IA.md — this file, IA.md, and App.jsx's <Route> paths must
 * never drift from each other.
 */
export const ADMIN_NAV_SECTIONS = [
  {
    title: 'OVERVIEW',
    items: [{ label: 'Dashboard', to: '/admin', icon: LayoutDashboard }],
  },
  {
    title: 'OPERATIONS',
    // Ordered to match the actual provisioning hierarchy (see plan.md Phase
    // 1): an Area must exist before a Shop can be created in it, a Shop
    // before a Ration Card can pick it, a Ration Card before its
    // Beneficiaries exist, Entitlements before a Wallet is funded, and a
    // funded Wallet before a Dispense can draw against it.
    items: [
      { label: 'Areas', to: '/admin/areas', icon: MapPin },
      { label: 'Shops', to: '/admin/shops', icon: Store },
      { label: 'Ration Cards', to: '/admin/ration-cards', icon: CreditCard },
      { label: 'Beneficiaries', to: '/admin/beneficiaries', icon: Users },
      { label: 'Entitlements', to: '/admin/entitlements', icon: ClipboardList },
      { label: 'Dispenses', to: '/admin/dispenses', icon: ArrowLeftRight },
    ],
  },
  {
    title: 'HEALTH',
    items: [
      { label: 'Blockchain', to: '/admin/health/blockchain', icon: Activity },
      { label: 'IoT Fleet', to: '/admin/health/iot', icon: Cable },
      { label: 'Anchor Queue', to: '/admin/health/anchors', icon: Anchor },
    ],
  },
  {
    title: 'INCIDENTS',
    items: [
      { label: 'Anomalies', to: '/admin/anomalies', icon: ShieldAlert },
    ],
  },
  {
    title: 'SETTINGS',
    items: [
      { label: 'Users & Roles', to: '/admin/settings/users', icon: UserCog },
      { label: 'Commodity Tolerances', to: '/admin/settings/tolerances', icon: SlidersHorizontal },
      { label: 'Devices', to: '/admin/settings/devices', icon: Cpu },
    ],
  },
];

/**
 * Flat route -> breadcrumb/section lookup, used to derive the top-bar
 * Breadcrumb and to detect "section changed, reset scroll" in AdminLayout.
 * `path` segments starting with `:` match any value at that position.
 */
export const ADMIN_ROUTE_LABELS = [
  { path: '/admin', section: 'Overview', label: 'Dashboard' },
  { path: '/admin/areas', section: 'Operations', label: 'Areas' },
  { path: '/admin/shops', section: 'Operations', label: 'Shops' },
  {
    path: '/admin/shops/:shopId/live',
    section: 'Operations',
    label: 'Live Weight',
    parentLabel: 'Shops',
    parentPath: '/admin/shops',
  },
  { path: '/admin/ration-cards', section: 'Operations', label: 'Ration Cards' },
  {
    path: '/admin/ration-cards/new',
    section: 'Operations',
    label: 'New ration card',
    parentLabel: 'Ration Cards',
    parentPath: '/admin/ration-cards',
  },
  { path: '/admin/beneficiaries', section: 'Operations', label: 'Beneficiaries' },
  { path: '/admin/entitlements', section: 'Operations', label: 'Entitlements' },
  { path: '/admin/wallets', section: 'Operations', label: 'Wallets' },
  { path: '/admin/dispenses', section: 'Operations', label: 'Dispenses' },
  {
    path: '/admin/dispenses/:id',
    section: 'Operations',
    label: 'Dispense detail',
    parentLabel: 'Dispenses',
    parentPath: '/admin/dispenses',
  },
  { path: '/admin/health/blockchain', section: 'Health', label: 'Blockchain' },
  { path: '/admin/health/iot', section: 'Health', label: 'IoT Fleet' },
  { path: '/admin/health/anchors', section: 'Health', label: 'Anchor Queue' },
  { path: '/admin/anomalies', section: 'Incidents', label: 'Anomalies' },
  { path: '/admin/audit', section: 'Incidents', label: 'Audit Log' },
  { path: '/admin/settings/users', section: 'Settings', label: 'Users & Roles' },
  { path: '/admin/settings/tolerances', section: 'Settings', label: 'Commodity Tolerances' },
  { path: '/admin/settings/devices', section: 'Settings', label: 'Devices' },
];

function pathMatches(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}

function findRouteEntry(pathname) {
  return ADMIN_ROUTE_LABELS.find((entry) => pathMatches(entry.path, pathname));
}

/**
 * Returns Breadcrumb-ready items ({ label, href? }) for the given pathname.
 * Falls back to a single "Admin" crumb for an unmapped path rather than
 * throwing, since a 404/unknown route should still render *something*.
 */
export function getBreadcrumbItems(pathname) {
  const entry = findRouteEntry(pathname);
  if (!entry) return [{ label: 'Admin' }];

  const items = [{ label: entry.section }];
  if (entry.parentLabel) {
    items.push({ label: entry.parentLabel, href: entry.parentPath });
  }
  items.push({ label: entry.label });
  return items;
}

/** Returns the IA section name ("Operations", "Health", ...) for a pathname, or null if unmapped. */
export function getSectionForPath(pathname) {
  return findRouteEntry(pathname)?.section ?? null;
}
