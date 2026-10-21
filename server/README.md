# Missed Call Reply — server

The server-side half of Missed Call Reply. It detects an unanswered call and sends
the text itself, with **no tap and no app running on the subscriber's phone**.

This is the "truly automatic" mode. See `../README.md` for how it relates to the
Android app.

- Zero runtime dependencies. `node:http`, `node:crypto`, global `fetch`.
- Node 20+.
- Works with **Twilio or Telnyx** behind one provider seam.
- 124 tests, including integration tests over real sockets with real webhook
  signatures (HMAC-SHA1 for Twilio, Ed25519 for Telnyx). No mocking of the HTTP
  layer, no network access needed to run them.

```
npm test      # 124 tests, ~1.2s
npm start     # needs the env vars below
```

## How it works

```
Caller dials your Twilio/Telnyx number
        ↓
POST /voice                          ← carrier webhook, signature-checked
        ↓
TwiML: <Dial action="/voice/completed"> your real number </Dial>
        ↓
Your phone rings
        ↓
  you answer   → DialCallStatus=completed  → nothing happens
  you don't    → DialCallStatus=no-answer  ↓
                 (also busy / failed)
        ↓
POST /voice/completed                ← signature-checked
        ↓
decideReply(): enabled? · caller replyable? · inside active hours?
               · quota left? · not texted in last 30 min?
        ↓
Twilio Messages API → the caller gets your text
```

Twilio reports a call you *rejected* as `no-answer` too, so a declined call also
gets a reply. `completed` and `canceled` never do.

## The constraint you have to accept

**Callers must dial the Twilio number, not your personal number.**

Twilio can only see calls that reach Twilio. It has no visibility into a call made
directly to a mobile SIM, so the on-device app is the only thing that can see those
— and on-device auto-send is what Play policy forbids.

In practice that means publishing the Twilio number as your work line, which is
usually what a tradesperson wants anyway: one number for the job that rings your
mobile, answers with a text when you are up a ladder, and keeps work calls off your
personal SIM. Callers already stored in your contacts are unaffected; it is your
*customers* who need the new number.

Carrier call-forward-on-no-answer to the Twilio number is *not* a workaround — Twilio
would then dial the number that just forwarded, and loop.

## Deployment

Environment:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PROVIDER` | no | `twilio` (default) or `telnyx` |
| `TWILIO_ACCOUNT_SID` | twilio | account the numbers belong to |
| `TWILIO_AUTH_TOKEN` | twilio | REST auth **and** webhook signature verification |
| `TELNYX_API_KEY` | telnyx | Messaging API auth |
| `TELNYX_PUBLIC_KEY` | telnyx | account Ed25519 **public** key for webhook verification |
| `PUBLIC_BASE_URL` | yes | absolute origin the carrier reaches you at |
| `PORT` | no | default 3000 |
| `STORE_PATH` | no | file backend path, default `./data/subscribers.json` |
| `REDIS_REST_URL` | no | Redis REST endpoint; enables the serverless backend |
| `REDIS_REST_TOKEN` | no | pairs with `REDIS_REST_URL` — set both or neither |
| `API_KEY` | no | enables the settings API and panel; without it writes are refused |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | no | service account key JSON; enables purchase verification |
| `GOOGLE_PLAY_PACKAGE_NAME` | with the above | the Android application id |
| `GOOGLE_PLAY_PRODUCT_ID` | no | in-app product id, default `unlimited_replies` |
| `LOG_LEVEL` | no | `debug`/`info`/`warn`/`error`, default `info` |

`PUBLIC_BASE_URL` is not cosmetic. **Twilio** signs the full URL it called, so if you
guess the origin from the `Host` header behind a proxy the signature will not match
and every webhook will 403. Set it explicitly.

Then point each number's voice webhook at `https://you/voice` (POST), and the call
progress / status callback at `https://you/voice/completed`.

### Vercel

`api/index.js` is a serverless adapter over the same `app.handle` the
long-running server uses, so both hosting models share one routing path and a
fix in one cannot survive as a bug in the other.

`vercel.json` rewrites every non-`/api` path to the function and forwards the
original path as `?__path=`:

