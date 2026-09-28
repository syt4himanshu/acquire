// eslint-disable-next-line no-unused-vars
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ScanAndDispense from './ScanAndDispense';
import * as api from '../../api/axios';

// Mock the API module
vi.mock('../../api/axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
  resolvedApiBaseUrl: 'http://localhost:5055',
}));

// Mock QRScanner component
vi.mock('../../components/shopkeeper/QRScanner', () => ({
  default: ({ onScan }) => (
    <button onClick={() => onScan(JSON.stringify({
      rationCardId: 'card-123',
      sessionId: 'qr-session-456',
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    }))}>
      Mock Scan QR
    </button>
  ),
}));

// Mock DispenseWeighingPanel component
vi.mock('../../components/shopkeeper/DispenseWeighingPanel', () => ({
  default: ({ onDone, commodity, entitledGrams }) => (
    <div>
      <p>Weighing {commodity}</p>
      <p>Target: {entitledGrams}g</p>
      <button onClick={() => onDone('committed', entitledGrams - 5)}>
        Simulate Committed
      </button>
      <button onClick={() => onDone('cancelled', null)}>
        Simulate Cancelled
      </button>
    </div>
  ),
}));

// Mock useToast
vi.mock('../../components/ui/useToast', () => ({
  default: () => ({
    success: vi.fn(),
    danger: vi.fn(),
    warning: vi.fn(),
  }),
}));

const mockBeneficiaryData = {
  beneficiary: {
    name: 'Test Beneficiary',
    card_number: 'CARD123456',
    category: 'BPL',
    mobile: '9876543210',
    family_size: 4,
    shop_name: 'Test Shop',
    ration_card_id: 'card-123',
  },
  wallet: {
    rice_balance_kg: 3,
    wheat_balance_kg: 2,
  },
  allocation: {
    rice_kg: 3,
    wheat_kg: 2,
    rice_grams: 3000,
    wheat_grams: 2000,
  },
};

const mockDeviceStatus = {
  active: true,
  connectivity: 'online',
  device_id: 'device-001',
};

