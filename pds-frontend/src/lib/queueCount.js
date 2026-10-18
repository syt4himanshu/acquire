// Mirrors MAX_QUEUE_COUNT in pds-backend/src/config/shopStatus.js. The server
// enforces the same limit; this only gives immediate feedback.
export const MAX_QUEUE_COUNT = 500;

// Accepts only a plain run of digits, so "1.5", "-1", "1e2" and "" are refused
// before anything is sent. Returns { value } or { error }.
export function parseQueueCount(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") {
    return { error: "Enter how many people are waiting." };
  }
  if (!/^\d+$/.test(text)) {
    return { error: "Use a whole number with no decimals or signs." };
  }
  const value = Number(text);
  if (value > MAX_QUEUE_COUNT) {
    return { error: `Enter a number up to ${MAX_QUEUE_COUNT}.` };
  }
  return { value };
}
