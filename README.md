# Missed Call Reply

For people who cannot afford to lose a lead to a missed call: when a call rings out,
your prepared message goes to the caller automatically.

Targeted at tradespeople, freelancers and field workers.

There are **two delivery modes** in this repo, and the difference matters:

| | Server mode (`server/`) | On-device mode (`app/`) |
|---|---|---|
| Taps needed | **Zero** | One |
| Where it runs | Your host | The subscriber's phone |
| Callers dial | Your Twilio number | Any number |
| Needs Play Store | No | Yes |
| Status | **Working and tested** (120 tests) | **Never compiled** |

---

## Read this first: why there are two modes

**A phone cannot silently send SMS.** `SEND_SMS` belongs to a restricted permission
group; Play limits it to apps registered as the **default SMS, Phone or Assistant
handler**, and "auto-reply to a missed call" is not on the exception list.
`READ_CALL_LOG` is in the same group and is load-bearing for reading the number from
the phone-state broadcast. Since Android 15 `SEND_SMS` is additionally
**hard-restricted** for sideloaded installs, so shipping the APK outside Play does
not rescue a silent-send design either.

So on a phone, the honest best case is one tap. That is what `app/` does: it detects
the miss and posts a notification with your message pre-filled; you tap the action
and your own messaging app opens ready to send.

**Zero taps requires the call to go through a provider that can tell you it went
unanswered.** That is what `server/` does, and it is the mode to ship if "truly
automatic" is the requirement. It never touches SMS permissions, so Play policy is
irrelevant to it.

The cost is that callers must dial a Twilio number rather than your personal SIM.
For a work line that is usually a feature, not a bug — see `server/README.md`.


---

## How it works

```
1. Incoming call
      ↓
2. ReplyScreeningService.onScreenCall()          ← caller id, before ringing
   records the number in SharedPreferences
      ↓
3. Phone rings. PHONE_STATE broadcast → RINGING
      ↓
4a. You answer  → OFFHOOK → tracking cleared, nothing happens
4b. You don't   → IDLE    → missed call
      ↓
5. MissedCallHandler gates it:
      enabled? · inside active hours? · quota left? · not texted in last 30 min?
      ↓
6. Notification: "Missed call from +15550101234"  [Send reply]
      ↓
7. Tap → ReplyActivity charges one reply, then opens your messaging app
   via ACTION_SENDTO with the number and message pre-filled
      ↓
8. You press send.
```

### Why there is no foreground service

The previous revision ran a `phoneCall`-type foreground service. That does not work:

| Constraint | Consequence for the old design |
|---|---|
| Android 14+: `phoneCall` FGS requires `MANAGE_OWN_CALLS` **or** the default dialer role | `startForeground()` throws `SecurityException` — crash on the first toggle |
| Android 15+: `BOOT_COMPLETED` may not launch a `phoneCall` FGS | `ForegroundServiceStartNotAllowedException` on every reboot |

`ACTION_PHONE_STATE_CHANGED` is a protected system broadcast that wakes a
manifest-declared receiver from a dead process. No service, no battery-optimisation
fight, no reboot handler needed.

