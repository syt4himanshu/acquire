// Client-side view of the FPS status snapshot from GET /api/beneficiary/fps-status.
//
// The server applies the freshness rules when it answers (see
// pds-backend/src/services/shopStatusService.js). A snapshot can then sit on
// screen for minutes, or be kept after the network drops, so this module
// advances each age by the time elapsed since the fetch and re-applies the
// server's thresholds. A report that was current when fetched can become
// "last reported" or "not reported" without any new request.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Seconds since the report was made, as of nowMs. null if never reported.
export function ageNow(snapshotAgeSeconds, fetchedAtMs, nowMs) {
    if (snapshotAgeSeconds === null || snapshotAgeSeconds === undefined) return null;
    const elapsed = Math.max(0, (nowMs - fetchedAtMs) / 1000);
    return snapshotAgeSeconds + elapsed;
}

// "open" | "closed" | "unknown". Unknown whenever the report is missing, too
// old, or the shop is inactive (the server reports that as unknown already).
export function availabilityNow(availability, fetchedAtMs, nowMs, thresholds) {
    const age = ageNow(availability.updated_age_seconds, fetchedAtMs, nowMs);
    const trusted =
        availability.status !== "unknown" &&
        age !== null &&
        age <= thresholds.open_status_max_age_seconds;
    return { status: trusted ? availability.status : "unknown", ageSeconds: age };
}

// "current" | "last_reported" | "none".
export function queueNow(queue, fetchedAtMs, nowMs, thresholds) {
    if (queue.count === null || queue.count === undefined) {
        return { count: null, freshness: "none", ageSeconds: null };
    }
    const age = ageNow(queue.updated_age_seconds, fetchedAtMs, nowMs);
    const freshness =
        age !== null && age <= thresholds.queue_stale_after_seconds ? "current" : "last_reported";
    return { count: queue.count, freshness, ageSeconds: age };
}

// Short "time ago" label. Matches the wording used in the shopkeeper app.
export function formatAgo(seconds) {
    if (seconds === null || seconds === undefined) return "";
    if (seconds < MINUTE) return "just now";
    if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)} min ago`;
    if (seconds < DAY) return `${Math.floor(seconds / HOUR)} h ago`;
    return `${Math.floor(seconds / DAY)} d ago`;
}

export function queueSentence(count) {
    return count === 1 ? "1 person waiting" : `${count} people waiting`;
}
