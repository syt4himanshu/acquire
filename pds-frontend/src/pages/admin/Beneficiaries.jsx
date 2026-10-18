import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Users } from 'lucide-react';
import api from '../../api/axios';
import PanelHeader from '../../design/primitives/PanelHeader';
import Table from '../../components/ui/Table';
import Badge from '../../components/ui/Badge';
import EmptyState from '../../components/ui/EmptyState';
import Pagination from '../../components/ui/Pagination';
import Select from '../../components/ui/Select';

const PAGE_SIZE = 50;

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    category: location.state?.category || '',
    area_id: location.state?.area_id || '',
    shop_id: '',
  });

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
    const fetchBeneficiaries = async () => {
      setLoading(true);
      setError('');

      try {
        const params = {};
        if (filters.category) params.category = filters.category;
        if (filters.area_id) params.area_id = filters.area_id;
        if (filters.shop_id) params.shop_id = filters.shop_id;

        const response = await api.get('/api/admin/beneficiaries', { params });
        const payload = response.data || {};
        setBeneficiaries(payload.beneficiaries || payload.data || []);
        setTotal(payload.total || payload.pagination?.total || 0);
        setPage(1);
      } catch (fetchError) {
        setError(fetchError.response?.data?.error || 'Failed to load beneficiaries');
        setBeneficiaries([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    };

    fetchBeneficiaries();
  }, [filters]);

  const totalPages = Math.max(1, Math.ceil(beneficiaries.length / PAGE_SIZE));
  const pageRows = useMemo(
    () => beneficiaries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [beneficiaries, page]
  );

  return (
    <>
      <PanelHeader title="Beneficiaries" />
      <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Select
          className="w-48"
          value={filters.category}
          onChange={(event) => setFilters((prev) => ({ ...prev, category: event.target.value }))}
        >
          <option value="">All Categories</option>
          <option value="APL">APL</option>
          <option value="BPL">BPL</option>
          <option value="AAY">AAY</option>
        </Select>

        <Select
          className="w-48"
          value={filters.area_id}
          onChange={(event) => setFilters((prev) => ({ ...prev, area_id: event.target.value }))}
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
          onChange={(event) => setFilters((prev) => ({ ...prev, shop_id: event.target.value }))}
        >
          <option value="">All Shops</option>
          {shops.map((shop) => (
            <option key={shop.id} value={shop.id}>
              {shop.shop_name}
            </option>
          ))}
        </Select>

        <Badge className="self-center">Showing {total} beneficiaries</Badge>
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
              <EmptyState icon={<Users size={20} />} title="No beneficiaries found" description="Try adjusting your filters." />
            </Table.Empty>
          ) : (
            pageRows.map((item, index) => (
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
