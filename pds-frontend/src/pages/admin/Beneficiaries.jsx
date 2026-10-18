import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Users, X } from 'lucide-react';
import api from '../../api/axios';
import PanelHeader from '../../design/primitives/PanelHeader';
import Table from '../../components/ui/Table';
import Badge from '../../components/ui/Badge';
import EmptyState from '../../components/ui/EmptyState';
import Input from '../../components/ui/Input';
import Pagination from '../../components/ui/Pagination';
import Select from '../../components/ui/Select';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const COLUMNS = [
  { label: 'Name' },
  { label: 'Mobile' },
  { label: 'Card Number' },
  { label: 'Category' },
  { label: 'Shop' },
  { label: 'Area' },
  { label: 'Family Size', numeric: true },
];

const getCategoryBadgeStatus = (category) => {
  if (category === 'APL') return 'info';
  if (category === 'BPL') return 'warning';
  return 'danger';
};

const Beneficiaries = () => {
  useEffect(() => { document.title = 'Beneficiaries — PDS Supervision'; }, []);

  // Dashboard's category/area donuts navigate here with a filter pre-picked
  // via router state (e.g. clicking the "BPL" slice) — seed the initial
  // filters from it so the list lands already scoped, instead of the admin
  // having to re-pick the same filter that was just clicked.
  const location = useLocation();

  const [beneficiaries, setBeneficiaries] = useState([]);
  const [areas, setAreas] = useState([]);
  const [shops, setShops] = useState([]);
  const [total, setTotal] = useState(0);
  const [scopeTotal, setScopeTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    category: location.state?.category || '',
    area_id: location.state?.area_id || '',
    shop_id: '',
  });
  // searchInput is what the admin is typing; search is the debounced value that
  // actually hits the API.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const fetchFilterData = async () => {
      try {
        const [areasResponse, shopsResponse] = await Promise.all([
          api.get('/api/admin/areas'),
          api.get('/api/admin/shops'),
        ]);

        setAreas(areasResponse.data?.areas || []);
        setShops(shopsResponse.data?.shops || shopsResponse.data?.data || []);
      } catch (fetchError) {
        setError(fetchError.response?.data?.error || 'Failed to load filters');
      }
    };

    fetchFilterData();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let ignore = false;

    const fetchBeneficiaries = async () => {
      setLoading(true);
      setError('');

      try {
        const params = { page, limit: PAGE_SIZE };
        if (filters.category) params.category = filters.category;
        if (filters.area_id) params.area_id = filters.area_id;
        if (filters.shop_id) params.shop_id = filters.shop_id;
        if (search) params.search = search;

        const response = await api.get('/api/admin/beneficiaries', { params });
        if (ignore) return;

        const payload = response.data || {};
        const pagination = payload.pagination || {};
        setBeneficiaries(payload.beneficiaries || payload.data || []);
        setTotal(payload.total || pagination.total || 0);
        setScopeTotal(pagination.unfiltered_total ?? pagination.total ?? 0);
      } catch (fetchError) {
        if (ignore) return;
        setError(fetchError.response?.data?.error || 'Failed to load beneficiaries');
        setBeneficiaries([]);
        setTotal(0);
        setScopeTotal(0);
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    fetchBeneficiaries();

    return () => {
      ignore = true;
    };
  }, [filters, search, page]);

  const setFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const clearSearch = () => {
    setSearchInput('');
    setSearch('');
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PanelHeader title="Beneficiaries" />
      <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <div role="search" className="relative w-full sm:w-80">
          <Input
            type="text"
            aria-label="Search beneficiaries"
            placeholder="Search by name, mobile, or ration card number..."
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searchInput) clearSearch();
            }}
            autoComplete="off"
            spellCheck={false}
            inputClassName="pr-9"
          />
          {searchInput && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-text-secondary transition hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        <Select
          className="w-48"
          value={filters.category}
          onChange={(event) => setFilter('category', event.target.value)}
        >
          <option value="">All Categories</option>
          <option value="APL">APL</option>
          <option value="BPL">BPL</option>
          <option value="AAY">AAY</option>
        </Select>

        <Select
          className="w-48"
          value={filters.area_id}
          onChange={(event) => setFilter('area_id', event.target.value)}
        >
          <option value="">All Areas</option>
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </Select>

        <Select
          className="w-48"
          value={filters.shop_id}
          onChange={(event) => setFilter('shop_id', event.target.value)}
        >
          <option value="">All Shops</option>
          {shops.map((shop) => (
            <option key={shop.id} value={shop.id}>
              {shop.shop_name}
            </option>
          ))}
        </Select>

        <Badge className="self-center" role="status">
          {search ? `Showing ${total} of ${scopeTotal} beneficiaries` : `Showing ${total} beneficiaries`}
        </Badge>
      </div>

      {error && <Badge status="danger">{error}</Badge>}

      <Table footer={<Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}>
        <Table.Head>
          <tr>
            {COLUMNS.map((col) => (
              <Table.Cell header key={col.label} numeric={col.numeric}>
                {col.label}
              </Table.Cell>
            ))}
          </tr>
        </Table.Head>
        <Table.Body>
          {loading ? (
            <Table.LoadingRows rows={6} columns={COLUMNS.length} />
          ) : beneficiaries.length === 0 ? (
            <Table.Empty colSpan={COLUMNS.length}>
              {search ? (
                <EmptyState
                  icon={<Users size={20} />}
                  title="No beneficiaries found. Try a different name, mobile number, or card number."
                />
              ) : (
                <EmptyState icon={<Users size={20} />} title="No beneficiaries found" description="Try adjusting your filters." />
              )}
            </Table.Empty>
          ) : (
            beneficiaries.map((item, index) => (
              <Table.Row key={`${item.card_number}-${index}`}>
                <Table.Cell>
                  {item.name || <span className="italic text-text-secondary">Name unavailable</span>}
                </Table.Cell>
                <Table.Cell>{item.mobile || '—'}</Table.Cell>
                <Table.Cell>{item.card_number}</Table.Cell>
                <Table.Cell>
                  <Badge status={getCategoryBadgeStatus(item.category)}>{item.category}</Badge>
                </Table.Cell>
                <Table.Cell>{item.shop_name}</Table.Cell>
                <Table.Cell>{item.area_name}</Table.Cell>
                <Table.Cell numeric>{item.family_size}</Table.Cell>
              </Table.Row>
            ))
          )}
        </Table.Body>
      </Table>
      </div>
    </>
  );
};

export default Beneficiaries;
