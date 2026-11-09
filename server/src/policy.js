/**
 * Reply decision logic.
 *
 * Pure functions, no I/O and no `Date.now()` calls inside the decision path:
 * every input is passed in, so the whole policy is unit-testable and the tests
 * are deterministic rather than dependent on the wall clock.
 *
 * These deliberately mirror the semantics of the Android app's `domain/` package
 * (active-hours window with midnight wrap, 30-minute per-caller cooldown, free
 * tier of five) so the two delivery modes behave identically.
 */

export const MINUTES_IN_DAY = 24 * 60;

/** Default cooldown per caller, matching the Android app. */
export const DEFAULT_DEBOUNCE_MS = 30 * 60 * 1000;

/** Replies included before the unlimited upgrade. */
export const FREE_TIER_LIMIT = 5;

/** Hard cap on a single SMS segment. */
export const MAX_MESSAGE_LENGTH = 160;

export const DEFAULT_MESSAGE =
  "Hi! I missed your call - I'm on the job right now. I'll call you back as soon as I can. Thanks!";

/**
 * Carrier/framework stand-ins for a withheld caller.
 *
 * Matched against the whole trimmed value. A substring match here would reject
 * any real number containing a zero, which is the exact bug the first Android
 * implementation shipped.
 */
const PLACEHOLDER_TOKENS = new Set([
  "UNKNOWN", "PRIVATE", "ANONYMOUS", "BLOCKED", "RESTRICTED",
  "WITHHELD", "HIDDEN", "UNAVAILABLE", "-1", "-2", "0",
]);

const MIN_DIGITS = 6;
const MAX_DIGITS = 15;

/** Digits only, so "+1 (555) 010-1234" and "15550101234" debounce together. */
export function digitsOf(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function isReplyableNumber(raw) {
  const value = String(raw ?? "").trim();
  if (value.length === 0) return false;
  if (PLACEHOLDER_TOKENS.has(value.toUpperCase())) return false;

  const digits = digitsOf(value);
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return false;
  if (/^0+$/.test(digits)) return false;
  return true;
}

/** Clamped, so a bad pick in a settings screen cannot throw later. */
export function minuteOfDay(hour, minute) {
  const h = Math.min(23, Math.max(0, Number(hour) || 0));
  const m = Math.min(59, Math.max(0, Number(minute) || 0));
  return h * 60 + m;
}

/**
 * The caller's current minute-of-day in *their* configured time zone.
 *
 * Uses Intl rather than a fixed offset so daylight saving is handled without
 * shipping a tz database.
 */
export function minuteOfDayIn(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));

  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Intl can return "24" for midnight in some locales.
  return (get("hour") % 24) * 60 + get("minute");
}

/**
 * @param {{startMinuteOfDay:number, endMinuteOfDay:number, alwaysOn:boolean}} window
 * @param {number} minute current minute of day, 0..1439
 */
export function isActiveAt(window, minute) {
  if (window?.alwaysOn) return true;

  const start = window?.startMinuteOfDay ?? 0;
  const end = window?.endMinuteOfDay ?? 0;

  // Identical bounds read as "all day", not "never".
  if (start === end) return true;

  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

/**
 * The single gate every missed call passes through.
 *
 * @returns {{allow: boolean, reason: string}} reason is always set, so a
 *   suppressed reply is explainable in logs rather than silently dropped.
 */
export function decideReply({ settings, callerNumber, nowMs, lastReplyAtMs }) {
  if (!settings) return deny("no-subscriber");
  if (!settings.enabled) return deny("disabled");

  if (!isReplyableNumber(callerNumber)) return deny("caller-not-replyable");

  const message = String(settings.message ?? "").trim();
  if (message.length === 0) return deny("empty-message");

  const localMinute = minuteOfDayIn(nowMs, settings.timeZone);
  if (!isActiveAt(settings.activeHours, localMinute)) return deny("outside-hours");

  const unlimited = Boolean(settings.unlimited);
  const used = Number(settings.replyCount ?? 0);
  if (!unlimited && used >= (settings.limit ?? FREE_TIER_LIMIT)) {
    return deny("quota-exhausted");
  }

  const cooldown = Number(settings.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  if (typeof lastReplyAtMs === "number" && nowMs - lastReplyAtMs <= cooldown) {
    return deny("cooldown");
  }

  return { allow: true, reason: "ok" };
}

function deny(reason) {
  return { allow: false, reason };
}

/** True when a `DialCallStatus` means the call went unanswered. */
export function isMissedCall(dialCallStatus) {
  // "no-answer" covers both a ring-out and a rejected call; Twilio reports
  // rejections as no-answer. "failed" means it never routed at all.
  return ["no-answer", "busy", "failed"].includes(String(dialCallStatus ?? ""));
}
