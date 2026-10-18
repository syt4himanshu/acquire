import { useEffect, useRef, useState } from "react";
import { CheckCircle2, WifiOff } from "lucide-react";
import Card from "../ui/Card";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import api, { resolvedApiBaseUrl } from "../../api/axios";
import { debugBanner, debugLog } from "../../lib/weighingDebug";

const TOKEN_KEY = "pds_token";
const RECONNECT_DELAY_MS = 3000;
const READING_STALE_AFTER_MS = 3000;
const MAX_VALID_GRAMS = 5000;

const TERMINAL_STATES = [
  "committed",
  "cancelled",
  "device_lost",
  "failed_insufficient_balance",
  "failed_already_claimed",
  "failed_out_of_tolerance",
];

// The panel stops reconnecting once the session can no longer change. A
// captured session is finished from this screen's point of view, but it has
// its own display path, so it is kept out of TERMINAL_STATES (which opens the
// result modal).
const NO_RECONNECT_STATES = [...TERMINAL_STATES, "captured"];

// Sessions the server will accept a capture from (see captureMeasurement).
const CAPTURABLE_STATES = ["weighing", "confirming"];

const resolveWsUrl = () => {
  const base =
    resolvedApiBaseUrl ||
    `${window.location.protocol}//${window.location.hostname}:5055`;
  return `${base.replace(/^http/, "ws")}/ws/shopkeeper/live`;
};

const COMMODITY_LABEL = { rice: "rice", wheat: "wheat" };

