// Limits and freshness windows for shop availability and queue reports.
// MAX_QUEUE_COUNT must match the CHECK constraint in migration 029.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

module.exports = {
    // Upper bound on a shopkeeper's queue estimate. Anything above this is
    // almost certainly a typo, not a real crowd.
    MAX_QUEUE_COUNT: 500,

    // A shop's Open/Closed report is only trusted this long. After that the
    // beneficiary sees "status not reported" instead of a status that may have
    // been true yesterday.
    OPEN_STATUS_MAX_AGE_MS: 12 * HOUR_MS,

    // A queue estimate older than this is shown as "Last reported", not as a
    // live count.
    QUEUE_STALE_AFTER_MS: 30 * MINUTE_MS,
};
