// eslint-disable-next-line no-unused-vars
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import DispenseWeighingPanel from "./DispenseWeighingPanel";
import * as api from "../../api/axios";

// Mock the API module
vi.mock("../../api/axios", () => ({
  default: {
    post: vi.fn(),
  },
  resolvedApiBaseUrl: "http://localhost:5055",
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
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  globalThis.WebSocket = vi.fn((url, protocols) => {
    mockWsInstance = new MockWebSocket(url, protocols);
    return mockWsInstance;
  });

  // Mock localStorage
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: vi.fn(() => "mock-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    },
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  globalThis.WebSocket = originalWebSocket;
  mockWsInstance = null;
});

describe("DispenseWeighingPanel", () => {
  const defaultProps = {
    sessionId: "test-session-123",
    commodity: "rice",
    entitledGrams: 3000,
    toleranceGrams: 30,
    beneficiaryName: "Test Beneficiary",
    cardNumber: "CARD123456",
    onDone: vi.fn(),
  };

  it("renders beneficiary info and initial weight display", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Test Beneficiary")).toBeInTheDocument();
    });

    expect(screen.getByText(/Card: CARD123456/)).toBeInTheDocument();
    expect(screen.getByText("0 g")).toBeInTheDocument();
    expect(screen.getByText(/Target: 3,000 g/)).toBeInTheDocument();
    expect(screen.getByText(/± 30g/)).toBeInTheDocument();
  });

  it("establishes WebSocket connection and subscribes to session", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(globalThis.WebSocket).toHaveBeenCalledWith(
        "ws://localhost:5055/ws/shopkeeper/live",
        ["mock-token"],
      );
    });

    await waitFor(() => {
      expect(mockWsInstance?.lastSent).toBe(
        JSON.stringify({ type: "subscribe", sessionId: "test-session-123" }),
      );
    });
  });

  it('shows "Stabilizing..." when weight is within tolerance but not yet confirming', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    // Send a reading within tolerance (3000 ± 30)
    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2985 });

    await waitFor(() => {
      expect(screen.getByText("Stabilizing...")).toBeInTheDocument();
    });
  });

  it('shows "Add rice" when weight is below tolerance', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2900 });

    await waitFor(() => {
      expect(screen.getByText("Add rice")).toBeInTheDocument();
    });
  });

  it('shows "Remove rice" when weight is above tolerance', async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 3100 });

    await waitFor(() => {
      expect(screen.getByText("Remove rice")).toBeInTheDocument();
    });
  });

  it("keeps Finish disabled until a fresh in-range reading is stable", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    // Backend sends confirming state when stability detector passes
    mockWsInstance.simulateMessage({
      type: "state",
      state: "confirming",
    });

    expect(screen.getByRole("button", { name: /Finish rice/i })).toBeDisabled();
    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2995 });

    await waitFor(() => {
      expect(screen.getByText("✓ Weight Stable")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /Finish rice/i }),
    ).not.toBeDisabled();
  });

  it("keeps Finish disabled when the current reading is outside tolerance", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2800 });
    mockWsInstance.simulateMessage({ type: "state", state: "confirming" });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Finish rice/i }),
      ).toBeDisabled();
    });
  });

  it("keeps Finish disabled when the live subscription disconnects", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 3000 });
    mockWsInstance.simulateMessage({ type: "state", state: "confirming" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Finish rice/i }),
      ).not.toBeDisabled(),
    );
    mockWsInstance.close();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Finish rice/i }),
      ).toBeDisabled();
    });
  });

  it("disables Finish when an otherwise valid reading becomes stale", async () => {
    vi.useFakeTimers();
    render(<DispenseWeighingPanel {...defaultProps} />);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 3000 });
    mockWsInstance.simulateMessage({ type: "state", state: "confirming" });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(
      screen.getByRole("button", { name: /Finish rice/i }),
    ).not.toBeDisabled();

    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(screen.getByRole("button", { name: /Finish rice/i })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for fresh reading",
    );
  });

  it("rejects invalid sensor values even if a confirming state arrives", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);
    await waitFor(() => expect(mockWsInstance).not.toBeNull());

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 6000 });
    mockWsInstance.simulateMessage({ type: "state", state: "confirming" });

    expect(screen.getByRole("button", { name: /Finish rice/i })).toBeDisabled();
  });

  it("keeps heartbeat separate from measurements and surfaces HX711 faults", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);
    await waitFor(() => expect(mockWsInstance).not.toBeNull());

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2995 });
    mockWsInstance.simulateMessage({ type: "state", state: "confirming" });
    await waitFor(() =>
      expect(screen.getByText("2,995 g")).toBeInTheDocument(),
    );
    mockWsInstance.simulateMessage({ type: "heartbeat", ts: Date.now() });
    expect(screen.getByText("2,995 g")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Finish rice/i }),
    ).not.toBeDisabled();

    mockWsInstance.simulateMessage({
      type: "device_error",
      code: "HX711_NOT_READY",
      detail: "HX711 is not responding",
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Sensor not responding",
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "HX711 is not responding",
    );
    expect(screen.getByRole("button", { name: /Finish rice/i })).toBeDisabled();

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2995 });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Finish rice/i }),
      ).not.toBeDisabled();
    });
  });

  it("captures the validated reading without calling the commit endpoint", async () => {
    const user = userEvent.setup();
    api.default.post.mockResolvedValue({
      data: {
        session_id: "test-session-123",
        state: "captured",
        measured_grams: 2995,
      },
    });

    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2995 });
    mockWsInstance.simulateMessage({
      type: "state",
      state: "confirming",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Finish rice/i }),
      ).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /Finish rice/i }));

    expect(api.default.post).toHaveBeenCalledWith(
      "/api/dispense/session/test-session-123/capture",
    );
    expect(api.default.post).not.toHaveBeenCalledWith(
      "/api/shopkeeper/dispense",
      expect.anything(),
    );
    expect(defaultProps.onDone).toHaveBeenCalledWith("captured", 2995);
  });

  it("prevents duplicate capture requests while Finish is pending", async () => {
    const user = userEvent.setup();
    let resolvePost;
    api.default.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );

    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 3000 });
    mockWsInstance.simulateMessage({
      type: "state",
      state: "confirming",
    });

    const finishButton = await screen.findByRole("button", {
      name: /Finish rice/i,
    });

    expect(finishButton).not.toBeDisabled();

    await user.click(finishButton);
    await user.click(finishButton);

    expect(api.default.post).toHaveBeenCalledWith(
      "/api/dispense/session/test-session-123/capture",
    );
    expect(api.default.post).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: /Finishing\.\.\./i }),
    ).toBeDisabled();

    if (resolvePost) {
      resolvePost({
        data: { session_id: "test", state: "captured", measured_grams: 3000 },
      });
    }
  });

  it("shows terminal modal and calls onDone when committed state is received", async () => {
    const onDone = vi.fn();
    render(<DispenseWeighingPanel {...defaultProps} onDone={onDone} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({
      type: "state",
      state: "committed",
      measuredGrams: 2995,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Confirmed/i }),
      ).toBeInTheDocument();
    });

    const doneButton = screen.getByRole("button", { name: /Done/i });
    await userEvent.click(doneButton);

    expect(onDone).toHaveBeenCalledWith("committed", 2995);
  });

  it("shows failure modal when state is failed_out_of_tolerance", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({
      type: "state",
      state: "failed_out_of_tolerance",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Weight outside tolerance/i }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/outside the allowed 30g tolerance/),
    ).toBeInTheDocument();
  });

  it("calls cancel endpoint when Cancel button is clicked", async () => {
    const user = userEvent.setup();
    api.default.post.mockResolvedValue({});

    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    const cancelButton = screen.getByRole("button", { name: /Cancel/i });
    await user.click(cancelButton);

    await waitFor(() => {
      expect(api.default.post).toHaveBeenCalledWith(
        "/api/dispense/session/test-session-123/cancel",
      );
    });
  });

  it("disables Cancel button when session is in terminal state", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({
      type: "state",
      state: "committed",
      measuredGrams: 3000,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Cancel/i })).toBeDisabled();
    });
  });

  it("updates live weight reading when reading messages are received", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 1500 });
    await waitFor(() => {
      expect(screen.getByText("1,500 g")).toBeInTheDocument();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2750 });
    await waitFor(() => {
      expect(screen.getByText("2,750 g")).toBeInTheDocument();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2995 });
    await waitFor(() => {
      expect(screen.getByText("2,995 g")).toBeInTheDocument();
    });
  });

  it("shows green band when weight is within tolerance", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 3000 });

    await waitFor(() => {
      const card = screen.getByText("3,000 g").closest("div.border-2");
      expect(card).toHaveClass("border-success-border");
    });
  });

  it("shows red band when weight is far outside tolerance", async () => {
    render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 2500 });

    await waitFor(() => {
      const card = screen.getByText("2,500 g").closest("div.border-2");
      expect(card).toHaveClass("border-danger-border");
    });
  });

  it("has no accessibility violations in default state", async () => {
    const { container } = render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no accessibility violations when Finish is available", async () => {
    const { container } = render(<DispenseWeighingPanel {...defaultProps} />);

    await waitFor(() => {
      expect(mockWsInstance).not.toBeNull();
    });

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 3000 });
    mockWsInstance.simulateMessage({
      type: "state",
      state: "confirming",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Finish rice/i }),
      ).not.toBeDisabled();
    });

    expect(await axe(container)).toHaveNoViolations();
  });
});

