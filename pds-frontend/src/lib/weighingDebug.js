// TEMPORARY debugging instrumentation for the IoT weighing workflow.
// Set WEIGHING_DEBUG to false, or delete the calls, once the failing transition
// has been identified.
//
// Callers must never pass secrets or personal data here (tokens, OTPs,
// beneficiary names, card numbers). Only session IDs, states, grams and
// device-fault codes are logged.

export const WEIGHING_DEBUG = true;

const PREFIX = "[PDS-WEIGHING-DEBUG]";

export function debugLog(event, fields = {}) {
  if (!WEIGHING_DEBUG) return;
  console.log(`${PREFIX} ${new Date().toISOString()} ${event}`, fields);
}

// Highlighted line for the moments that matter most when reading the console.
export function debugBanner(message, fields = {}) {
  if (!WEIGHING_DEBUG) return;
  console.log(
    `%c${PREFIX} ${message}`,
    "background:#16a34a;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px",
    fields,
  );
}
