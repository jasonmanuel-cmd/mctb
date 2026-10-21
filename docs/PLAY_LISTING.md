# Play Console submission pack

Copy-paste material for the store listing and the required declaration forms.

---

## 1. App name

```
Missed Call Reply
```

30 characters or fewer. Play requires uniqueness across the store; if this is taken,
try `Missed Call Reply - Auto Text` or `Missed Call Auto Reply`.

## 2. Short description (max 80 characters)

```
Miss a call, get your reply ready to send in one tap. Built for tradespeople.
```

77 characters (Play's limit is 80 — verify with `wc -c` before editing this).

**Do not** use wording like "automatically texts back" or "auto-replies for you". The
app prepares the message; the user presses send. Describing it as fully automatic
misrepresents it and is a straightforward rejection.

## 3. Full description

```
Miss one call and you can lose the job. Missed Call Reply makes sure that does not
happen.

When a call rings out, the app immediately puts your own message on screen, ready to
go to the person who called. One tap opens your messaging app with their number and
your message already filled in — you just press send.

MADE FOR PEOPLE WHOSE HANDS ARE FULL
Electricians, plumbers, builders, cleaners, drivers, consultants. Anyone who cannot
pick up while working, but cannot afford to go quiet either.

WHAT IT DOES
• Catches calls you do not answer, including ones you decline
• Prepares the message you wrote, addressed to the right person
• Sends nothing without you pressing send — you are always in control
• Active hours, so it stays quiet outside the times you choose
• 30-minute cool-down per caller, so one persistent redialler does not get three
  messages

SET IT UP IN ABOUT A MINUTE
1. Allow call screening, so the app can see who is calling
2. Allow notifications, so the reply reaches you
3. Write your message — or keep the one we provide
4. Turn it on

YOUR DATA STAYS ON YOUR PHONE
No account. No analytics. No adverts. The app does not read your call log, does not
read or store your messages, and does not read your contacts. A caller's number is
kept on your device for 30 minutes, purely so you are not prompted twice, then
deleted. Nothing is uploaded anywhere.

FREE TO START
Five replies are free. A single one-time purchase removes the limit for good.

WORTH KNOWING
Android only lets an app see calls from numbers that are not in your contacts, so
calls from saved contacts will not trigger a prompt. That is an Android restriction,
not a setting you can change. Calls from withheld or private numbers cannot be replied
to, because there is no number to send to.
```

## 4. Category and tags

- **Application category:** Tools
- **Tags:** `missed call`, `auto reply`, `text`, `business`, `tradesperson`
- **Contains ads:** No
- **In-app purchases:** Yes — one-time item, price set in Play Console

## 5. Content rating

Complete the IARC questionnaire. Expected result: **Everyone / 3+**. There is no user
generated content, no messaging between users (the app hands off to the device's own
SMS app), no gambling and no data sharing.

Answer "No" to "Does your app allow users to communicate?" — the app does not provide a
communication channel; it prepares a message for the system messaging app.

## 6. Data safety form

| Question | Answer |
|---|---|
| Does your app collect or share user data? | **No** |
| Is all data encrypted in transit? | N/A — no data leaves the device |
| Can users request data deletion? | Yes — uninstall, or Settings → Apps → Clear data |

Do **not** declare phone numbers as collected. They are processed transiently on-device
and are not transmitted, which is what "collected" means in Play's definition. If you
later add analytics or crash reporting, this answer must change.

## 7. Permissions declaration form

**Not required.** The manifest declares no SMS permission and no Call Log permission.

Verify before submitting:

```bash
grep uses-permission app/src/main/AndroidManifest.xml
```

Expected output — three lines, none of them `SEND_SMS`, `READ_SMS` or `READ_CALL_LOG`:

```
android.permission.READ_PHONE_STATE
android.permission.POST_NOTIFICATIONS
com.android.vending.BILLING
```

## 8. Foreground service declaration

**Not required.** The app declares no `<service>` with a `foregroundServiceType`.

## 9. In-app product

Create before the first release, or the upgrade screen will report the product as
unavailable:

| Field | Value |
|---|---|
| Product ID | `unlimited_replies` — must match `BillingManager.PRODUCT_ID_UNLIMITED` |
| Type | In-app product (one-time, non-consumable) |
| Name | Unlimited replies |
| Description | Remove the reply limit, forever |

The product only resolves once a build is live on a track (internal testing is enough).
Until then the app shows "Upgrade unavailable", by design, and the free tier still
works.

## 10. Graphics you still need

| Asset | Spec |
|---|---|
| App icon | 512 × 512 PNG, 32-bit with alpha |
| Feature graphic | 1024 × 500 PNG or JPEG |
| Phone screenshots | At least 2, 16:9 or 9:16 |

The repo contains the adaptive launcher icon as a vector, but Play needs a separate
512 × 512 PNG upload — the adaptive icon is not reused for the store listing.

## 11. Pre-submission checklist

- [ ] Replace the contact email placeholder in `docs/PRIVACY_POLICY.md` and host it at a
      public URL
- [ ] Enter that URL in Play Console → App content → Privacy policy
- [ ] Create the `unlimited_replies` in-app product and activate it
- [ ] Add a `signingConfig` and build a signed AAB: `./gradlew bundleRelease`
- [ ] `targetSdk` is 35 — meets the current Play target API requirement
- [ ] Test on real hardware: grant call screening, miss a call from an **unsaved**
      number, confirm the prompt appears and the messaging app opens pre-filled
- [ ] Test the upgrade purchase with a licence-testing account
- [ ] CI is green — `assembleDebug`, `testDebugUnitTest` and `assembleRelease` all pass
- [ ] Store listing does not claim fully automatic sending
