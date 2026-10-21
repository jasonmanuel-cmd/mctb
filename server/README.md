# Missed Call Reply — server

The server-side half of Missed Call Reply. It detects an unanswered call and sends
the text itself, with **no tap and no app running on the subscriber's phone**.

This is the "truly automatic" mode. See `../README.md` for how it relates to the
Android app.

- Zero runtime dependencies. `node:http`, `node:crypto`, global `fetch`.
- Node 20+.
- 58 tests, including integration tests over real sockets with real Twilio
  signatures. No mocking of the HTTP layer, no network access needed to run them.

```
npm test      # 58 tests, ~0.9s
npm start     # needs the env vars below
```

## How it works

```
Caller dials your Twilio number
        ↓
POST /voice                          ← Twilio webhook, signature-checked
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
| `TWILIO_ACCOUNT_SID` | yes | account the numbers belong to |
| `TWILIO_AUTH_TOKEN` | yes | REST auth **and** webhook signature verification |
| `PUBLIC_BASE_URL` | yes | absolute origin Twilio reaches you at |
| `PORT` | no | default 3000 |
| `STORE_PATH` | no | file backend path, default `./data/subscribers.json` |
| `REDIS_REST_URL` | no | Redis REST endpoint; enables the serverless backend |
| `REDIS_REST_TOKEN` | no | pairs with `REDIS_REST_URL` — set both or neither |
| `API_KEY` | no | enables the settings API and panel; without it writes are refused |
| `LOG_LEVEL` | no | `debug`/`info`/`warn`/`error`, default `info` |

`PUBLIC_BASE_URL` is not cosmetic. Twilio signs the **full URL it called**, so if
you guess the origin from the `Host` header behind a proxy the signature will not
match and every webhook will 403. Set it explicitly.

Then point each Twilio number's **Voice webhook** at `https://you/voice`
(POST). Nothing else needs configuring in the Twilio console.

### Smoke test

```bash
TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=tok \
PUBLIC_BASE_URL=https://mctb.example.com PORT=8931 \
STORE_PATH=/tmp/subs.json API_KEY=sekret npm start
```

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

- **No billing.** The free tier of 5 is enforced (`quota-exhausted`), but there is
  no Stripe/Play bridge to flip `unlimited`. That is a `PUT` away once a payment
  provider is chosen.
- **The control panel is operator-facing.** It authenticates with the single
  `API_KEY`, so it configures *every* number. There is no per-subscriber access, so
  you cannot hand it to a customer to self-serve — that needs a per-subscriber token
  scoped to one number.
- **No outbound status tracking.** Sent messages are not confirmed delivered; a
  status callback would be needed for that.