```json
{ "source": "/((?!api/).*)", "destination": "/api?__path=/$1" }
```

That forwarding is not decorative. Whether a rewrite preserves `req.url` depends
on the runtime and function type — Vercel's routing docs say the destination
"only selects which route runs, not the path your code sees", but there are
filed cases of every request arriving as the destination path and 404ing. Rather
than bet on one behaviour, the adapter treats `__path` as authoritative when
present and falls back to `req.url` when running under node.

`req.url` is then rewritten in place, because `routes.js` builds the webhook
signature URL as `publicBaseUrl + req.url`. Leaving `?__path=` attached would
fail verification on **every** Twilio webhook: Twilio signs the URL it
requested, not the rewritten one.

Two things a real deployment's compiled route table showed, neither reachable
from a local test:

- `source` is compiled with **path-to-regexp**, which is stricter than the
  RegExp constructor. A negative lookahead such as `/((?!api(/|$)).*)` is a
  valid RegExp and was still rejected outright — *"Rewrite at index 0 has
  invalid `source` pattern."* Stick to literal segments and `:params`; a test
  now rejects anything else.
- Vercel **percent-encodes the destination**, so the function receives
  `?__path=%2Fvoice%2Fcompleted`. `searchParams.get` decodes it, but the
  encoded form is tested explicitly rather than left to inference. Routes with
  a `:param` also arrive with an extra `&number=` appended.

Three things to get right on the project settings:

- **Root Directory** must be `server`.
- **Deployment Protection** (SSO) is on by default for new projects and answers
  carrier webhooks with a 401. Turn it off, or no call will ever be seen.
- The **file store does not work on serverless** — the filesystem is ephemeral
  and not shared between invocations, so subscriber settings vanish silently.
  Configure Upstash Redis (`REDIS_REST_URL` + `REDIS_REST_TOKEN`).

### Smoke test

```bash
TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=tok \
PUBLIC_BASE_URL=https://mctb.example.com PORT=8931 \
STORE_PATH=/tmp/subs.json API_KEY=sekret npm start
```

## Twilio or Telnyx

Both work; the call-flow logic is shared and only signature verification and the
SMS call sit behind the seam. Telnyx's TeXML is deliberately TwiML-compatible —
same form-encoded webhooks, same `From`/`To`/`DialCallStatus` field names, same
status values — which is what makes sharing that logic safe rather than lucky.

| | Twilio | Telnyx |
| --- | --- | --- |
| Webhook auth | HMAC-SHA1 over URL + sorted params, shared secret | Ed25519 over `timestamp\|body`, account **public** key |
| Replay protection | none built in | timestamp header, 5-minute window enforced here |
| SMS request | form-encoded, Basic auth, `Body` | JSON, Bearer auth, `text` |
| Max ring timeout | 600s | 120s |
| Typically | dearer per message, widest docs | cheaper, especially international |

Two consequences worth knowing:

- **The Telnyx path is the more secure of the two**, and not because of anything
  done here. Ed25519 means a leaked *public* key cannot forge a webhook, and the
  timestamp window blocks replaying a captured request. Twilio's shared secret can
  do both if it leaks.
- **`TELNYX_PUBLIC_KEY` is a public key.** Pasting your API key there instead will
  make every webhook fail verification, and the failure looks identical to a
  network problem. The key is in Mission Control → Keys & Credentials → Public Key.

Provider selection is `PROVIDER=twilio|telnyx`; the required credentials change
with it, and naming the wrong set is a startup error rather than a runtime one.

## Control panel

`https://you/panel` — a self-contained page for configuring numbers. No build step,
no framework, no CDN, so it works on a phone in a basement with one bar of signal.

It authenticates with the same `API_KEY` and calls the same settings API as curl, so
there is one write path and no separate admin surface to secure. The key is held in
`sessionStorage` only; it is never embedded in the served HTML (there is a test for
that, because shipping the key in the page would hand it to anyone who fetches it).

If `API_KEY` is unset the panel and the API both refuse rather than silently allowing
unauthenticated writes.

## Settings API

Bearer-authenticated, disabled entirely unless `API_KEY` is set.

