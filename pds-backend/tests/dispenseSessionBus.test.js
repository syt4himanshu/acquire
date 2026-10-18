const bus = require("../src/services/dispenseSessionBus");

// Each test uses its own session id so the module-level maps are not shared.
const sessionId = (suffix) => `${suffix}2222-2222-4222-8222-222222222222`;
const state = (s, extra = {}) => ({ type: "state", state: s, ...extra });
const reading = (g) => ({ type: "reading", gramsInt: g, takenAt: new Date().toISOString() });

const collect = (sid) => {
  const received = [];
  const unsubscribe = bus.subscribe(sid, (payload) => received.push(payload));
  return { received, unsubscribe };
};

describe("dispenseSessionBus — state and readings are kept apart", () => {
  test("a late subscriber receives the confirming state even after readings overwrote the last event", () => {
    const sid = sessionId("3001");
    bus.publish(sid, state("attached"));
    bus.publish(sid, state("weighing"));
    bus.publish(sid, state("confirming"));
    for (let g = 3000; g < 3050; g += 1) bus.publish(sid, reading(g));

    const late = collect(sid);
    expect(late.received[0]).toEqual(state("confirming"));
    expect(late.received[1]).toMatchObject({ type: "reading", gramsInt: 3049 });
    expect(late.received).toHaveLength(2);
    late.unsubscribe();
  });

  test("the state is replayed before the reading, so the reading cannot mask it", () => {
    const sid = sessionId("3002");
    bus.publish(sid, state("confirming"));
    bus.publish(sid, reading(3000));
    const late = collect(sid);
    expect(late.received.map((p) => p.type)).toEqual(["state", "reading"]);
    late.unsubscribe();
  });

  test("a reading never changes the state a subscriber is replayed", () => {
    const sid = sessionId("3003");
    bus.publish(sid, state("weighing"));
    for (let g = 0; g < 10; g += 1) bus.publish(sid, reading(g));
    expect(bus._latestState(sid)).toEqual(state("weighing"));
  });

  test("a state with extra fields (measured grams, msLeft) is replayed intact", () => {
    const sid = sessionId("3004");
    bus.publish(sid, state("confirming", { msLeft: 2750 }));
    const late = collect(sid);
    expect(late.received[0]).toEqual(state("confirming", { msLeft: 2750 }));
    late.unsubscribe();
  });

  test("a terminal state is not replayed and its entry is pruned", () => {
    const sid = sessionId("3005");
    bus.publish(sid, state("confirming"));
    bus.publish(sid, state("cancelled"));
    expect(bus._latestState(sid)).toBeNull();
    const late = collect(sid);
    expect(late.received).toEqual([]);
    late.unsubscribe();
  });

  test("captured is terminal for the bus: pruned, not replayed", () => {
    const sid = sessionId("3006");
    bus.publish(sid, state("confirming"));
    bus.publish(sid, state("captured", { measuredGrams: 3000 }));
    expect(bus._latestState(sid)).toBeNull();
  });
});

describe("dispenseSessionBus — reconnects and cleanup", () => {
  test("a subscriber that reconnects gets the current state again", () => {
    const sid = sessionId("3010");
    bus.publish(sid, state("confirming"));

    const first = collect(sid);
    expect(first.received[0]).toEqual(state("confirming"));
    first.unsubscribe();

    bus.publish(sid, reading(3000));
    const second = collect(sid);
    expect(second.received[0]).toEqual(state("confirming"));
    second.unsubscribe();
  });

  test("unsubscribing removes the channel subscriber so nothing leaks", () => {
    const sid = sessionId("3011");
    const sub = collect(sid);
    expect(bus._subscriberCount(sid)).toBe(1);
    sub.unsubscribe();
    expect(bus._subscriberCount(sid)).toBe(0);
  });

  test("a live subscriber receives events published after it subscribed, in order", () => {
    const sid = sessionId("3012");
    const live = collect(sid);
    bus.publish(sid, state("weighing"));
    bus.publish(sid, reading(2990));
    bus.publish(sid, state("confirming"));
    expect(live.received.map((p) => (p.type === "state" ? p.state : "reading"))).toEqual([
      "weighing",
      "reading",
      "confirming",
    ]);
    live.unsubscribe();
  });
});
