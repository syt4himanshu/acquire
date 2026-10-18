import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Beneficiaries from './Beneficiaries';
import api from '../../api/axios';

vi.mock('../../api/axios', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  resolvedApiBaseUrl: 'http://localhost:5055',
}));

const sagarRow = {
  name: 'Sagar Deshmukh',
  mobile: '9604686258',
  card_number: 'PDS-DEMO-DHR002-APL-001',
  category: 'APL',
  shop_name: 'Shop One',
  area_name: 'Area One',
  family_size: 2,
};

const otherRow = {
  name: 'Sunita Pawar',
  mobile: '9000000001',
  card_number: 'PDS-REAL-1',
  category: 'BPL',
  shop_name: 'Shop Two',
  area_name: 'Area Two',
  family_size: 3,
};

// Mirrors the backend: `search` narrows the rows, `unfiltered_total` is the count
// before the search term is applied.
const mockApi = ({ rowsForSearch = {}, unfilteredTotal = 2 } = {}) => {
  api.get.mockImplementation((url, config) => {
    if (url !== '/api/admin/beneficiaries') {
      return Promise.resolve({ data: { areas: [], shops: [] } });
    }
    const search = config?.params?.search;
    const data = search ? rowsForSearch[search] || [] : [sagarRow, otherRow];
    return Promise.resolve({
      data: {
        data,
        pagination: {
          page: 1,
          limit: 50,
          total: data.length,
          total_pages: 1,
          unfiltered_total: unfilteredTotal,
        },
      },
    });
  });
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <Beneficiaries />
    </MemoryRouter>,
  );

const beneficiaryCalls = () =>
  api.get.mock.calls.filter(([url]) => url === '/api/admin/beneficiaries');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Admin Beneficiaries page — search', () => {
  it('shows the total without a search term', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('Showing 2 beneficiaries')).toBeInTheDocument();
    expect(beneficiaryCalls().at(-1)[1].params).toEqual({ page: 1, limit: 50 });
  });

  it('sends the search term to the API and shows matches out of the loaded total', async () => {
    const user = userEvent.setup();
    mockApi({ rowsForSearch: { 'Sagar Deshmukh': [sagarRow] } });
    renderPage();
    await screen.findByText('Showing 2 beneficiaries');

    await user.type(screen.getByRole('textbox', { name: 'Search beneficiaries' }), 'Sagar Deshmukh');

    expect(await screen.findByText('Showing 1 of 2 beneficiaries')).toBeInTheDocument();
    expect(beneficiaryCalls().at(-1)[1].params).toEqual({ page: 1, limit: 50, search: 'Sagar Deshmukh' });
    const row = screen.getByText('PDS-DEMO-DHR002-APL-001').closest('tr');
    expect(row).toHaveTextContent('Sagar Deshmukh');
    expect(screen.queryByText('PDS-REAL-1')).not.toBeInTheDocument();
  });

  it('debounces typing so only the settled value is requested', async () => {
    const user = userEvent.setup();
    mockApi({ rowsForSearch: { Sagar: [sagarRow] } });
    renderPage();
    await screen.findByText('Showing 2 beneficiaries');

    await user.type(screen.getByRole('textbox', { name: 'Search beneficiaries' }), 'Sagar');

    await screen.findByText('Showing 1 of 2 beneficiaries');
    const searched = beneficiaryCalls()
      .map(([, config]) => config.params.search)
      .filter(Boolean);
    expect(searched).toEqual(['Sagar']);
  });

  it('shows the empty state when nothing matches', async () => {
    const user = userEvent.setup();
    mockApi({ rowsForSearch: { zzz: [] } });
    renderPage();
    await screen.findByText('Showing 2 beneficiaries');

    await user.type(screen.getByRole('textbox', { name: 'Search beneficiaries' }), 'zzz');

    expect(
      await screen.findByText('No beneficiaries found. Try a different name, mobile number, or card number.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Showing 0 of 2 beneficiaries')).toBeInTheDocument();
  });

  it('shows the clear control only when the input is non-empty and clears the search', async () => {
    const user = userEvent.setup();
    mockApi({ rowsForSearch: { Sagar: [sagarRow] } });
    renderPage();
    await screen.findByText('Showing 2 beneficiaries');

    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();

    const input = screen.getByRole('textbox', { name: 'Search beneficiaries' });
    await user.type(input, 'Sagar');
    await user.click(await screen.findByRole('button', { name: 'Clear search' }));

    expect(input).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    expect(await screen.findByText('Showing 2 beneficiaries')).toBeInTheDocument();
    await waitFor(() => expect(beneficiaryCalls().at(-1)[1].params).toEqual({ page: 1, limit: 50 }));
  });

  it('clears the search when Escape is pressed in the input', async () => {
    const user = userEvent.setup();
    mockApi({ rowsForSearch: { Sagar: [sagarRow] } });
    renderPage();
    await screen.findByText('Showing 2 beneficiaries');

    const input = screen.getByRole('textbox', { name: 'Search beneficiaries' });
    await user.type(input, 'Sagar{Escape}');

    expect(input).toHaveValue('');
    expect(await screen.findByText('Showing 2 beneficiaries')).toBeInTheDocument();
  });

  it('keeps the area, shop and category filters in the request alongside the search', async () => {
    const user = userEvent.setup();
    mockApi({ rowsForSearch: { Sagar: [sagarRow] } });
    renderPage();
    await screen.findByText('Showing 2 beneficiaries');

    await user.selectOptions(screen.getByDisplayValue('All Categories'), 'APL');
    await user.type(screen.getByRole('textbox', { name: 'Search beneficiaries' }), 'Sagar');

    await screen.findByText('Showing 1 of 2 beneficiaries');
    expect(beneficiaryCalls().at(-1)[1].params).toEqual({
      page: 1,
      limit: 50,
      category: 'APL',
      search: 'Sagar',
    });
  });
});
