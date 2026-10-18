// eslint-disable-next-line no-unused-vars
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import DispenseWeighingPanel from "./DispenseWeighingPanel";
import api from "../../api/axios";

vi.mock("../../api/axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
  resolvedApiBaseUrl: "http://localhost:5055",
}));

// A socket the test drives by hand: nothing opens or sends on its own.
let sockets = [];
class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    sockets.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  drop() {
    this.closed = true;
    this.onclose?.();
  }
}

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const props = (overrides = {}) => ({
  sessionId: SESSION_ID,
  commodity: "rice",
  entitledGrams: 3000,
  toleranceGrams: 30,
  beneficiaryName: "Sunita Pawar",
  cardNumber: "PDS-2026-2F858F81",
  onDone: vi.fn(),
  ...overrides,
});

const finishButton = () => screen.getByRole("button", { name: /Finish rice/i });
const flush = () => act(async () => {});

const serverState = (state) => ({ data: { session: { id: SESSION_ID, state } } });

beforeEach(() => {
  sockets = [];
  globalThis.WebSocket = FakeSocket;
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.spyOn(Storage.prototype, "getItem").mockReturnValue("token");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("DispenseWeighingPanel — state synchronisation", () => {
  it("enables Finish when the server says confirming and a fresh reading is in tolerance, with no state event needed", async () => {
    api.get.mockResolvedValue(serverState("confirming"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();

    expect(finishButton()).toBeDisabled(); // no fresh reading yet
    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));
    expect(finishButton()).toBeEnabled();
  });

  it("enables Finish from a single in-range reading while the session is weighing (prototype)", async () => {
    api.get.mockResolvedValue(serverState("weighing"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();

    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));
    expect(finishButton()).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Weight in range — ready to finish");
  });

  it("keeps Finish disabled for an in-range reading while the session is still attached", async () => {
    api.get.mockResolvedValue(serverState("attached"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();

    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));
    expect(finishButton()).toBeDisabled();
  });

  it("fetches the authoritative status on every connection, including a reconnect", async () => {
    api.get.mockResolvedValue(serverState("weighing"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(`/api/dispense/session/${SESSION_ID}`);

    act(() => sockets[0].drop());
    act(() => vi.advanceTimersByTime(3000));
    expect(sockets).toHaveLength(2);
    act(() => sockets[1].open());
    await flush();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("applies the server's confirming after a reconnect, so Finish comes back without a new state event", async () => {
    api.get.mockResolvedValueOnce(serverState("weighing")).mockResolvedValueOnce(serverState("confirming"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].drop());
    act(() => vi.advanceTimersByTime(3000));
    act(() => sockets[1].open());
    await flush();

    act(() => sockets[1].emit({ type: "reading", gramsInt: 3000 }));
    expect(finishButton()).toBeEnabled();
  });

  it("drops a status response that is older than a state event received while it was in flight", async () => {
    let resolveGet;
    api.get.mockImplementation(
      () => new Promise((resolve) => (resolveGet = resolve)),
    );
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());

    // The socket delivers confirming while the GET is still pending.
    act(() => sockets[0].emit({ type: "state", state: "confirming" }));
    // The stale answer (attached) arrives last and must not win.
    await act(async () => resolveGet(serverState("attached")));

    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));
    expect(finishButton()).toBeEnabled();
  });

  it("keeps the device-fault safety check: a sensor fault blocks Finish even when confirming and in tolerance", async () => {
    api.get.mockResolvedValue(serverState("confirming"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));
    expect(finishButton()).toBeEnabled();

    act(() => sockets[0].emit({ type: "device_error", code: "HX711_NOT_READY", detail: "HX711 is not responding" }));
    expect(finishButton()).toBeDisabled();
    expect(screen.getByText("Sensor not responding")).toBeInTheDocument();
  });

  it("blocks Finish when the last reading is out of tolerance, even while the server says confirming", async () => {
    api.get.mockResolvedValue(serverState("confirming"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "reading", gramsInt: 3100 }));
    expect(finishButton()).toBeDisabled();
  });

  it("blocks Finish when the reading goes stale", async () => {
    api.get.mockResolvedValue(serverState("confirming"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));
    expect(finishButton()).toBeEnabled();

    act(() => vi.advanceTimersByTime(3500));
    expect(finishButton()).toBeDisabled();
  });

  it("does not reconnect after a terminal state, even though the socket closes", async () => {
    api.get.mockResolvedValue(serverState("weighing"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "state", state: "cancelled" }));

    act(() => sockets[0].drop());
    act(() => vi.advanceTimersByTime(10000));
    expect(sockets).toHaveLength(1);
  });

  it("reconnects while the session is still in progress (stale closure would have read 'attached')", async () => {
    api.get.mockResolvedValue(serverState("confirming"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "state", state: "confirming" }));

    act(() => sockets[0].drop());
    act(() => vi.advanceTimersByTime(3000));
    expect(sockets).toHaveLength(2);
  });

  it("does not reconnect after the session is captured", async () => {
    api.get.mockResolvedValue(serverState("captured"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Measurement captured");

    act(() => sockets[0].drop());
    act(() => vi.advanceTimersByTime(10000));
    expect(sockets).toHaveLength(1);
  });

  it("Finish captures the measurement and reports it to the flow, which is the step before the next commodity", async () => {
    vi.useRealTimers();
    const onDone = vi.fn();
    api.get.mockResolvedValue(serverState("confirming"));
    api.post.mockResolvedValue({ data: { state: "captured", measured_grams: 2995 } });
    render(<DispenseWeighingPanel {...props({ onDone })} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "reading", gramsInt: 2995 }));

    await act(async () => finishButton().click());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("captured", 2995));
    expect(api.post).toHaveBeenCalledWith(`/api/dispense/session/${SESSION_ID}/capture`);
  });

  it("shows the server's refusal when capture is rejected, and keeps the session open for a retry", async () => {
    vi.useRealTimers();
    const onDone = vi.fn();
    api.get.mockResolvedValue(serverState("confirming"));
    api.post.mockRejectedValue({
      response: { data: { error: "The scale reading is stale, unstable, or outside the allowed tolerance" } },
    });
    render(<DispenseWeighingPanel {...props({ onDone })} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));

    await act(async () => finishButton().click());
    expect(await screen.findByRole("alert")).toHaveTextContent("stale, unstable");
    expect(onDone).not.toHaveBeenCalled();
    expect(finishButton()).toBeEnabled();
  });
});

