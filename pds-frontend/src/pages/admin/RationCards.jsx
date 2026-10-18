import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, Plus } from 'lucide-react';
import api from '../../api/axios';
import BulkUploadModal from '../../components/admin/BulkUploadModal';
import useToast from '../../components/ui/useToast';
import Table from '../../components/ui/Table';
import Badge from '../../components/ui/Badge';
import EmptyState from '../../components/ui/EmptyState';
import Pagination from '../../components/ui/Pagination';
import Button from '../../components/ui/Button';
import PanelHeader from '../../design/primitives/PanelHeader';

const PAGE_SIZE = 50;

const COLUMNS = [
  { label: 'Card Number' },
  { label: 'Category' },
  { label: 'Head Name' },
  { label: 'Shop' },
  { label: 'Area' },
  { label: 'Family Size', numeric: true },
  { label: 'Rice (kg)', numeric: true },
  { label: 'Wheat (kg)', numeric: true },
];

const getCategoryBadgeStatus = (category) => {
  if (category === 'APL') return 'info';
  if (category === 'BPL') return 'warning';
  return 'danger';
};

const RationCards = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const [rationCards, setRationCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [page, setPage] = useState(1);

  const fetchRationCards = async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/admin/ration-cards');
      setRationCards(response.data?.ration_cards || response.data?.data || []);
      setPage(1);
    } catch (fetchError) {
      toast.danger(fetchError.response?.data?.error || 'Failed to load ration cards');
      setRationCards([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRationCards();
  }, []);

  useEffect(() => {
    document.title = 'Ration Cards — PDS Supervision';
  }, []);

  const totalPages = Math.max(1, Math.ceil(rationCards.length / PAGE_SIZE));
  const pageRows = useMemo(
    () => rationCards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [rationCards, page]
  );

  return (
    <>
      <PanelHeader
        title="Ration Cards"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setBulkOpen(true)}>
              Bulk Upload
            </Button>
            <Button onClick={() => navigate('/admin/ration-cards/new')}>Add Ration Card</Button>
          </div>
        }
      />
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
          ) : rationCards.length === 0 ? (
            <Table.Empty colSpan={COLUMNS.length}>
              <EmptyState
                icon={<CreditCard size={20} />}
                title="No ration cards yet"
                description="Add your first ration card to get started."
                action={
                  <Button variant="primary" onClick={() => navigate('/admin/ration-cards/new')}>
                    <Plus size={16} />
                    Add Ration Card
                  </Button>
                }
              />
            </Table.Empty>
          ) : (
            pageRows.map((card) => (
              <Table.Row key={card.id}>
                <Table.Cell>{card.card_number}</Table.Cell>
                <Table.Cell>
                  <Badge status={getCategoryBadgeStatus(card.category)}>{card.category}</Badge>
                </Table.Cell>
                <Table.Cell>
                  {card.head_name || <span className="italic text-text-secondary">Name unavailable</span>}
                </Table.Cell>
                <Table.Cell>{card.shop_name || '—'}</Table.Cell>
                <Table.Cell>{card.area_name || '—'}</Table.Cell>
                <Table.Cell numeric>{card.family_size ?? '—'}</Table.Cell>
                <Table.Cell numeric>{card.rice_balance_kg ?? '—'}</Table.Cell>
                <Table.Cell numeric>{card.wheat_balance_kg ?? '—'}</Table.Cell>
              </Table.Row>
            ))
          )}
        </Table.Body>
      </Table>
      <BulkUploadModal isOpen={bulkOpen} onClose={() => setBulkOpen(false)} onSuccess={fetchRationCards} />
    </>
  );
};

export default RationCards;
