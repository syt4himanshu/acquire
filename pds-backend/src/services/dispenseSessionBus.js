// In-memory pub-sub for dispense-session events, keyed by session_id. Same
// shape as services/liveReadingBus.js (Phase 1) but kept as a separate channel:
// liveReadingBus is shop-level raw readings for the admin tile, this is
// session-level state for the shopkeeper's own dispense screen — different
// audience, different key space.
//
// Two kinds of payload are kept apart on purpose:
//   - state events (weighing, confirming, captured, ...) are rare and must not
//     be lost. The latest one is kept in latestStates and replayed to every new
//     subscriber, so a panel that connects or reconnects late still sees
//     `confirming`.
//   - reading events arrive several times a second. Only the most recent one is
//     kept, and it is replayed after the state so the display is current. A
//     reading can never overwrite the state.
//
// TODO: swap for Redis pub-sub (or another shared broker) if the backend
// ever runs as more than one instance.

// States after which the session cannot move again. Their state entry is
// dropped, which keeps latestStates bounded to sessions still in progress.
const TERMINAL_STATES = new Set([
    "captured",
    "committed",
    "cancelled",
    "device_lost",
    "failed_insufficient_balance",
    "failed_already_claimed",
    "failed_out_of_tolerance",
]);

const { logStateDelivery } = require("./stabilityDebug"); // TEMPORARY

const channels = new Map(); // sessionId -> { latestReading, subscribers: Set<fn> }
const latestStates = new Map(); // sessionId -> latest state payload

const getOrCreateChannel = (sessionId) => {
    let channel = channels.get(sessionId);
    if (!channel) {
        channel = { latestReading: null, subscribers: new Set() };
        channels.set(sessionId, channel);
    }
    return channel;
};

const publish = (sessionId, payload) => {
    const channel = getOrCreateChannel(sessionId);

    if (payload.type === "state") {
        logStateDelivery({
            stage: "publish",
            sessionId,
            state: payload.state,
            extra: { subscribers: channel.subscribers.size, terminal: TERMINAL_STATES.has(payload.state) },
        });
        if (TERMINAL_STATES.has(payload.state)) {
            latestStates.delete(sessionId);
        } else {
            latestStates.set(sessionId, payload);
        }
    } else {
        channel.latestReading = payload;
    }

    for (const subscriber of channel.subscribers) {
        subscriber(payload);
    }
};

// Subscribes to a session's channel. The latest known state is replayed first,
// then the latest reading. Returns an unsubscribe function; the channel's
// reading slot is dropped once no subscribers remain. The state slot is kept
// until the session reaches a terminal state, so a reconnect can still see it.
const subscribe = (sessionId, callback) => {
    const channel = getOrCreateChannel(sessionId);
    channel.subscribers.add(callback);

    const state = latestStates.get(sessionId);
    if (state) {
        logStateDelivery({ stage: "replay", sessionId, state: state.state });
        callback(state);
    } else {
        logStateDelivery({ stage: "replay_none", sessionId, state: null });
    }
    if (channel.latestReading !== null) {
        callback(channel.latestReading);
    }

    return () => {
        channel.subscribers.delete(callback);
        if (channel.subscribers.size === 0) {
            channel.latestReading = null;
            channels.delete(sessionId);
        }
    };
};

const _subscriberCount = (sessionId) => channels.get(sessionId)?.subscribers.size || 0;

const _latestState = (sessionId) => latestStates.get(sessionId) || null;

module.exports = { publish, subscribe, _subscriberCount, _latestState, TERMINAL_STATES };