describe("DispenseWeighingPanel — temporary weighing debug logs", () => {
  const debugCalls = (spy) =>
    spy.mock.calls.filter(([first]) => typeof first === "string" && first.includes("[PDS-WEIGHING-DEBUG]"));

  it("prints the banner when the backend emits confirming, and logs the transition", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    api.get.mockResolvedValue(serverState("weighing"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();

    act(() => sockets[0].emit({ type: "state", state: "confirming" }));

    const banner = debugCalls(spy).find(([first]) => first.includes("WEIGHT STABILIZED — FINISH SHOULD ENABLE"));
    expect(banner).toBeDefined();
    const transitions = debugCalls(spy).filter(([first]) => first.includes("state.transition"));
    expect(transitions.map(([, fields]) => fields.to)).toEqual(expect.arrayContaining(["weighing", "confirming"]));
  });

  it("logs the canFinish inputs and the reasons it is false, and does not repeat identical snapshots", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    api.get.mockResolvedValue(serverState("confirming"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();

    const evaluations = debugCalls(spy).filter(([first]) => first.includes("canFinish.evaluate"));
    const last = evaluations[evaluations.length - 1][1];
    expect(last).toMatchObject({ sessionState: "confirming", connected: true, canFinish: false });
    expect(last.reasons).toContain("reading=not_fresh");

    const countBefore = evaluations.length;
    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));
    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));
    const after = debugCalls(spy).filter(([first]) => first.includes("canFinish.evaluate"));
    // First reading changes the snapshot (fresh + in tolerance); the second is identical.
    expect(after.length - countBefore).toBe(1);
    expect(after[after.length - 1][1]).toMatchObject({ canFinish: true, reasons: [] });
  });

  it("logs WebSocket open, subscription, message and close with the session id", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    api.get.mockResolvedValue(serverState("weighing"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "reading", gramsInt: 2990 }));
    act(() => sockets[0].drop());

    const names = debugCalls(spy).map(([first]) => first);
    expect(names.some((n) => n.includes("ws.open"))).toBe(true);
    expect(names.some((n) => n.includes("ws.subscribe.sent"))).toBe(true);
    expect(names.some((n) => n.includes("ws.message"))).toBe(true);
    expect(names.some((n) => n.includes("ws.close"))).toBe(true);
    const messageLog = debugCalls(spy).find(([first]) => first.includes("ws.message"))[1];
    expect(messageLog).toMatchObject({ sessionId: SESSION_ID, type: "reading", gramsInt: 2990 });
  });

  it("logs the capture request, response and error, and the Finish click", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useRealTimers();
    api.get.mockResolvedValue(serverState("confirming"));
    api.post.mockRejectedValue({ response: { status: 409, data: { error: "stale" } } });
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));

    await act(async () => finishButton().click());

    const names = debugCalls(spy).map(([first]) => first);
    expect(names.some((n) => n.includes("finish.click"))).toBe(true);
    expect(names.some((n) => n.includes("capture.request"))).toBe(true);
    const errorLog = debugCalls(spy).find(([first]) => first.includes("capture.error"))[1];
    expect(errorLog).toMatchObject({ sessionId: SESSION_ID, status: 409, serverError: "stale" });
  });

  it("never logs the auth token, the beneficiary name, or the card number", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    api.get.mockResolvedValue(serverState("confirming"));
    render(<DispenseWeighingPanel {...props()} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "reading", gramsInt: 3000 }));
    act(() => sockets[0].emit({ type: "state", state: "confirming" }));

    const everything = JSON.stringify(spy.mock.calls);
    expect(everything).not.toContain("token");
    expect(everything).not.toContain("Sunita Pawar");
    expect(everything).not.toContain("PDS-2026-2F858F81");
  });
});

