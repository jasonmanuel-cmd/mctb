import test from "node:test";
import assert from "node:assert/strict";
import {
  decideReply,
  isActiveAt,
  isMissedCall,
  isReplyableNumber,
  minuteOfDay,
  minuteOfDayIn,
  digitsOf,
  FREE_TIER_LIMIT,
  DEFAULT_DEBOUNCE_MS,
} from "../src/policy.js";

const NOON_UTC = Date.UTC(2026, 9, 19, 12, 0, 0);

const baseSettings = {
  enabled: true,
  message: "Sorry I missed you - I'll call back shortly.",
  timeZone: "UTC",
  activeHours: { startMinuteOfDay: minuteOfDay(8, 0), endMinuteOfDay: minuteOfDay(18, 0), alwaysOn: false },
  replyCount: 0,
  unlimited: false,
  limit: FREE_TIER_LIMIT,
  debounceMs: DEFAULT_DEBOUNCE_MS,
};

const at = (h, m = 0) => Date.UTC(2026, 9, 19, h, m, 0);

test("isReplyableNumber accepts real international numbers", () => {
  for (const n of ["+1 (212) 555-0134", "+44 7700 900123", "0412 345 678", "15550101234"]) {
    assert.equal(isReplyableNumber(n), true, n);
  }
});

test("isReplyableNumber does not reject numbers containing a zero", () => {
  // The original Android implementation used a substring match on "0" and
  // rejected every one of these.
  for (const n of ["+15550101234", "555-0100", "+442070001234"]) {
    assert.equal(isReplyableNumber(n), true, n);
  }
});

test("isReplyableNumber rejects withheld callers and junk", () => {
  for (const n of ["UNKNOWN", "private", "Restricted", "-1", "0", "911", "12345", "", null, "0000000"]) {
    assert.equal(isReplyableNumber(n), false, String(n));
  }
});

test("digitsOf normalises formatting for debounce keys", () => {
  assert.equal(digitsOf("+1 (555) 010-1234"), "15550101234");
  assert.equal(digitsOf("+1-555-010-1234"), digitsOf("15550101234"));
});

test("minuteOfDay packs and clamps", () => {
  assert.equal(minuteOfDay(21, 45), 1305);
  assert.equal(minuteOfDay(0, 0), 0);
  assert.equal(minuteOfDay(25, 99), 23 * 60 + 59);
});

test("active hours include the start and exclude the end", () => {
  const win = baseSettings.activeHours;
  assert.equal(isActiveAt(win, minuteOfDay(8, 0)), true);
  assert.equal(isActiveAt(win, minuteOfDay(17, 59)), true);
  assert.equal(isActiveAt(win, minuteOfDay(18, 0)), false);
  assert.equal(isActiveAt(win, minuteOfDay(7, 59)), false);
});

test("active hours wrap past midnight", () => {
  const win = { startMinuteOfDay: minuteOfDay(22, 0), endMinuteOfDay: minuteOfDay(2, 0), alwaysOn: false };
  assert.equal(isActiveAt(win, minuteOfDay(22, 0)), true);
  assert.equal(isActiveAt(win, minuteOfDay(0, 0)), true);
  assert.equal(isActiveAt(win, minuteOfDay(1, 59)), true);
  assert.equal(isActiveAt(win, minuteOfDay(2, 0)), false);
  assert.equal(isActiveAt(win, minuteOfDay(12, 0)), false);
});

test("identical start and end mean all day, not never", () => {
  const win = { startMinuteOfDay: minuteOfDay(8, 0), endMinuteOfDay: minuteOfDay(8, 0), alwaysOn: false };
  for (let h = 0; h < 24; h += 1) assert.equal(isActiveAt(win, minuteOfDay(h, 0)), true);
});

test("alwaysOn ignores the window entirely", () => {
  const win = { ...baseSettings.activeHours, alwaysOn: true };
  assert.equal(isActiveAt(win, minuteOfDay(3, 0)), true);
});

test("minuteOfDayIn respects the subscriber's time zone", () => {
  // 2026-10-19T12:00Z is 08:00 in New York (EDT, UTC-4) and 21:00 in Tokyo.
  assert.equal(minuteOfDayIn(NOON_UTC, "America/New_York"), minuteOfDay(8, 0));
  assert.equal(minuteOfDayIn(NOON_UTC, "Asia/Tokyo"), minuteOfDay(21, 0));
  assert.equal(minuteOfDayIn(NOON_UTC, "UTC"), minuteOfDay(12, 0));
});

test("a miss inside hours, with quota, is allowed", () => {
  const d = decideReply({ settings: baseSettings, callerNumber: "+15550101234", nowMs: at(12), lastReplyAtMs: null });
  assert.deepEqual(d, { allow: true, reason: "ok" });
});

test("suppression reasons are all distinct and explainable", () => {
  const cases = [
    [{ ...baseSettings, enabled: false }, at(12), null, "disabled"],
    [baseSettings, at(3), null, "outside-hours"],
    [{ ...baseSettings, message: "   " }, at(12), null, "empty-message"],
    [{ ...baseSettings, replyCount: FREE_TIER_LIMIT }, at(12), null, "quota-exhausted"],
    [baseSettings, at(12), at(12) - 1000, "cooldown"],
    [baseSettings, at(12), null, "ok"],
  ];
  for (const [settings, nowMs, last, expected] of cases) {
    const d = decideReply({ settings, callerNumber: "+15550101234", nowMs, lastReplyAtMs: last });
    assert.equal(d.reason, expected, `expected ${expected}`);
    assert.equal(d.allow, expected === "ok");
  }
});

test("a withheld caller is never replied to", () => {
  const d = decideReply({ settings: baseSettings, callerNumber: "UNKNOWN", nowMs: at(12), lastReplyAtMs: null });
  assert.equal(d.allow, false);
  assert.equal(d.reason, "caller-not-replyable");
});

test("unlimited subscribers are not capped", () => {
  const settings = { ...baseSettings, unlimited: true, replyCount: 9999 };
  assert.equal(decideReply({ settings, callerNumber: "+15550101234", nowMs: at(12), lastReplyAtMs: null }).allow, true);
});

test("the cooldown expires after exactly the window", () => {
  const caller = "+15550101234";
  const sent = at(12, 0);
  assert.equal(
    decideReply({ settings: baseSettings, callerNumber: caller, nowMs: sent + DEFAULT_DEBOUNCE_MS, lastReplyAtMs: sent }).allow,
    false,
  );
  assert.equal(
    decideReply({ settings: baseSettings, callerNumber: caller, nowMs: sent + DEFAULT_DEBOUNCE_MS + 1, lastReplyAtMs: sent }).allow,
    true,
  );
});

test("missing settings do not throw", () => {
  assert.equal(decideReply({ settings: null, callerNumber: "+15550101234", nowMs: at(12), lastReplyAtMs: null }).reason, "no-subscriber");
});

test("isMissedCall maps Twilio's DialCallStatus values", () => {
  for (const s of ["no-answer", "busy", "failed"]) assert.equal(isMissedCall(s), true, s);
  for (const s of ["completed", "answered", "canceled", "", undefined]) {
    assert.equal(isMissedCall(s), false, String(s));
  }
});