const DispenseWeighingPanel = ({
  sessionId,
  commodity,
  entitledGrams,
  toleranceGrams,
  beneficiaryName,
  cardNumber,
  onDone,
}) => {
  const [connected, setConnected] = useState(false);
  const [sessionState, setSessionState] = useState("attached");
  const [gramsInt, setGramsInt] = useState(0);
  const [msLeft, setMsLeft] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [hasFinished, setHasFinished] = useState(false);
  const [measuredGramsConfirmed, setMeasuredGramsConfirmed] = useState(null);
  const [isFreshReading, setIsFreshReading] = useState(false);
  const [deviceFault, setDeviceFault] = useState(null);
  const [finishError, setFinishError] = useState("");

  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const unmountedRef = useRef(false);
  const finishSubmittedRef = useRef(false);
  const freshnessTimerRef = useRef(null);
  // Socket handlers are created once per connection and must not read React
  // state, which they would see as it was on the first render. The session
  // state is therefore mirrored in a ref, and the reconnect decision reads that.
  const sessionStateRef = useRef("attached");
  // Incremented on every WebSocket state event. An authoritative GET that was
  // issued before a newer event is stale, so its answer is dropped.
  const stateVersionRef = useRef(0);

  // --- Debug instrumentation (temporary; see lib/weighingDebug.js) ---------
  const connectAttemptRef = useRef(0);
  const lastStateSourceRef = useRef("initial");
  const prevSessionStateRef = useRef(null);
  const lastSnapshotKeyRef = useRef(null);

  useEffect(() => {
    unmountedRef.current = false;
    // Lifetime of THIS effect run. React StrictMode runs effects twice in
    // development (mount, cleanup, mount). A socket from the first run can still
    // fire events after its cleanup, so every handler checks this flag and the
    // socket it belongs to before touching state or scheduling a reconnect.
    let active = true;

    const applyServerState = (state, extra = {}, source = "ws.state") => {
      debugLog("state.apply", {
        sessionId,
        source,
        from: sessionStateRef.current,
        to: state,
      });
      lastStateSourceRef.current = source;
      sessionStateRef.current = state;
      setSessionState(state);
      if (state === "confirming" && typeof extra.msLeft === "number") {
        setMsLeft(extra.msLeft);
      } else if (state !== "confirming") {
        setMsLeft(null);
      }
      if (state === "committed" && typeof extra.measuredGrams === "number") {
        setMeasuredGramsConfirmed(extra.measuredGrams);
      }
    };

    // Authoritative status, fetched on every connection. This makes a late
    // subscriber or a reconnect independent of which events the socket replays.
    const syncFromServer = async () => {
      const versionAtRequest = stateVersionRef.current;
      debugLog("hydrate.start", {
        sessionId,
        stateVersion: versionAtRequest,
      });
      try {
        const res = await api.get(`/api/dispense/session/${sessionId}`);
        if (!active) {
          debugLog("hydrate.discarded", { sessionId, reason: "unmounted" });
          return;
        }
        if (stateVersionRef.current !== versionAtRequest) {
          debugLog("hydrate.discarded", {
            sessionId,
            reason: "newer_ws_state_arrived",
            serverState: res.data?.session?.state,
          });
          return;
        }
        debugLog("hydrate.response", {
          sessionId,
          status: res.status,
          state: res.data?.session?.state,
        });
        applyServerState(res.data.session.state, {}, "http.hydrate");
      } catch (error) {
        // Keep the current state; live events still apply. A failed sync
        // never enables Finish on its own.
        debugLog("hydrate.error", {
          sessionId,
          status: error?.response?.status ?? null,
          serverError: error?.response?.data?.error ?? null,
          message: error?.message ?? null,
        });
      }
    };

    const connect = () => {
      if (!active) return;
      connectAttemptRef.current += 1;
      const attempt = connectAttemptRef.current;
      const token = localStorage.getItem(TOKEN_KEY);
      const url = resolveWsUrl();
      debugLog("ws.connect", { sessionId, attempt, url });
      const ws = new WebSocket(url, token ? [token] : undefined);
      wsRef.current = ws;

      // A socket that is not the current one for this effect run is stale. Its
      // events are logged and ignored, so they cannot change state or reconnect.
      const isStale = () => !active || wsRef.current !== ws;

      ws.onopen = () => {
        if (isStale()) {
          debugLog("ws.stale_event_ignored", { sessionId, attempt, type: "open" });
          return;
        }
        debugLog("ws.open", { sessionId, attempt });
        setConnected(true);
        ws.send(JSON.stringify({ type: "subscribe", sessionId }));
        debugLog("ws.subscribe.sent", { sessionId, attempt });
        syncFromServer();
      };

      ws.onmessage = (event) => {
        if (isStale()) {
          debugLog("ws.stale_event_ignored", { sessionId, attempt, type: "message" });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          debugLog("ws.message.unparseable", { sessionId });
          return;
        }

        debugLog("ws.message", {
          sessionId,
          type: payload.type,
          gramsInt: payload.gramsInt,
          state: payload.state,
          msLeft: payload.msLeft,
          measuredGrams: payload.measuredGrams,
          code: payload.code,
          detail: payload.detail,
        });

        if (payload.type === "reading") {
          if (Number.isFinite(payload.gramsInt)) {
            setGramsInt(payload.gramsInt);
            setDeviceFault(null);
            setIsFreshReading(true);
            clearTimeout(freshnessTimerRef.current);
            freshnessTimerRef.current = setTimeout(() => {
              debugLog("reading.stale", { sessionId });
              setIsFreshReading(false);
            }, READING_STALE_AFTER_MS);
          }
        } else if (payload.type === "device_error") {
          setDeviceFault({ code: payload.code, detail: payload.detail });
          setIsFreshReading(false);
          clearTimeout(freshnessTimerRef.current);
        } else if (payload.type === "state") {
          stateVersionRef.current += 1;
          applyServerState(payload.state, payload, "ws.state");
        }
      };

      ws.onclose = (event) => {
        if (isStale()) {
          debugLog("ws.stale_event_ignored", {
            sessionId,
            attempt,
            type: "close",
            code: event?.code ?? null,
            reason: event?.reason || null,
          });
          return;
        }
        const willReconnect = !NO_RECONNECT_STATES.includes(sessionStateRef.current);
        debugLog("ws.close", {
          sessionId,
          attempt,
          code: event?.code ?? null,
          reason: event?.reason || null,
          wasClean: event?.wasClean ?? null,
          sessionState: sessionStateRef.current,
          unmounted: unmountedRef.current,
          willReconnect,
        });
        setConnected(false);
        if (willReconnect) {
          debugLog("ws.reconnect.scheduled", {
            sessionId,
            delayMs: RECONNECT_DELAY_MS,
          });
          reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => {
        if (isStale()) {
          debugLog("ws.stale_event_ignored", { sessionId, attempt, type: "error" });
          return;
        }
        debugLog("ws.error", {
          sessionId,
          attempt,
          readyState: ws.readyState,
        });
        ws.close();
      };
    };

    connect();

    return () => {
      debugLog("ws.cleanup", { sessionId });
      active = false;
      unmountedRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      clearTimeout(freshnessTimerRef.current);
      wsRef.current?.close();
    };
    // Keyed on sessionId only. Everything else the handlers need is in refs.
  }, [sessionId]);

  // Local countdown ticker — the server sends msLeft once when 'confirming'
  // starts; this just counts it down for a smooth in-between display.
  // Deliberately keyed on isConfirming (not msLeft itself) — depending on
  // msLeft would tear down and restart the interval on every tick.
  const isConfirming = sessionState === "confirming" && msLeft !== null;
  useEffect(() => {
    if (!isConfirming) return undefined;

    const interval = setInterval(() => {
      setMsLeft((prev) => (prev === null ? null : Math.max(0, prev - 250)));
    }, 250);

    return () => clearInterval(interval);
  }, [isConfirming]);

  // Logs every change of sessionState once, whatever set it.
  useEffect(() => {
    const previous = prevSessionStateRef.current;
    if (previous === sessionState) return;
    prevSessionStateRef.current = sessionState;
    debugLog("state.transition", {
      sessionId,
      from: previous,
      to: sessionState,
      source: lastStateSourceRef.current,
    });
    if (sessionState === "confirming") {
      debugBanner("WEIGHT STABILIZED — FINISH SHOULD ENABLE", {
        sessionId,
        source: lastStateSourceRef.current,
      });
    }
  }, [sessionState, sessionId]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await api.post(`/api/dispense/session/${sessionId}/cancel`);
    } catch {
      // Session may have already reached a terminal state server-side —
      // the WS 'state' event (or its absence) is the source of truth.
    } finally {
      setCancelling(false);
    }
  };

  const handleFinish = async () => {
    debugLog("finish.click", {
      sessionId,
      canFinish,
      reasons: disabledReasons,
    });
    if (!canFinish || finishSubmittedRef.current) {
      debugLog("finish.early_return", {
        sessionId,
        canFinish,
        alreadySubmitted: finishSubmittedRef.current,
        reasons: disabledReasons,
      });
      return;
    }

    finishSubmittedRef.current = true;
    setFinishing(true);
    setFinishError("");
    try {
      debugLog("capture.request", { sessionId });
      const res = await api.post(`/api/dispense/session/${sessionId}/capture`);
      debugLog("capture.response", {
        sessionId,
        status: res.status,
        state: res.data?.state,
        measuredGrams: res.data?.measured_grams,
      });
      const capturedGrams = res.data?.measured_grams;
      if (!Number.isFinite(capturedGrams)) {
        throw new Error("The server did not return a valid captured weight.");
      }
      setMeasuredGramsConfirmed(capturedGrams);
      setHasFinished(true);
      onDone("captured", capturedGrams);
    } catch (error) {
      debugLog("capture.error", {
        sessionId,
        status: error?.response?.status ?? null,
        serverError: error?.response?.data?.error ?? null,
        message: error?.message ?? null,
      });
      finishSubmittedRef.current = false;
      setFinishError(
        error.response?.data?.error ||
          error.message ||
          "Could not capture this measurement.",
      );
    } finally {
      setFinishing(false);
    }
  };

  const diff = gramsInt - entitledGrams;
  const absDiff = Math.abs(diff);
  const commodityLabel = COMMODITY_LABEL[commodity] || commodity;
  const isValidReading =
    Number.isFinite(gramsInt) && gramsInt >= 0 && gramsInt <= MAX_VALID_GRAMS;
  const isWithinTolerance = isValidReading && absDiff <= toleranceGrams;
  // PROTOTYPE: Finish is enabled as soon as a fresh, valid reading is within
  // tolerance, while the session is 'weighing' or already 'confirming'. This
  // skips the multi-sample stability wait, so it is less reliable than a
  // confirmed stable weight. The server re-checks freshness, validity and
  // tolerance on capture, so this gate only controls the button.
  const canFinish =
    CAPTURABLE_STATES.includes(sessionState) &&
    connected &&
    isFreshReading &&
    isWithinTolerance &&
    !deviceFault &&
    !finishing &&
    !hasFinished;

  // Every reason canFinish is false right now, for the debug log.
  const disabledReasons = [];
  if (!CAPTURABLE_STATES.includes(sessionState)) disabledReasons.push(`state=${sessionState}`);
  if (!connected) disabledReasons.push("ws=disconnected");
  if (!isFreshReading) disabledReasons.push("reading=not_fresh");
  if (!isValidReading) disabledReasons.push(`reading=invalid(${gramsInt})`);
  else if (!isWithinTolerance) disabledReasons.push(`reading=out_of_tolerance(diff=${diff})`);
  if (deviceFault) disabledReasons.push(`device_fault=${deviceFault.code}`);
  if (finishing) disabledReasons.push("finishing");
  if (hasFinished) disabledReasons.push("already_finished");

  // Logs the canFinish inputs on every render, but only when they actually
  // change, so identical renders do not flood the console.
  // TEMPORARY: each canFinish gate as its own boolean, so the log shows exactly
  // which one is false. Same inputs as canFinish above.
  const gateBreakdown = {
    stateCapturable: CAPTURABLE_STATES.includes(sessionState),
    wsConnected: connected,
    readingFresh: isFreshReading,
    readingValid: isValidReading,
    withinTolerance: isWithinTolerance,
    noDeviceFault: !deviceFault,
    notFinishing: !finishing,
    notAlreadyFinished: !hasFinished,
  };
  const snapshot = {
    sessionState,
    connected,
    isFreshReading,
    measuredGrams: gramsInt,
    targetGrams: entitledGrams,
    toleranceGrams,
    diffGrams: diff,
    isWithinTolerance,
    deviceFault: deviceFault?.code ?? null,
    finishing,
    hasFinished,
    canFinish,
    gates: gateBreakdown,
    reasons: disabledReasons,
  };
  useEffect(() => {
    const key = JSON.stringify({ sessionId, ...snapshot });
    if (key === lastSnapshotKeyRef.current) return;
    lastSnapshotKeyRef.current = key;
    debugLog("canFinish.evaluate", { sessionId, ...snapshot });
  });

  let band = "red";
  if (absDiff <= toleranceGrams) {
    band = "green";
  } else if (absDiff <= toleranceGrams * 3) {
    band = "amber";
  }

  // Status text logic
  let stateText;
  if (deviceFault) {
    stateText =
      deviceFault.code === "HX711_NOT_READY"
        ? "Sensor not responding"
        : deviceFault.code === "NOT_CALIBRATED"
        ? "Sensor needs calibration"
        : deviceFault.detail || "Sensor fault";
  } else if (!connected) {
    stateText = "Reconnecting…";
  } else if (sessionState === "device_lost") {
    stateText = "Device offline";
  } else if (sessionState === "cancelled") {
    stateText = "Cancelled";
  } else if (sessionState === "captured") {
    stateText = "Measurement captured";
  } else if (sessionState === "committed") {
    stateText = "Confirmed";
  } else if (sessionState === "failed_insufficient_balance") {
    stateText = "Insufficient balance";
  } else if (sessionState === "failed_already_claimed") {
    stateText = "Already claimed this month";
  } else if (sessionState === "failed_out_of_tolerance") {
    stateText = "Weight outside tolerance";
  } else if (sessionState === "confirming" && (!isFreshReading || !connected)) {
    stateText = !connected ? "Reconnecting…" : "Waiting for fresh reading";
  } else if (sessionState === "confirming" && isWithinTolerance) {
    stateText = "✓ Weight Stable";
  } else if (canFinish) {
    stateText = "Weight in range — ready to finish";
  } else if (!isFreshReading) {
    stateText = "Waiting for fresh reading";
  } else if (Math.abs(diff) > toleranceGrams) {
    stateText = diff < 0 ? `Add ${commodityLabel}` : `Remove ${commodityLabel}`;
  } else if (gramsInt < 50) {
    stateText = "Place the container";
  } else if (diff < -toleranceGrams) {
    stateText = `Add ${commodityLabel}`;
  } else if (diff > toleranceGrams) {
    stateText = `Remove ${commodityLabel}`;
  } else {
    stateText = "Stabilizing...";
  }

  const bandClasses = {
    green: "border-success-border bg-success-bg text-success-text",
    amber: "border-warning-border bg-warning-bg text-warning-text",
    red: "border-danger-border bg-danger-bg text-danger-text",
  };

  const isTerminal = TERMINAL_STATES.includes(sessionState);

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-lg font-semibold text-text-primary">
          {beneficiaryName}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">Card: {cardNumber}</p>
      </Card>

      <Card
        className={`border-2 ${bandClasses[band]}`}
        bodyClassName="text-center py-8"
      >
        <p className="mb-3 text-sm font-semibold uppercase text-text-secondary">
          {commodityLabel} measurement
        </p>
        {sessionState === "device_lost" && (
          <WifiOff size={28} className="mx-auto mb-2" aria-hidden="true" />
        )}
        {sessionState === "confirming" && (
          <CheckCircle2
            size={28}
            className="mx-auto mb-2 text-success-text"
            aria-hidden="true"
          />
        )}
        <p className="text-5xl font-bold tabular-nums">
          {gramsInt.toLocaleString()} g
        </p>
        <p className="mt-2 text-sm text-text-secondary">
          Target: {entitledGrams.toLocaleString()} g &plusmn; {toleranceGrams}g
        </p>
        <p
          className="mt-4 text-xl font-semibold"
          role="status"
          aria-live="polite"
        >
          {stateText}
        </p>
        {finishError && (
          <p role="alert" className="mt-3 text-sm font-medium text-danger-text">
            {finishError}
          </p>
        )}
        {deviceFault?.detail && (
          <p role="alert" className="mt-2 text-sm text-danger-text">
            {deviceFault.detail}
          </p>
        )}
      </Card>

      <div className="flex gap-3">
        {/* Browsers do not dispatch click events to a disabled button, so this
            pointer log is the only record of a press while Finish is disabled. */}
        <div
          className="flex-1"
          onPointerDownCapture={() => {
            if (!canFinish) {
              debugLog("finish.pointerdown_while_disabled", {
                sessionId,
                reasons: disabledReasons,
              });
            }
          }}
        >
          <Button
            variant="primary"
            className="h-12 w-full text-base"
            onClick={handleFinish}
            disabled={!canFinish}
          >
            {finishing ? "Finishing..." : `Finish ${commodityLabel}`}
          </Button>
        </div>
        <Button
          variant="danger"
          className="h-12 flex-1 text-base"
          onClick={handleCancel}
          disabled={cancelling || finishing || isTerminal}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </Button>
      </div>

      <Modal
        isOpen={isTerminal}
        onClose={() => onDone(sessionState, measuredGramsConfirmed)}
        title={stateText}
        footer={
          <Button
            variant="primary"
            onClick={() => onDone(sessionState, measuredGramsConfirmed)}
          >
            Done
          </Button>
        }
      >
        <p className="text-sm text-text-secondary">
          {sessionState === "committed" &&
            `Verified ${
              measuredGramsConfirmed?.toLocaleString() ||
              entitledGrams.toLocaleString()
            }g of ${commodityLabel} for ${beneficiaryName}.`}
          {sessionState === "cancelled" &&
            "The dispense was cancelled. Nothing was debited."}
          {sessionState === "device_lost" &&
            "The weighing scale disconnected — please reconnect it and restart the dispense. Nothing was debited."}
          {sessionState === "failed_insufficient_balance" &&
            "The beneficiary's wallet no longer holds this commodity's full allocation, so the dispense could not complete. Nothing was debited."}
          {sessionState === "failed_already_claimed" &&
            "This ration card already claimed this commodity for the current month. Nothing was debited."}
          {sessionState === "failed_out_of_tolerance" &&
            `The final weight was outside the allowed ${toleranceGrams}g tolerance for a ` +
              `${entitledGrams.toLocaleString()}g allocation. Nothing was debited — re-weigh to try again.`}
        </p>
      </Modal>
    </div>
  );
};

export default DispenseWeighingPanel;