beforeEach(() => {
  // Mock device status polling
  api.default.get.mockImplementation((url) => {
    if (url === '/api/dispense/device-status') {
      return Promise.resolve({ data: mockDeviceStatus });
    }
    if (url.includes('/api/shopkeeper/beneficiary/')) {
      return Promise.resolve({ data: mockBeneficiaryData });
    }
    return Promise.reject(new Error('Unknown endpoint'));
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderWithRouter = (component) => {
  return render(<MemoryRouter>{component}</MemoryRouter>);
};

describe('ScanAndDispense - Sequential Workflow', () => {
  it('renders scanner initially', () => {
    renderWithRouter(<ScanAndDispense />);
    expect(screen.getByText('Scan & Dispense')).toBeInTheDocument();
    expect(screen.getByText('Mock Scan QR')).toBeInTheDocument();
  });

  it('loads beneficiary after QR scan', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ScanAndDispense />);

    const scanButton = screen.getByText('Mock Scan QR');
    await user.click(scanButton);

    await waitFor(() => {
      expect(screen.getByText('Test Beneficiary')).toBeInTheDocument();
    });

    expect(screen.getByText(/Card: CARD123456/)).toBeInTheDocument();
    expect(screen.getByText('Step 1: Rice Weighing (3 kg)')).toBeInTheDocument();
    expect(screen.getByText('Step 2: Wheat Weighing (2 kg)')).toBeInTheDocument();
  });

  it('shows IoT scale status badge', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));

    await waitFor(() => {
      expect(screen.getByText('IoT Scale')).toBeInTheDocument();
    });

    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('disables wheat button until rice is completed', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));

    await waitFor(() => {
      expect(screen.getByText('Step 1: Rice Weighing (3 kg)')).toBeInTheDocument();
    });

    const riceButton = screen.getByRole('button', { name: /Weigh Rice/i });
    const wheatButton = screen.getByRole('button', { name: /Weigh Wheat/i });

    expect(riceButton).not.toBeDisabled();
    expect(wheatButton).toBeDisabled();
    expect(wheatButton).toHaveAttribute('title', 'Complete Rice weighing first');
  });

  it('starts rice weighing session when Weigh Rice is clicked', async () => {
    const user = userEvent.setup();
    api.default.post.mockImplementation((url) => {
      if (url === '/api/dispense/session') {
        return Promise.resolve({
          data: {
            session_id: 'rice-session-789',
            session_jwt: 'mock-jwt-token',
            tolerance_grams: 30,
          },
        });
      }
      if (url.includes('/attach')) {
        return Promise.resolve({ data: { session_id: 'rice-session-789' } });
      }
      return Promise.reject(new Error('Unknown endpoint'));
    });

    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Weigh Rice/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Weigh Rice/i }));

    await waitFor(() => {
      expect(api.default.post).toHaveBeenCalledWith('/api/dispense/session', {
        ration_card_id: 'card-123',
        commodity: 'rice',
        entitled_grams: 3000,
        qr_session_id: 'qr-session-456',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Weighing rice')).toBeInTheDocument();
      expect(screen.getByText('Target: 3000g')).toBeInTheDocument();
    });
  });

  it('records measured grams and shows verified badge after rice is committed', async () => {
    const user = userEvent.setup();
    api.default.post.mockResolvedValue({
      data: {
        session_id: 'rice-session-789',
        session_jwt: 'mock-jwt',
        tolerance_grams: 30,
      },
    });

    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Weigh Rice/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Weigh Rice/i }));

    await waitFor(() => {
      expect(screen.getByText('Simulate Committed')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Simulate Committed'));

    await waitFor(() => {
      expect(screen.getByText(/✓ Measured: 2995 g/)).toBeInTheDocument();
    });

    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('enables wheat button after rice is verified', async () => {
    const user = userEvent.setup();
    api.default.post.mockResolvedValue({
      data: {
        session_id: 'session-id',
        session_jwt: 'mock-jwt',
        tolerance_grams: 30,
      },
    });

    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));
    await user.click(await screen.findByRole('button', { name: /Weigh Rice/i }));
    await user.click(await screen.findByText('Simulate Committed'));

    await waitFor(() => {
      const wheatButton = screen.getByRole('button', { name: /Weigh Wheat/i });
      expect(wheatButton).not.toBeDisabled();
    });
  });

  it('shows transaction summary card when both commodities are weighed', async () => {
    const user = userEvent.setup();
    api.default.post.mockResolvedValue({
      data: { session_id: 'session', session_jwt: 'jwt', tolerance_grams: 30 },
    });

    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));

    // Complete rice
    await user.click(await screen.findByRole('button', { name: /Weigh Rice/i }));
    await user.click(await screen.findByText('Simulate Committed'));

    // Complete wheat
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Weigh Wheat/i })).not.toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: /Weigh Wheat/i }));
    await user.click(await screen.findByText('Simulate Committed'));

    await waitFor(() => {
      expect(screen.getByText('Transaction Summary')).toBeInTheDocument();
    });

    // Check within the transaction summary card
    const summaryCard = screen.getByText('Transaction Summary').closest('div');
    expect(summaryCard).toHaveTextContent('2995 g');
    expect(summaryCard).toHaveTextContent('1995 g');
  });

  it('disables Complete Transaction button until both commodities are weighed', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));

    await waitFor(() => {
      const completeButton = screen.getByRole('button', { name: /Complete Transaction/i });
      expect(completeButton).toBeDisabled();
    });
  });

  it('enables Complete Transaction button when both commodities are verified', async () => {
    const user = userEvent.setup();
    api.default.post.mockResolvedValue({
      data: { session_id: 'session', session_jwt: 'jwt', tolerance_grams: 30 },
    });

    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));
    await user.click(await screen.findByRole('button', { name: /Weigh Rice/i }));
    await user.click(await screen.findByText('Simulate Committed'));
    await user.click(await screen.findByRole('button', { name: /Weigh Wheat/i }));
    await user.click(await screen.findByText('Simulate Committed'));

    await waitFor(() => {
      const completeButton = screen.getByRole('button', { name: /Complete Transaction/i });
      expect(completeButton).not.toBeDisabled();
    });
  });

  it('shows confirmation modal with measured grams when Complete Transaction is clicked', async () => {
    const user = userEvent.setup();
    api.default.post.mockResolvedValue({
      data: { session_id: 'session', session_jwt: 'jwt', tolerance_grams: 30 },
    });

    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));
    await user.click(await screen.findByRole('button', { name: /Weigh Rice/i }));
    await user.click(await screen.findByText('Simulate Committed'));
    await user.click(await screen.findByRole('button', { name: /Weigh Wheat/i }));
    await user.click(await screen.findByText('Simulate Committed'));
    await user.click(await screen.findByRole('button', { name: /Complete Transaction/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Confirm Transaction/i })).toBeInTheDocument();
    });

    expect(screen.getByText(/2995 g \(3 kg\)/)).toBeInTheDocument();
    expect(screen.getByText(/1995 g \(2 kg\)/)).toBeInTheDocument();
  });

  it('calls dispense API with both session IDs when transaction is confirmed', async () => {
    const user = userEvent.setup();
    let sessionCounter = 0;
    api.default.post.mockImplementation((url, data) => {
      if (url === '/api/dispense/session') {
        sessionCounter++;
        return Promise.resolve({
          data: {
            session_id: `session-${sessionCounter}`,
            session_jwt: 'jwt',
            tolerance_grams: 30,
          },
        });
      }
      if (url.includes('/attach')) {
        return Promise.resolve({ data: {} });
      }
      if (url === '/api/shopkeeper/dispense') {
        return Promise.resolve({
          data: {
            transaction: { id: 'tx-123', created_at: new Date().toISOString() },
            dispensed: { rice_qty_kg: 3, wheat_qty_kg: 2 },
            remaining_wallet: { rice_balance_kg: 0, wheat_balance_kg: 0 },
          },
        });
      }
      return Promise.reject(new Error('Unknown endpoint'));
    });

    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));
    await user.click(await screen.findByRole('button', { name: /Weigh Rice/i }));
    await user.click(await screen.findByText('Simulate Committed'));
    await user.click(await screen.findByRole('button', { name: /Weigh Wheat/i }));
    await user.click(await screen.findByText('Simulate Committed'));
    await user.click(await screen.findByRole('button', { name: /Complete Transaction/i }));

    const confirmButton = await screen.findByRole('button', { name: /Confirm & Complete/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.default.post).toHaveBeenCalledWith('/api/shopkeeper/dispense', {
        ration_card_id: 'card-123',
        session_id: 'qr-session-456',
        rice_session_id: 'session-1',
        wheat_session_id: 'session-2',
        rice_qty_kg: 3,
        wheat_qty_kg: 2,
      });
    });
  });

  it('shows success modal with beneficiary name, measured grams, and transaction ID', async () => {
    const user = userEvent.setup();
    let sessionCounter = 0;
    api.default.post.mockImplementation((url) => {
      if (url === '/api/dispense/session') {
        sessionCounter++;
        return Promise.resolve({
          data: { session_id: `session-${sessionCounter}`, session_jwt: 'jwt', tolerance_grams: 30 },
        });
      }
      if (url.includes('/attach')) {
        return Promise.resolve({ data: {} });
      }
      if (url === '/api/shopkeeper/dispense') {
        return Promise.resolve({
          data: {
            transaction: { id: 'tx-success-123', created_at: new Date().toISOString() },
            dispensed: { rice_qty_kg: 3, wheat_qty_kg: 2 },
            remaining_wallet: { rice_balance_kg: 0, wheat_balance_kg: 0 },
          },
        });
      }
      return Promise.reject(new Error('Unknown'));
    });

    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));
    await user.click(await screen.findByRole('button', { name: /Weigh Rice/i }));
    await user.click(await screen.findByText('Simulate Committed'));
    await user.click(await screen.findByRole('button', { name: /Weigh Wheat/i }));
    await user.click(await screen.findByText('Simulate Committed'));
    await user.click(await screen.findByRole('button', { name: /Complete Transaction/i }));
    await user.click(await screen.findByRole('button', { name: /Confirm & Complete/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Transaction Completed/i })).toBeInTheDocument();
    });

    expect(screen.getByText('Test Beneficiary')).toBeInTheDocument();
    expect(screen.getByText(/2995 g/)).toBeInTheDocument();
    expect(screen.getByText(/1995 g/)).toBeInTheDocument();
    expect(screen.getByText(/ID: tx-success-123/)).toBeInTheDocument();
    expect(screen.getByText(/Blockchain: Anchoring initiated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scan Next Beneficiary/i })).toBeInTheDocument();
  });

  it('does not show success modal if transaction API fails', async () => {
    const user = userEvent.setup();
    api.default.post.mockImplementation((url) => {
      if (url === '/api/dispense/session') {
        return Promise.resolve({
          data: { session_id: 'session', session_jwt: 'jwt', tolerance_grams: 30 },
        });
      }
      if (url.includes('/attach')) {
        return Promise.resolve({ data: {} });
      }
      if (url === '/api/shopkeeper/dispense') {
        return Promise.reject({ response: { data: { error: 'Insufficient balance' } } });
      }
      return Promise.reject(new Error('Unknown'));
    });

    renderWithRouter(<ScanAndDispense />);

    await user.click(screen.getByText('Mock Scan QR'));
    await user.click(await screen.findByRole('button', { name: /Weigh Rice/i }));
    await user.click(await screen.findByText('Simulate Committed'));
    await user.click(await screen.findByRole('button', { name: /Weigh Wheat/i }));
    await user.click(await screen.findByText('Simulate Committed'));
    await user.click(await screen.findByRole('button', { name: /Complete Transaction/i }));
    await user.click(await screen.findByRole('button', { name: /Confirm & Complete/i }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Transaction Completed/i })).not.toBeInTheDocument();
    });
  });
});
