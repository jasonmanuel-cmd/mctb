# Audit — `mctb` (Missed Call Auto-Reply)

**Audited:** 2026-10-18 · commit `e877d72` ("Production-ready rebuild: Jetpack Compose + Material 3 + Latest Tooling")
**Scope:** 13 Kotlin files (1,905 lines), 8 XML files, Gradle config, README/BUILD_NOTES.

---

## Verdict

**The product idea is worth keeping. This codebase is not, and neither is the architecture it's built on.**

Three independent things are wrong, and any *one* of them is fatal on its own:

1. **It does not compile.** Two string resources are referenced but never defined.
2. **Even if it compiled, the core feature never fires.** The DataStore read helpers suspend forever.
3. **Even if that were fixed, it crashes on every modern phone**, and Google Play will not allow it to ship in this form at all.

The README's claims — *"Production-ready"*, *"No TODOs, no placeholders - fully functional code"*, *"Verification: `./gradlew clean assembleDebug`"* — are false. This code has never been compiled, let alone run on a device. Treat the README as marketing copy, not as documentation.

**Recommendation:** don't try to repair this into an on-device auto-SMS app. That product is not shippable on Google Play, period. Salvage the UI (~57% of the code) and rebuild the core around a different architecture. Details in §5.

---

## 1. It does not build

I cross-referenced every `R.*` reference in the source against the defined resources. Two are missing:

| Referenced at | Symbol | Defined in `strings.xml`? |
|---|---|---|
| `ui/screens/MessageEditorScreen.kt:78` | `R.string.message_label` | **No** |
| `ui/screens/ActiveHoursScreen.kt:240` | `R.string.select_time` | **No** |

Both are `stringResource(...)` calls, so these are unresolved-reference **Kotlin compile errors**, not lint warnings. `./gradlew assembleDebug` fails.

Secondary build blocker: `gradle/wrapper/gradle-wrapper.jar` is absent (only `gradle-wrapper.properties` is committed), and there's no `gradlew.bat`. `BUILD_NOTES.md` acknowledges this. The README's own "Building the APK" section therefore cannot work on a fresh clone.

---

## 2. The core feature is dead on arrival (DataStore deadlock)

`AppPreferences` has seven "sync read" helpers, all with the same shape (`data/AppPreferences.kt`):

```kotlin
suspend fun isEnabledSync(): Boolean {
    var enabled = false
    context.dataStore.data.map { it[KEY_ENABLED] ?: false }.collect { enabled = it }  // line 104
    return enabled
}
```

`DataStore.data` is a **never-completing** flow. I pulled the actual AndroidX implementation (`androidx/datastore-core/.../DataStoreImpl.kt`, `androidx-main`) to confirm:

```kotlin
override val data: Flow<T> = flow {
    ...
    emit(startState.value)              // first emission
    emitAll(
        inMemoryCache.flow              // StateFlow-backed, never completes
            .takeWhile { it !is Final } // only ends when the DataStore scope is cancelled
            ...
    )
}
```

It only completes when the state becomes `Final` — i.e. when the DataStore's coroutine scope is cancelled, which never happens for an app-lifetime instance. AndroidX added `DataStore.currentData()` specifically for the "read one snapshot and return" case, and the `data` KDoc says outright: *"use `data.first()` to access a single snapshot."*

So `.collect { }` sets the variable once and then **suspends forever**. The seven affected lines are 104, 110, 116, 122, 128, 161, 189 — every one of `isEnabledSync`, `getMessageSync`, `isAlwaysOnSync`, `isUnlimitedSync`, `getAutoTextCountSync`, `isWithinActiveHours`, `getLastTextTime`.

Trace the actual send path:

```
CallReceiver.onReceive → handleMissedCall → SmsHandler.processMissedCall
  → prefs.isEnabledSync()   ← never returns
```

**No SMS is ever sent. Not occasionally — never.** The coroutine parks on an IO thread and the function body past line 39 of `SmsHandler.kt` is unreachable. Fix is mechanical (`collect` → `first()`), but it tells you the send path has never once been executed.

---

## 3. It crashes on Android 14+ the moment you flip the toggle

`CallMonitorService` is declared `android:foregroundServiceType="phoneCall"` and the manifest requests `FOREGROUND_SERVICE_PHONE_CALL`. Per the official [foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types) documentation, `phoneCall` has **runtime prerequisites**:

> At least one of these conditions must be true:
> - App has declared the `MANAGE_OWN_CALLS` permission in its manifest file.
> - App is the default dialer app through the `ROLE_DIALER` role.

I grepped the manifest — `MANAGE_OWN_CALLS` is **not** declared (8 permissions present, none of them `MANAGE_OWN_CALLS`), and the app is not a dialer. `CallMonitorService.kt:71` calls the 2-arg `startForeground(id, notification)`, which per the docs defaults the type to the manifest value — so the prerequisite check still runs.

> If your app doesn't fulfill all of the runtime requirements for starting a foreground service, the system throws a **SecurityException** after you call `startForeground()`.

