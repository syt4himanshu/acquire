// eslint-disable-next-line no-unused-vars -- JSX compiles to React.createElement
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ADMIN_NAV_SECTIONS } from './adminNav';
import AppShell from '../design/layouts/AppShell';

afterEach(() => {
  cleanup();
});

describe('Admin Dashboard Navigation', () => {
  it('does not contain Wallets or Audit Log in ADMIN_NAV_SECTIONS', () => {
    const allItems = ADMIN_NAV_SECTIONS.flatMap((section) => section.items);
    const labels = allItems.map((item) => item.label);
    const paths = allItems.map((item) => item.to);

    expect(labels).not.toContain('Wallets');
    expect(labels).not.toContain('Audit Log');
    expect(paths).not.toContain('/admin/wallets');
    expect(paths).not.toContain('/admin/audit');
  });

  it('preserves all other required admin navigation items in order', () => {
    const allItems = ADMIN_NAV_SECTIONS.flatMap((section) => section.items);
    const expectedItems = [
      { label: 'Dashboard', to: '/admin' },
      { label: 'Areas', to: '/admin/areas' },
      { label: 'Shops', to: '/admin/shops' },
      { label: 'Ration Cards', to: '/admin/ration-cards' },
      { label: 'Beneficiaries', to: '/admin/beneficiaries' },
      { label: 'Entitlements', to: '/admin/entitlements' },
      { label: 'Dispenses', to: '/admin/dispenses' },
      { label: 'Blockchain', to: '/admin/health/blockchain' },
      { label: 'IoT Fleet', to: '/admin/health/iot' },
      { label: 'Anchor Queue', to: '/admin/health/anchors' },
      { label: 'Anomalies', to: '/admin/anomalies' },
      { label: 'Users & Roles', to: '/admin/settings/users' },
      { label: 'Commodity Tolerances', to: '/admin/settings/tolerances' },
      { label: 'Devices', to: '/admin/settings/devices' },
    ];

    expect(allItems).toHaveLength(expectedItems.length);

    expectedItems.forEach((expected, index) => {
      expect(allItems[index].label).toBe(expected.label);
      expect(allItems[index].to).toBe(expected.to);
      expect(allItems[index].icon).toBeDefined();
    });
  });

  it('renders AppShell with ADMIN_NAV_SECTIONS without Wallets or Audit Log links', () => {
    render(
      <MemoryRouter>
        <AppShell navSections={ADMIN_NAV_SECTIONS}>
          <div>Admin Content</div>
        </AppShell>
      </MemoryRouter>
    );

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav).toBeInTheDocument();

    // Verify Wallets and Audit Log are absent
    expect(screen.queryByRole('link', { name: 'Wallets' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument();

    // Verify all 14 preserved items are rendered as links
    const expectedLabels = [
      'Dashboard',
      'Areas',
      'Shops',
      'Ration Cards',
      'Beneficiaries',
      'Entitlements',
      'Dispenses',
      'Blockchain',
      'IoT Fleet',
      'Anchor Queue',
      'Anomalies',
      'Users & Roles',
      'Commodity Tolerances',
      'Devices',
    ];

    expectedLabels.forEach((label) => {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    });
  });

  it('mobile drawer opens with preserved navigation items and no Wallets or Audit Log', () => {
    render(
      <MemoryRouter>
        <AppShell navSections={ADMIN_NAV_SECTIONS}>
          <div>Admin Content</div>
        </AppShell>
      </MemoryRouter>
    );

    const openButton = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(openButton);

    expect(screen.queryByRole('link', { name: 'Wallets' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Devices' })).toBeInTheDocument();
  });
});
