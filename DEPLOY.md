# Deploying Missed Call Reply

Status as of this branch: the server is complete and tested (**97 tests**,
`cd server && npm test`). What follows is everything that still needs a human,
because each step needs credentials or account access that cannot be handled
from a checkout.

## 1. Vercel project — already created

| Setting | Value |
| --- | --- |
| Project name | `missed-call-reply` |
| Project ID | `prj_0Mz2FtD8g8Np3BF3r7Ud7DrEXFoY` |
| Root Directory | `server` (already set) |
| `PROVIDER` | `telnyx` (already set) |
| Node version | 24.x |
| Region | `iad1` |

Two things still need doing in the dashboard:

**Connect the Git repository.** The project was created without a Git link
(the available API rejected both accepted shapes for it). In
*Settings → Git*, connect `jasonmanuel-cmd/mctb` and confirm Root Directory is
`server`. Without this, pushes do not deploy.

**Turn off Deployment Protection.** New Vercel projects enable SSO protection
for all deployments except custom domains. Telnyx cannot authenticate through
it, so **every webhook would receive a 401 and no call would ever be seen.**
*Settings → Deployment Protection → Vercel Authentication → Off* (or restrict
it to Preview deployments only).

## 2. Environment variables

Required — the server refuses to start without these:

| Variable | Where to get it |
| --- | --- |
| `PUBLIC_BASE_URL` | Your deployment origin, e.g. `https://missed-call-reply.vercel.app`. No trailing slash. |
| `TELNYX_API_KEY` | Telnyx Mission Control → API Keys |
| `TELNYX_PUBLIC_KEY` | Mission Control → Keys & Credentials → **Public** Key |

`TELNYX_PUBLIC_KEY` is a **public** key, 32 bytes, base64. Pasting the *API* key
there makes every webhook fail verification, and it looks identical to a network
problem. The API key goes in `TELNYX_API_KEY` only.

Strongly recommended:

| Variable | Why |
| --- | --- |
| `REDIS_REST_URL` | **Required in practice on Vercel.** The filesystem is ephemeral and not shared between invocations, so the default file store loses subscriber settings silently. Create a free Upstash Redis and copy the REST URL. |
| `REDIS_REST_TOKEN` | Pairs with the above. Set both or neither — half-configured is a deliberate startup error. |
| `API_KEY` | Enables the control panel and settings API. Without it, writes are refused. |

## 3. Point Telnyx at the webhooks

Buy a number in Telnyx Mission Control, then on its Voice settings:

| Setting | Value |
| --- | --- |
| Webhook URL (voice) | `https://<your-host>/voice` |
| Method | POST |
| TeXML application | leave blank — the server generates TeXML per call |

And on the number's Messaging / call-progress settings, the status callback:

| Setting | Value |
| --- | --- |
| Call completed webhook | `https://<your-host>/voice/completed` |
| Method | POST |

Both are verified with Ed25519 over `timestamp|body` using
`TELNYX_PUBLIC_KEY`, with a 300-second replay window.

## 4. Verify it works

```bash
curl https://<your-host>/healthz
# {"ok":true,"runtime":"serverless"}
```

That endpoint answers even when configuration is broken, on purpose: a 200 with
a working deployment but a 500 `configuration_error` on other paths means the
code is fine and an environment variable is wrong. The error names the missing
variable.

Then open `https://<your-host>/panel`, enter the `API_KEY`, and add your
subscriber. Finally, call the Telnyx number from a phone and let it ring out —
the reply should arrive as an SMS.

## 5. The constraint that cannot be engineered away

Callers must dial **the Telnyx number**, not the subscriber's personal SIM.
Neither Telnyx nor Twilio can see a call that never reaches them, and carrier
call-forward-on-no-answer is not a workaround: the server would dial the number
that just forwarded, and loop. The subscriber publishes the Telnyx number as
their work line.

## 6. Android app — still blocked

The Play Store side has never been compiled. GitHub Actions refuses to start any
job on this repository with:

> The job was not started because your account is locked due to a billing issue.

That is an account-level lock, not a workflow defect. Once billing is resolved,
`.github/workflows/android-ci.yml` runs `assembleDebug testDebugUnitTest`, a
non-blocking `lintDebug`, and an `assembleRelease`, uploading the APK, test and
lint reports as artifacts.

The release build is **unsigned in CI**, because the workflow supplies no
secrets. Signing is already wired in `app/build.gradle.kts` but conditional, so
a fresh clone still compiles instead of failing for want of a keystore. To
produce an uploadable AAB, supply these Gradle properties (in
`~/.gradle/gradle.properties`, or as CI secrets):

```
MCTB_KEYSTORE=/absolute/path/to/release.jks
MCTB_STORE_PASSWORD=...
MCTB_KEY_ALIAS=...
MCTB_KEY_PASSWORD=...
```

No keystore is committed, and none should be. Prefer Play App Signing with a
local upload key.

`docs/PRIVACY_POLICY.md` still contains a literal
`**[INSERT CONTACT EMAIL BEFORE SUBMITTING]**`. Play requires a reachable
contact address, so this must be replaced before submission.