This matters because Android 8.0+ normally blocks manifest registration for implicit
broadcasts — but `ACTION_PHONE_STATE_CHANGED` is explicitly on the
[implicit broadcast exceptions](https://developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions)
list, so it keeps working regardless of target API.

---

## Permissions

| Permission | Why | Restricted by Play? |
|---|---|---|
| `READ_PHONE_STATE` | Detect RINGING / OFFHOOK / IDLE transitions | No |
| `POST_NOTIFICATIONS` | Deliver the reply prompt (API 33+) | No |
| `com.android.vending.BILLING` | Play Billing | No |
| `ROLE_CALL_SCREENING` *(runtime role, not a manifest permission)* | See who is calling | No — granted via a system dialog |

**Not requested:** `SEND_SMS`, `READ_SMS`, `READ_CALL_LOG`, `WRITE_CALL_LOG`,
`READ_CONTACTS`, `FOREGROUND_SERVICE*`, `RECEIVE_BOOT_COMPLETED`,
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

There is no SMS or Call Log permission in the manifest, so **no Play permissions
declaration form is required**.

### Privacy

Numbers are held on-device only, for at most 30 minutes, purely to stop the same
caller being prompted twice. The ledger prunes expired entries on every write, so it
cannot grow without bound. Nothing is transmitted anywhere. There is no analytics and
no crash reporting.

---

## Project layout

```
domain/        Pure Kotlin, no android.* imports — unit tested on the JVM
  PhoneNumberValidator   replyable? (fixes the substring bug that rejected any number containing a zero)
  ActiveHours            window logic in minutes-since-midnight, incl. midnight wrap
  MissedCallStateMachine transition table: when did a call end unanswered?
  DebounceLedger         bounded per-number cooldown codec
data/
  AppPreferences         DataStore. One-shot reads use .first(), never .collect{}
  CallStateStore         SharedPreferences, committed synchronously — survives process death
screening/ReplyScreeningService   captures caller id
receiver/PhoneStateReceiver       goAsync() + coroutine, finishes the broadcast properly
receiver/MissedCallHandler        the gating decision
notify/MissedCallNotifier         high-priority prompt
reply/ReplyIntentFactory          ACTION_SENDTO builder
reply/ReplyActivity               invisible trampoline: charges quota, hands off
billing/BillingManager            Play Billing 8.x
ui/                              Compose / Material 3
tools/check_project.py           static consistency gate (see Verification)
```

---

## Building

Requires JDK 17, Android SDK with platform 35.

```bash
./gradlew assembleDebug
./gradlew test            # JVM unit tests for the domain logic
./gradlew assembleRelease
```

`gradle/wrapper/gradle-wrapper.jar` **is committed**, so `./gradlew` runs from a
fresh clone with no bootstrap step. (It was fetched from `android/nowinandroid` and
verified as a valid jar containing `GradleWrapperMain`; the earlier revision of this
README described a bootstrap dance that is no longer needed.)

`minSdk` is **29** (Android 10): a third-party `CallScreeningService` is only bound by
the framework from API 29, and `RoleManager` is API 29+.

### Server

No build step. No dependencies to install.

```bash
cd server
npm test     # 120 tests
npm start    # requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL
```

---

## Verification status — what was and was not checked

Being explicit, because the last revision of this repo claimed "production-ready, no
placeholders, fully functional" and had never been compiled.

**Checked**

- **`server/` — 120 tests, all passing (`npm test`, Node 22.22.3).** Integration tests
  drive the real HTTP server over a real socket with correctly-signed Twilio webhooks:
  forwarded-call TwiML, `no-answer` → SMS sent, `completed` → nothing sent, unsigned
  and tampered signatures 403'd, per-caller debounce, free-tier quota cutoff, and
  "a failed SMS send does not consume quota". The suite was mutation-tested:
  four deliberate regressions (treat answered calls as missed; skip signature
  validation; charge quota on send failure; drop `callerId` from the `Dial`) each
  produce a failing test, and each reverts to green.
- **`server/` smoke-tested as a process.** Booted with real env vars: `/healthz` →
  200 `{"ok":true}`, a settings `PUT` → 200 and persisted to the JSON store, an
  unsigned webhook → 403, and startup correctly refuses with a named missing
  variable when credentials are absent.
- `tools/check_project.py` — a static consistency gate over the real source. It
  resolves every `R.*` and `@type/name` reference against declared resources, verifies
  every manifest component maps to a real class, checks that every
  `Manifest.permission.*` used in code is declared, fails on the
  `dataStore.data.collect {}` deadlock pattern, validates `stringResource` format-arg
  counts against each string's placeholders, checks package/directory agreement,
  project-internal imports, bracket balance, and asserts no code still references the
  removed architecture. **Result: 23 Kotlin files, 68 strings, 3 permissions — all
  passing.** It was itself mutation-tested: re-injecting the four v1 defects (missing
  string, DataStore `collect`, phantom manifest class, format-arg mismatch) produces
  exactly four findings.
- The pure domain algorithms were re-implemented independently and run against 28
  assertions covering the window boundaries, the full state-transition table, stale
  and future timestamps, cooldown formatting and ledger pruning. All pass. This
  validates the **logic**, not the Kotlin that encodes it.
- Platform constraints (FGS prerequisites, `BOOT_COMPLETED` restrictions, Play
  SMS/Call Log policy, `SEND_SMS` hard-restriction) were confirmed against
  `developer.android.com` and Play Console policy pages.

**Not checked — all of this is the Android app; the server is covered above**

- **No compile and no build.** There is no JDK, Gradle or Android SDK in the
  environment this was written in, and `services.gradle.org`, `dl.google.com` and
  `maven.google.com` are all unreachable from it. Expect to fix small compilation
  errors on first sync.
- **Not run on a device.** The screening-service → receiver → notification path needs
  testing on real hardware, especially Samsung and Xiaomi.
- **Play Billing has never executed.** It only resolves products for a build installed
  from a Play track with the product `unlimited_replies` published in Play Console.
  Until then the app shows "Upgrade unavailable", which is by design and does not
  affect the free tier.
- **The committed JUnit tests have not been run.** They are pure JVM tests and should
  pass under `./gradlew test`, but that is an expectation, not a result.

---

## Play Console launch checklist

1. **In-app product.** Monetization → Products → In-app products → create
   `unlimited_replies`, one-time, priced. Activate it, then publish a release to a
   track — products do not resolve until the build is on a track.
2. **Data safety form.** Declare: no data collected, no data shared, no personal data
   transmitted. Phone numbers are processed on-device and are not persisted beyond
   the 30-minute cooldown.
3. **Permissions declaration.** Not required — no SMS or Call Log permission is
   declared.
4. **Foreground service types.** Not required — no foreground service.
5. **Target API.** `targetSdk = 35`, which meets the current Play requirement.
6. **Store listing.** Be accurate: describe it as *"prepares a reply you send in one
   tap"*. Claiming fully automatic texting would misdescribe the app and invite a
   rejection.
7. **Signing.** Add a `signingConfig` to `app/build.gradle.kts` — currently absent, so
   `assembleRelease` produces an unsigned AAB.
8. **Privacy policy URL.** Required for every Play app.
9. **Test on hardware** before submitting: grant call screening, miss a call from an
   unsaved number, confirm the prompt appears and the hand-off pre-fills correctly.

---

## Known limitations

- **Saved contacts do not trigger a prompt.** Android only passes calls from numbers
  *not* in the user's contacts to a screening service, unless the app also holds
  `READ_CONTACTS`. `READ_CONTACTS` is deliberately not requested — it would widen the
  data safety declaration for a feature whose value is catching unknown callers, which
  are new leads.
- **Withheld and private numbers cannot be replied to** — there is no number to send
  to. These are detected and logged, not silently dropped.
- **One reply per caller per 30 minutes.** Deliberate, to stop a redialler getting
  three prompts.
- **SMS only.** No WhatsApp or other messaging apps.
- **Single SIM.** `ACTION_SENDTO` goes to the default SMS app, which picks the SIM.

---

## License

MIT — see [LICENSE](LICENSE).