describe("DispenseWeighingPanel — gate breakdown matches the reported case", () => {
  it("with 999 g vs 1000 g target, fresh and in tolerance, while weighing: every gate passes (prototype)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    api.get.mockResolvedValue(serverState("weighing"));
    render(<DispenseWeighingPanel {...props({ entitledGrams: 1000, toleranceGrams: 20 })} />);
    act(() => sockets[0].open());
    await flush();
    act(() => sockets[0].emit({ type: "reading", gramsInt: 999 }));

    const evaluations = spy.mock.calls
      .filter(([first]) => typeof first === "string" && first.includes("canFinish.evaluate"))
      .map(([, fields]) => fields);
    const last = evaluations[evaluations.length - 1];
    expect(last).toMatchObject({ sessionState: "weighing", connected: true, measuredGrams: 999, diffGrams: -1, canFinish: true });
    expect(last.gates).toEqual({
      stateCapturable: true,
      wsConnected: true,
      readingFresh: true,
      readingValid: true,
      withinTolerance: true,
      noDeviceFault: true,
      notFinishing: true,
      notAlreadyFinished: true,
    });
    expect(last.reasons).toEqual([]);
  });
});

describe("DispenseWeighingPanel — StrictMode does not create duplicate sockets", () => {
  // Real browsers fire onclose asynchronously. The synchronous fake above hides
  // the race, so this socket closes the way a browser does.
  class AsyncCloseSocket extends FakeSocket {
    close() {
      if (this.closed) return;
      this.closed = true;
      setTimeout(() => this.onclose?.(), 0);
    }
  }

  it("with StrictMode mount/cleanup/mount, exactly one live socket remains after the reconnect delay", async () => {
    const { StrictMode } = await import("react");
    globalThis.WebSocket = AsyncCloseSocket;
    api.get.mockResolvedValue(serverState("weighing"));

    render(
      <StrictMode>
        <DispenseWeighingPanel {...props()} />
      </StrictMode>,
    );
    // Open whichever sockets are still live, as a browser would.
    act(() => sockets.forEach((ws) => !ws.closed && ws.open()));
    await flush();
    act(() => vi.advanceTimersByTime(3500));
    await flush();

    const live = sockets.filter((ws) => !ws.closed);
    expect(live).toHaveLength(1);
  });
});