The user taps "Enable Auto-Reply" → `CallMonitorService.start()` → **crash**. This happens on the very first interaction, on any Android 14/15/16 device.

---

## 4. The reboot path is explicitly forbidden on Android 15+

The app targets `compileSdk = 35` / `targetSdk = 35` (Android 15). `BootReceiver.kt:44` calls `CallMonitorService.start(context)` from `ACTION_BOOT_COMPLETED`. From the [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15):

> `BOOT_COMPLETED` receivers are **not** allowed to launch the following types of foreground services: dataSync, camera, mediaPlayback, **phoneCall**, mediaProjection, microphone. If a `BOOT_COMPLETED` receiver tries to launch any of those types, the system throws `ForegroundServiceStartNotAllowedException`.

So the "Survives Reboot" feature listed in the README is not just unreliable — it is a documented crash on the exact SDK level this project targets.

---

## 5. Google Play will reject it — and this is the part that matters

This is the strategic blocker, and it's not fixable by writing better code.

`AndroidManifest.xml` declares `SEND_SMS` and `READ_CALL_LOG`. Both are in restricted permission groups. From the [Play Console SMS/Call Log policy](https://support.google.com/googleplay/android-developer/answer/10208820):

> Apps must be **actively registered as the default SMS, Phone, or Assistant handler** before prompting users to accept any of SMS or Call Log permissions.
>
> **If your app doesn't qualify for access to Call Log or SMS permissions, you must remove these permissions from your app's manifest.**

The listed exceptions are narrow (backup/restore, enterprise archives, caller ID/spam blocking, cross-device sync, connected-device companions, physical-safety apps, device automation…). "Automatically text back someone who missed my call" is not among them, and the auto-reply-SMS use case has a well-documented history of rejections.

And `READ_CALL_LOG` isn't optional here — it's load-bearing. Per the [TelephonyManager docs](https://developer.android.com/reference/android/telephony/TelephonyManager), `EXTRA_INCOMING_NUMBER` is only populated if the receiver holds `READ_CALL_LOG`. Remove it and the app has no idea who called.

**Net:** the app as designed cannot be on the Play Store. The only way to keep it is to become the user's default dialer *and* default SMS app — i.e. ship a full dialer with in-call UI plus a full messaging app. That is a 10–20× scope increase and Play still reviews it hard.

### And the sideload escape hatch is also compromised

The obvious workaround ("just distribute the APK directly") is worse than it sounds. `SEND_SMS` is documented as a **hard-restricted permission** — *"cannot be held by an app until the installer on record allowlists the permission."* The Android 15 CDD extended Restricted Settings to cover the **SMS runtime permission** and the **default SMS/dialer roles** for any app not installed via an app store. So a sideloaded user on Android 15+ sees the SMS toggle **greyed out** and must go to App info → ⋮ → *Allow restricted settings* → Permissions → SMS → Allow. Your target user — a plumber or electrician who just wants to stop losing leads — will not do that, and you cannot prompt them into it from inside the app.

---

## 6. Additional defects (would survive fixing the above)

| # | Location | Defect |
|---|---|---|
| 1 | `SmsHandler.kt:136-152` | **Number filter rejects most valid numbers.** `invalidPatterns` contains `"0"` and the test is `cleanNumber.contains(it)` — substring, not equality. Any number containing a `0` is rejected. `"-1"` also rejects e.g. `+1-212-555-1234` and `(555) 123-1234`. Should be `==` on the whole string, or better, `PhoneNumberUtils.isGlobalPhoneNumber()`. |
| 2 | `CallReceiver.kt:33-82` | **Double-broadcast race.** Because the manifest declares *both* `READ_CALL_LOG` and `READ_PHONE_STATE`, the docs state the receiver fires **twice** per state change — once with the number, once blank — in **unspecified order**. Line 48 does `incomingNumber = phoneNumber` unconditionally, so if the blank broadcast lands second the number is nulled and the missed call is missed. Roughly coin-flip reliability, non-deterministic. |
| 3 | `CallReceiver.kt:28-30` | State lives in `companion object` statics. If the process is killed between `RINGING` and `IDLE` (common under OEM battery managers), state resets to `lastState = IDLE` / `isIncoming = false` and the missed call is silently dropped. Needs persistence, not statics. |
| 4 | `CallReceiver.kt:89` | `CoroutineScope(Dispatchers.IO).launch` inside `onReceive` with no `goAsync()`. The receiver's process can be reclaimed the moment `onReceive` returns, killing the work mid-flight. Correct pattern is `goAsync()` + `pendingResult.finish()`. |
| 5 | `SmsHandler.kt:108` | No `divideMessage` / multipart handling; `null` sent/delivery `PendingIntent` means send failures are invisible — the counter increments and the user is never told. |
| 6 | `AppPreferences.kt:182,187` | Debounce keys are created per phone number and never pruned → unbounded DataStore growth. |
| 7 | `HomeScreen.kt:135-138` | Toggle with missing permissions launches the permission dialog then `return@Switch` — the switch silently does nothing. User must grant, then toggle again. No callback resumes the flow. |
| 8 | `themes.xml` | Parent `android:Theme.Material.Light.NoActionBar` is a platform theme; with `enableEdgeToEdge()` + Material 3 dynamic color you want a Material3/`Theme.Material3.*` base. Causes wrong status/nav bar and splash behavior. |
| 9 | Manifest | No `<uses-feature android:name="android.hardware.telephony" android:required="true" />`. |
| 10 | `ic_launcher.xml` | Foreground is `@android:drawable/sym_action_call` — a framework bitmap in an adaptive-icon layer, no safe-zone padding. Not a build failure; the launcher icon just looks broken. There is also no `drawable/` directory and no legacy density buckets. |
| 11 | Whole project | **Zero tests.** `testImplementation`/`androidTestImplementation` are declared in `app/build.gradle.kts` but there are no `test/` or `androidTest/` source directories. |
| 12 | `AppPreferences.kt:23` | `preferencesDataStore` delegate declared inside a `companion object` rather than at file top level. Works, but is non-idiomatic and easy to break when someone adds a second accessor. |

---

## 7. What's actually salvageable

| Layer | Lines | Verdict |
|---|---|---|
| Compose UI + theme + nav (`ui/**`) | 1,249 (57%) | **Reusable.** Material 3, clean structure. Needs the 2 missing strings and the theme parent fixed. |
| `data/AppPreferences.kt` | 203 (9%) | **Reusable** after `collect` → `first()` on 7 methods and pruning the debounce map. |
| Core pipeline (`CallReceiver`, `SmsHandler`, `CallMonitorService`, `BootReceiver`) | 453 (21%) | **Not salvageable.** The approach is platform-invalid; every one of the four files has to be replaced, not patched. |
| Build config / manifest / res | ~290 | Rewrite manifest permissions entirely. |

So: roughly **two-thirds of the code is keepable scaffolding**, and the entire 21% that *is* the product has to be thrown away.

---

## 8. The three real paths forward

### Option A — Server-side telephony. *(Recommended if you want the actual product.)*
Give the user a real business number via Twilio / Telnyx / Plivo. Calls hit that number, the provider fires a no-answer webhook, **your server** sends the SMS.

- **Zero** restricted Android permissions. No SMS, no call log, no FGS, no battery-optimization begging, no Play policy fight.
- Works identically on **iPhone**, and on Androids where the OEM killed your background process.
- Reliable: no RINGING→IDLE state machine, no double-broadcast race, no process death.
- Play-approved with a boring normal permission set.
- **Cost:** recurring per-user telephony spend; user must set up/forward a number. This is exactly how the funded competitors in this space are built, because on-device is not survivable.

### Option B — On-device, one-tap instead of fully automatic. *(Recommended if you want zero infrastructure.)*
Detect the missed call via `CallScreeningService` + `ROLE_CALL_SCREENING` (API 29+; per the docs this *"eliminates the requirement to obtain the READ_CALL_LOG permission"*), then post a notification with a **"Send reply"** action that fires `Intent.ACTION_SENDTO` with the message pre-filled into the user's own SMS app.

- No `SEND_SMS`, no `READ_CALL_LOG`, no `phoneCall` FGS → **no Play rejection surface**.
- Caveats to validate before committing: `ROLE_CALL_SCREENING` is a user-granted role; per the API docs only calls from numbers **not in the user's contacts** are passed for screening unless you also hold `READ_CONTACTS`, and you must call `respondToCall` within 5 seconds. Test on Samsung/Xiaomi, not just Pixel.
- Honest tradeoff: it's one tap, not zero. For "don't lose the lead," one tap usually still wins — and the user stays in control of what gets sent, which is arguably better for a business tool.

### Option C — Ship it as-is, off-Play, to a handful of technical users.
Only makes sense as a personal tool. You'd still have to fix §1–§4 and §6.1–§6.2 first, and every install needs the manual *Allow restricted settings* dance.

**Don't do:** try to satisfy Play by becoming the default dialer + default SMS handler. You'd be building two complete apps to hang one feature off the side.

---

## 9. What I could not verify here

I want to be precise about the boundary of this audit:

- **I could not compile or run the project.** This sandbox has no JDK, no Gradle, and no Android SDK, and every host the build needs (`services.gradle.org`, `dl.google.com`, `maven.google.com`) is network-blocked — I confirmed `HTTP 000` for all three. So there is **no build log and no device test** behind this audit.
- What I *did* verify: the missing-resource findings come from a deterministic cross-reference I ran over the source; the DataStore finding comes from reading the actual `DataStoreImpl.kt` in the AndroidX repo; the FGS and Play-policy findings are quoted from `developer.android.com` and `support.google.com`.
- I have **not** verified the Android 14/15 crashes empirically on hardware, and I have **not** submitted anything to Play. Those conclusions are read off the platform's own documented enforcement rules, which state the exception types explicitly (`SecurityException`, `ForegroundServiceStartNotAllowedException`).
- Option B's viability is reasoned from the platform docs, not prototyped. Prototype the `CallScreeningService` path on a real device before you commit to it.