```bash
curl https://you/subscribers                      # list
curl -X PUT https://you/subscribers/%2B15559000001 \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"enabled":true,"forwardTo":"+15558000002","message":"On a job, will call back."}'
```

`activeHours` takes `startMinuteOfDay`/`endMinuteOfDay` (0–1439) and `alwaysOn`.
Identical bounds mean all day. A window that crosses midnight is supported.
Unknown fields are dropped; invalid values return 422 rather than being stored.

### Two kinds of credential

The `API_KEY` is the **operator** key. It configures every number, so it can
never be given to a customer.

Every subscriber also has its own `apiToken`, issued automatically and used the
same way — `Authorization: Bearer <apiToken>`. It authenticates the caller *and*
identifies which number they are, which the phone app has no other way of
knowing. With it:

```bash
curl https://you/me                                    # own settings
curl -X PATCH https://you/me -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"message":"Tied up until 4."}'
curl -X POST https://you/billing/verify -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"purchaseToken":"..."}'
```

`/me` accepts a deliberately narrower set of fields than the operator API.
`unlimited` and `limit` are absent, because a customer who could set them would
not need to buy anything; `apiToken` is absent so a stolen token cannot be
rotated to lock the real owner out.

The operator retrieves a customer's token from a dedicated endpoint, so it is
the operator — not a list response — that puts a credential in shell history:

```bash
curl https://you/subscribers/%2B15559000001/token -H "Authorization: Bearer $API_KEY"
```

## Storage

Two backends behind one interface — `byTwilioNumber`, `upsert`, `recordReply`,
`lastReplyAt`, `all`. Nothing above the store knows which one is in use, and every
method is async so a networked backend needs no changes further up.

**File (`src/store.js`)** — default. One JSON document, replaced atomically via
write-temp-then-rename. Safe against a torn write and against a crash.

> **Do not use this on a serverless host.** Serverless filesystems are ephemeral and
> not shared between invocations, so the panel would appear to save and the next
> webhook would find no subscriber and send nothing — a silent failure, which is the
> worst kind. Use Redis there.

**Redis (`src/store-redis.js`)** — use this on Vercel, Fly, Cloud Run or anything
else that does not guarantee a persistent disk. Talks to the Redis REST API (Upstash
and compatible) over `fetch`, so it keeps the zero-dependency property.

```
REDIS_REST_URL=https://...upstash.io
REDIS_REST_TOKEN=...
```

Set both or neither. Setting only one is a startup error rather than a silent
fallback to the file store, because on serverless that fallback is the data-loss bug
above.

`all()` reads a maintained index set, never `KEYS` — `KEYS` blocks a Redis server.
There is a test asserting no `KEYS` command is ever issued.

**Shared limitation:** both backends do read-modify-write with no cross-process lock,
so two simultaneous missed calls for one subscriber can race on `replyCount`. The
consequence is a reply counted twice, not a lost message — which is the right way
round for this product.

To scale past that, add a backend with a transactional increment and keep the same
five methods.

## Security

- Every Twilio-facing route verifies `X-Twilio-Signature` (HMAC-SHA1, base64,
  constant-time compare) before acting. An unsigned or tampered request gets 403.
  Without this, anyone who guesses the URL could send SMS on your bill.
- Request bodies are capped at 64 KB.
- TwiML output is XML-escaped; the settings API whitelists fields rather than
  spreading the request body into the stored record.
- A failed SMS send does **not** consume quota, so a Twilio outage cannot eat a
  subscriber's five free replies.

## What is not done

- **Refunds are not revoked automatically.** A cancelled purchase is refused at
  verification time, but a refund *after* the unlock is not detected: the Play
  Developer API answer for a refunded in-app product is not reliably immediate.
  Closing that needs the Voided Purchases API or Real-time Developer
  Notifications on a schedule.
- **The control panel itself is still operator-facing.** Per-subscriber tokens now
  exist and are what the phone app uses, but `panel.js` only authenticates with the
  shared `API_KEY`. Handing a customer a web UI of their own means teaching the panel
  to accept an `apiToken` and scope itself to `/me`.
- **No outbound status tracking.** Sent messages are not confirmed delivered; a
  status callback would be needed for that.
