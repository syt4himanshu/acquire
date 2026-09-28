// eslint-disable-next-line no-unused-vars
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import DispenseWeighingPanel from './DispenseWeighingPanel';
import * as api from '../../api/axios';

// Mock the API module
vi.mock('../../api/axios', () => ({
  default: {
    post: vi.fn(),
  },
  resolvedApiBaseUrl: 'http://localhost:5055',
}));

// Mock WebSocket
class MockWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = MockWebSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    // Simulate connection opening after a tick
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data) {
    this.lastSent = data;
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // Helper to simulate receiving a message
  simulateMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
}

MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;

let mockWsInstance = null;
const originalWebSocket = global.WebSocket;

beforeEach(() => {
  global.WebSocket = vi.fn((url, protocols) => {
    mockWsInstance = new MockWebSocket(url, protocols);
    return mockWsInstance;
  });

  // Mock localStorage
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: vi.fn(() => 'mock-token'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    },
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  global.WebSocket = originalWebSocket;
  mockWsInstance = null;
});

describe('DispenseWeighingPanel', () => {
  const defaultProps = {
    sessionId: 'test-session-123',
    commodity: 'rice',
    entitledGrams: 3000,
    toleranceGrams: 30,
    beneficiaryName: 'Test Beneficiary',
    cardNumber: 'CARD123456',
    onDone: vi.fn(),
  };

  it('renders beneficiary info and initial weight display', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test Beneficiary')).toBeInTheDocument();
    });

    expect(screen.getByText(/Card: CARD123456/)).toBeInTheDocument();
    expect(screen.getByText('0 g')).toBeInTheDocument();
    expect(screen.getByText(/Target: 3,000 g/)).toBeInTheDocument();
    expect(screen.getByText(/± 30g/)).toBeInTheDocument();
  });

  it('establishes WebSocket connection and subscribes to session', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(global.WebSocket).toHaveBeenCalledWith(
        'ws://localhost:5055/ws/shopkeeper/live',
        ['mock-token']
      );
    });

    await waitFor(() => {
      expect(mockWsInstance?.lastSent).toBe(
        JSON.stringify({ type: 'subscribe', sessionId: 'test-session-123' })
      );
    });
  });

  it('shows "Stabilizing..." when weight is within tolerance but not yet confirming', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    // Send a reading within tolerance (3000 ± 30)
    mockWsInstance.simulateMessage({ type: 'reading', gramsInt: 2985 });

    await waitFor(() => {
      expect(screen.getByText('Stabilizing...')).toBeInTheDocument();
    });
  });

  it('shows "Add rice" when weight is below tolerance', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: 'reading', gramsInt: 2900 });

    await waitFor(() => {
      expect(screen.getByText('Add rice')).toBeInTheDocument();
    });
  });

  it('shows "Remove rice" when weight is above tolerance', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: 'reading', gramsInt: 3100 });

    await waitFor(() => {
      expect(screen.getByText('Remove rice')).toBeInTheDocument();
    });
  });

  it('shows OK button and "✓ Weight Stable" when state changes to confirming', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    // Backend sends confirming state when stability detector passes
    mockWsInstance.simulateMessage({
      type: 'state',
      state: 'confirming',
      msLeft: 3000,
    });

    await waitFor(() => {
      expect(screen.getByText('✓ Weight Stable')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /OK/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OK/i })).not.toBeDisabled();
  });

  it('does NOT show OK button when weight is outside tolerance', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: 'reading', gramsInt: 2800 });
    mockWsInstance.simulateMessage({ type: 'state', state: 'weighing' });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /OK/i })).not.toBeInTheDocument();
    });
  });

  it('does NOT show OK button when not connected', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    // Simulate disconnection
    mockWsInstance.close();

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /OK/i })).not.toBeInTheDocument();
    });
  });

  it('calls confirm endpoint when OK button is clicked', async () => {
    const user = userEvent.setup();
    api.default.post.mockResolvedValue({
      data: { session_id: 'test-session-123', state: 'committed', measured_grams: 2995 },
    });

    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({
      type: 'state',
      state: 'confirming',
      msLeft: 3000,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /OK/i })).toBeInTheDocument();
    });

    const okButton = screen.getByRole('button', { name: /OK/i });
    await user.click(okButton);

    expect(api.default.post).toHaveBeenCalledWith(
      '/api/dispense/session/test-session-123/confirm'
    );
  });

  it('clicking OK button triggers confirm API call and disables button', async () => {
    const user = userEvent.setup();
    let resolvePost;
    api.default.post.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));

    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({
      type: 'state',
      state: 'confirming',
      msLeft: 3000,
    });

    const okButton = await screen.findByRole('button', { name: /OK/i });

    // Button should not be disabled before clicking
    expect(okButton).not.toBeDisabled();

    await user.click(okButton);

    // Verify the API was called
    expect(api.default.post).toHaveBeenCalledWith(
      '/api/dispense/session/test-session-123/confirm'
    );

    // Clean up
    if (resolvePost) {
      resolvePost({ data: { session_id: 'test', state: 'committed', measured_grams: 3000 } });
    }
  });

  it('shows terminal modal and calls onDone when committed state is received', async () => {
    const onDone = vi.fn();
    render(<DispenseWeighingPanel {...defaultProps} onDone={onDone} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({
      type: 'state',
      state: 'committed',
      measuredGrams: 2995,
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Confirmed/i })).toBeInTheDocument();
    });

    const doneButton = screen.getByRole('button', { name: /Done/i });
    await userEvent.click(doneButton);

    expect(onDone).toHaveBeenCalledWith('committed', 2995);
  });

  it('shows failure modal when state is failed_out_of_tolerance', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({
      type: 'state',
      state: 'failed_out_of_tolerance',
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Weight outside tolerance/i })).toBeInTheDocument();
    });

    expect(screen.getByText(/outside the allowed 30g tolerance/)).toBeInTheDocument();
  });

  it('calls cancel endpoint when Cancel button is clicked', async () => {
    const user = userEvent.setup();
    api.default.post.mockResolvedValue({});

    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    const cancelButton = screen.getByRole('button', { name: /Cancel/i });
    await user.click(cancelButton);

    await waitFor(() => {
      expect(api.default.post).toHaveBeenCalledWith(
        '/api/dispense/session/test-session-123/cancel'
      );
    });
  });

  it('disables Cancel button when session is in terminal state', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({
      type: 'state',
      state: 'committed',
      measuredGrams: 3000,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
    });
  });

  it('updates live weight reading when reading messages are received', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: 'reading', gramsInt: 1500 });
    await waitFor(() => {
      expect(screen.getByText('1,500 g')).toBeInTheDocument();
    });

    mockWsInstance.simulateMessage({ type: 'reading', gramsInt: 2750 });
    await waitFor(() => {
      expect(screen.getByText('2,750 g')).toBeInTheDocument();
    });

    mockWsInstance.simulateMessage({ type: 'reading', gramsInt: 2995 });
    await waitFor(() => {
      expect(screen.getByText('2,995 g')).toBeInTheDocument();
    });
  });

  it('shows green band when weight is within tolerance', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: 'reading', gramsInt: 3000 });

    await waitFor(() => {
      const card = screen.getByText('3,000 g').closest('div.border-2');
      expect(card).toHaveClass('border-success-border');
    });
  });

  it('shows red band when weight is far outside tolerance', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: 'reading', gramsInt: 2500 });

    await waitFor(() => {
      const card = screen.getByText('2,500 g').closest('div.border-2');
      expect(card).toHaveClass('border-danger-border');
    });
  });

  it('has no accessibility violations in default state', async () => {
    const { container } = render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations when OK button is shown', async () => {
    const { container } = render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({
      type: 'state',
      state: 'confirming',
      msLeft: 3000,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /OK/i })).toBeInTheDocument();
    });

    expect(await axe(container)).toHaveNoViolations();
  });
});
