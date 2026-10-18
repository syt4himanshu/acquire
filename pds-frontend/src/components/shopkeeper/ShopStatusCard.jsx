import { useEffect, useRef, useState } from "react";
import api from "../../api/axios";
import Card from "../ui/Card";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import { formatRelativeTime } from "../../lib/relativeTime";
import { MAX_QUEUE_COUNT, parseQueueCount } from "../../lib/queueCount";

const AVAILABILITY_META = {
  open: { label: "Open", status: "success" },
  closed: { label: "Closed", status: "neutral" },
  unknown: { label: "Status not reported", status: "warning" },
};

const ageLabel = (ageSeconds) =>
  ageSeconds === null || ageSeconds === undefined
    ? null
    : formatRelativeTime(new Date(Date.now() - ageSeconds * 1000));

const errorMessageFor = (error, fallback) => {
  if (!error.response) {
    return "Could not reach the server. Check your connection and try again.";
  }
  return error.response.data?.error || fallback;
};

// What the queue input should show for a stored status. Empty when the shop
// has never reported a count, so the field does not show a made-up 0.
const storedQueueInput = (status) =>
  status.queue.count === null ? "" : String(status.queue.count);

const ShopStatusCard = () => {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(null); // "open" | "queue" | null
  const [actionError, setActionError] = useState("");
  const [queueInput, setQueueInput] = useState("");
  const [queueTouched, setQueueTouched] = useState(false);
  // A ref mirrors queueTouched for the load effect, so a late reload never
  // overwrites what the shopkeeper is typing.
  const queueTouchedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Loaded on mount and on Retry. The shopkeeper is the only writer of this
  // status, so there is no polling.
  useEffect(() => {
    let active = true;
    const loadStatus = async () => {
      setLoading(true);
      setLoadError("");
      try {
        const res = await api.get("/api/shopkeeper/shop-status");
        if (!active) return;
        setStatus(res.data.status);
        if (!queueTouchedRef.current) setQueueInput(storedQueueInput(res.data.status));
      } catch (error) {
        if (!active) return;
        setLoadError(errorMessageFor(error, "Could not load shop status."));
      } finally {
        if (active) setLoading(false);
      }
    };
    loadStatus();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const applyStatus = (nextStatus) => {
    setStatus(nextStatus);
    if (!queueTouchedRef.current) setQueueInput(storedQueueInput(nextStatus));
  };

  const toggleOpen = async () => {
    if (!status || saving) return;
    const nextIsOpen = status.availability.status !== "open";
    setSaving("open");
    setActionError("");
    try {
      const res = await api.put("/api/shopkeeper/shop-status/open", {
        is_open: nextIsOpen,
      });
      if (mountedRef.current) applyStatus(res.data.status);
    } catch (error) {
      if (mountedRef.current) {
        setActionError(errorMessageFor(error, "Could not update shop status."));
      }
    } finally {
      if (mountedRef.current) setSaving(null);
    }
  };

  const queueCheck = parseQueueCount(queueInput);

  const saveQueue = async (event) => {
    event.preventDefault();
    if (queueCheck.error || saving) return;
    setSaving("queue");
    setActionError("");
    try {
      const res = await api.put("/api/shopkeeper/shop-status/queue", {
        queue_count: queueCheck.value,
      });
      if (mountedRef.current) {
        queueTouchedRef.current = false;
        setQueueTouched(false);
        applyStatus(res.data.status);
      }
    } catch (error) {
      if (mountedRef.current) {
        setActionError(errorMessageFor(error, "Could not save the queue count."));
      }
    } finally {
      if (mountedRef.current) setSaving(null);
    }
  };

  if (loading && !status) {
    return (
      <Card>
        <p className="text-sm text-text-secondary" role="status">
          Loading shop status…
        </p>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card>
        <p role="alert" className="text-sm text-danger-text">
          {loadError || "Shop status is unavailable."}
        </p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setReloadKey((key) => key + 1)}>
          Retry
        </Button>
      </Card>
    );
  }

  const availability = AVAILABILITY_META[status.availability.status];
  const isOpen = status.availability.status === "open";
  const availabilityAge = ageLabel(status.availability.updated_age_seconds);
  const queueAge = ageLabel(status.queue.updated_age_seconds);
  const queueMessage = {
    none: "No queue estimate yet.",
    current: `Updated ${queueAge}`,
    last_reported: `Last reported ${queueAge}`,
  }[status.queue.freshness];

  return (
    <Card>
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-text-primary">Shop availability</h2>
          <div className="flex items-center gap-3">
            <Badge status={availability.status} dot>
              {availability.label}
            </Badge>
            {availabilityAge && (
              <span className="text-xs text-text-secondary">Set {availabilityAge}</span>
            )}
          </div>
          <Button
            variant={isOpen ? "secondary" : "primary"}
            role="switch"
            aria-checked={isOpen}
            disabled={saving !== null}
            onClick={toggleOpen}
          >
            {saving === "open" ? "Saving…" : isOpen ? "Close shop" : "Open shop"}
          </Button>
        </div>

        <form onSubmit={saveQueue} className="space-y-3 md:w-72" noValidate>
          <div>
            <label htmlFor="queue-count" className="mb-1 block text-sm font-medium text-text-primary">
              People waiting (estimate)
            </label>
            <input
              id="queue-count"
              type="number"
              inputMode="numeric"
              min="0"
              max={MAX_QUEUE_COUNT}
              step="1"
              value={queueInput}
              disabled={saving !== null}
              aria-invalid={queueTouched && queueCheck.error ? "true" : undefined}
              aria-describedby="queue-count-help"
              onChange={(event) => {
                queueTouchedRef.current = true;
                setQueueTouched(true);
                setQueueInput(event.target.value);
              }}
              className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
            <p
              id="queue-count-help"
              className={`mt-1 text-xs ${
                queueTouched && queueCheck.error ? "text-danger-text" : "text-text-secondary"
              }`}
            >
              {queueTouched && queueCheck.error
                ? queueCheck.error
                : `Whole number from 0 to ${MAX_QUEUE_COUNT}. Update this when the queue changes.`}
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-text-secondary">{queueMessage}</span>
            <Button type="submit" size="sm" disabled={saving !== null || Boolean(queueCheck.error)}>
              {saving === "queue" ? "Saving…" : "Save count"}
            </Button>
          </div>
        </form>
      </div>

      {actionError && (
        <p role="alert" className="mt-4 text-sm text-danger-text">
          {actionError}
        </p>
      )}
      {loadError && (
        <p role="status" className="mt-4 text-xs text-warning-text">
          Showing the last loaded status. {loadError}
        </p>
      )}
    </Card>
  );
};

export default ShopStatusCard;