// PROTOTYPE: Finish is enabled from a single fresh in-range reading while the
// session is 'weighing', without waiting for the multi-sample 'confirming'
// state. Covers rice and wheat, since both use this component.
describe.each([
  { commodity: "rice", label: "rice", entitledGrams: 1000, toleranceGrams: 20 },
  { commodity: "wheat", label: "wheat", entitledGrams: 1500, toleranceGrams: 25 },
])("DispenseWeighingPanel immediate Finish ($commodity)", ({ commodity, label, entitledGrams, toleranceGrams }) => {
  const props = {
    sessionId: "test-session-123",
    commodity,
    entitledGrams,
    toleranceGrams,
    beneficiaryName: "Test Beneficiary",
    cardNumber: "CARD123456",
    onDone: vi.fn(),
  };
  const finishButton = () =>
    screen.getByRole("button", { name: new RegExp(`Finish ${label}`, "i") });

  it("enables Finish from one fresh in-range reading in the weighing state", async () => {
    render(<DispenseWeighingPanel {...props} />);
    await waitFor(() => expect(mockWsInstance).not.toBeNull());

    mockWsInstance.simulateMessage({ type: "state", state: "weighing" });
    mockWsInstance.simulateMessage({ type: "reading", gramsInt: entitledGrams + 6 });

    await waitFor(() => expect(finishButton()).not.toBeDisabled());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Weight in range — ready to finish",
    );
  });

  it("keeps Finish disabled and shows Stabilizing while the session is not yet capturable", async () => {
    render(<DispenseWeighingPanel {...props} />);
    await waitFor(() => expect(mockWsInstance).not.toBeNull());

    mockWsInstance.simulateMessage({ type: "reading", gramsInt: entitledGrams + 6 });

    await waitFor(() => expect(screen.getByText("Stabilizing...")).toBeInTheDocument());
    expect(finishButton()).toBeDisabled();
  });

  it("keeps Finish disabled for a reading just outside tolerance", async () => {
    render(<DispenseWeighingPanel {...props} />);
    await waitFor(() => expect(mockWsInstance).not.toBeNull());

    mockWsInstance.simulateMessage({ type: "state", state: "weighing" });
    mockWsInstance.simulateMessage({
      type: "reading",
      gramsInt: entitledGrams + toleranceGrams + 1,
    });

    await waitFor(() => expect(finishButton()).toBeDisabled());
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "ready to finish",
    );
  });

  it("disables Finish once an in-range reading goes stale", async () => {
    vi.useFakeTimers();
    render(<DispenseWeighingPanel {...props} />);
    await act(async () => vi.advanceTimersByTimeAsync(1));

    mockWsInstance.simulateMessage({ type: "state", state: "weighing" });
    mockWsInstance.simulateMessage({ type: "reading", gramsInt: entitledGrams });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(finishButton()).not.toBeDisabled();

    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(finishButton()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for fresh reading",
    );
  });

  it("disables Finish when the live connection drops", async () => {
    render(<DispenseWeighingPanel {...props} />);
    await waitFor(() => expect(mockWsInstance).not.toBeNull());

    mockWsInstance.simulateMessage({ type: "state", state: "weighing" });
    mockWsInstance.simulateMessage({ type: "reading", gramsInt: entitledGrams });
    await waitFor(() => expect(finishButton()).not.toBeDisabled());

    mockWsInstance.close();
    await waitFor(() => expect(finishButton()).toBeDisabled());
  });

  it("disables Finish for a zero reading, even if the target is never zero", async () => {
    render(<DispenseWeighingPanel {...props} />);
    await waitFor(() => expect(mockWsInstance).not.toBeNull());

    mockWsInstance.simulateMessage({ type: "state", state: "weighing" });
    mockWsInstance.simulateMessage({ type: "reading", gramsInt: 0 });

    await waitFor(() => expect(finishButton()).toBeDisabled());
  });

  it("disables Finish for a sensor fault even with an in-range reading", async () => {
    render(<DispenseWeighingPanel {...props} />);
    await waitFor(() => expect(mockWsInstance).not.toBeNull());

    mockWsInstance.simulateMessage({ type: "state", state: "weighing" });
    mockWsInstance.simulateMessage({ type: "reading", gramsInt: entitledGrams });
    await waitFor(() => expect(finishButton()).not.toBeDisabled());

    mockWsInstance.simulateMessage({
      type: "device_error",
      code: "HX711_NOT_READY",
      detail: "HX711 is not responding",
    });
    await waitFor(() => expect(finishButton()).toBeDisabled());
  });
});
