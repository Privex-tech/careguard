# Runbook: Tuning Rate-Limit Thresholds Safely

**Symptom**

One of two opposite failure modes, both reported the same way — a `429 Too
Many Requests` response and, on the dashboard, a failed poll or a stuck
"Connected" chip:

1. **Threshold too tight (false positives)** — legitimate caregiver traffic
   (dashboard polling, a burst of agent runs, a batch of bill audits) gets
   throttled. `ratelimit_hits_total{policy="<name>"}` climbs in step with
   normal usage, not with anything malicious.
2. **Threshold too loose / real abuse** — a client hammers one endpoint
   (most concerning on `pharmacy_order` or `bill_audit`, both money- and
   payload-heavy) fast enough that rate limiting is the *only* thing
   standing between it and the LLM provider, the bill-audit pipeline, or a
   Stellar payment submission.

This runbook covers reading `ratelimit_hits_total`/`route_concurrent_requests`
to tell the two apart, and how to change a threshold in
[`shared/rate-limit.ts`](../../shared/rate-limit.ts) without causing the
first failure mode while fixing the second.

---

**Impact**

- **Failure mode 1** (too tight): every caregiver polling the dashboard
  behind the affected policy is degraded or blocked until the threshold is
  raised or the window (60s, fixed — see below) rolls over.
- **Failure mode 2** (too loose / abuse): downstream systems absorb the
  excess — the LLM provider (see
  [`llm-rate-limit.md`](llm-rate-limit.md)), the bill-audit pipeline, or
  Stellar Horizon, which enforces its own **3,600 requests/hour per source
  IP** limit by default (`PER_HOUR_RATE_LIMIT`), per Stellar's own Horizon
  API reference. Horizon returns a `429` when this is exceeded, and the
  limit can be disabled entirely (`PER_HOUR_RATE_LIMIT=0`) by whoever
  operates that Horizon instance. A pharmacy-order threshold raised
  without considering this can shift the bottleneck from CareGuard's own
  429 to a Horizon 429 further downstream instead of actually fixing
  anything.
- No audit-log or payment data is lost either way — rate limiting rejects
  the request before any handler runs, so nothing partially applies.

---

## Environment Variables (`shared/rate-limit.ts`)

Every rate limiter in this file shares one fixed **60-second window**
(`DEFAULT_WINDOW_MS = 60_000`, `shared/rate-limit.ts:18`) — **there is no
environment variable to change the window itself**, only the request count
allowed inside it. "Tuning" in this codebase means raising or lowering
`max`, never the window length.

Malformed values are handled by `parseLimitEnv()`
(`shared/rate-limit.ts:28`): unset, empty, non-integer, or `<= 0` all fall
back silently to the documented default — there is **no startup log or
error** when this happens, so a typo'd variable name or a bad value looks
identical to "using the default." See "Confirm the value actually took
effect," below, for how to check.

### Env-configurable, per-route policies (`perRouteLimiters`)

These five are the only rate-limit values this codebase lets you tune via
environment variable. All read once at module load — **changing any of
them requires a process restart**, there is no hot-reload path (no
`SIGHUP` handler touches these, unlike the agent wallet key — see
[`rotate-render-secrets.md`](rotate-render-secrets.md) for that contrast).

| Env var | Default | Policy label | Route |
|---|---|---|---|
| `RATE_LIMIT_AGENT_RUN` | `5` | `agent_run` | `POST /agent/run` |
| `RATE_LIMIT_BILL_AUDIT` | `20` | `bill_audit` | `POST /bill/audit` |
| `RATE_LIMIT_PHARMACY_COMPARE` | `30` | `pharmacy_compare` | `GET /pharmacy/compare` |
| `RATE_LIMIT_DRUG_INTERACTIONS` | `30` | `drug_interactions` | `GET /drug/interactions` |
| `RATE_LIMIT_PHARMACY_ORDER` | `10` | `pharmacy_order` | `POST /pharmacy/order` |

(Defaults are `RATE_LIMIT_DEFAULTS` in `shared/rate-limit.ts:75`; routes
confirmed against the mount points in `server.ts`.)

### Hardcoded policies — not env-configurable

These exist in the same file and share the same `ratelimit_hits_total`
metric, but **have no environment variable today**. This matters directly
for "without locking out the dashboard," below.

| Policy label | Max | Mounted on |
|---|---|---|
| `agent` | `5` | **All** of `/agent/*` (`app.use("/agent", rateLimiters.agent)`) |
| `default` | `60` | Every route, as a global fallback (`app.use(rateLimiters.default)`) |
| `x402` | `30` | Defined but not currently mounted on any route — dead code as of this writing |
| `health` | unlimited | `/health` — a true pass-through, never counted in `ratelimit_hits_total` |

**The interaction that actually locks out the dashboard**: the dashboard's
read-heavy polling — `use-agent-state.ts` polls `/agent/spending` every 3s
(SSE-fallback), `/agent` info every 10s, and the approvals tab polls every
5s — all land under `/agent/*`, so they all share the single, **hardcoded**
`agent` policy (max `5` per 60s), on top of whatever route-specific policy
also applies. Raising `RATE_LIMIT_AGENT_RUN` only widens the bucket for
`POST /agent/run` specifically; it does **nothing** for the shared `agent`
bucket that the dashboard's GET polling actually depends on, because that
bucket has no env var. If the dashboard itself is what's getting
locked out, confirm which policy is actually firing (see Diagnosis) before
assuming a `RATE_LIMIT_*` env var is the fix — it may not be tunable today
without a code change to `shared/rate-limit.ts`.

Rate limiters use `express-rate-limit`'s default in-memory store — counts
are per-process. On a single instance (CareGuard's current Render `plan:
free` setup, per `render.yaml`) that's the whole picture; if this ever runs
as multiple instances behind a load balancer, the effective limit becomes
`max × instance count`, since counts are not shared (e.g. via Redis)
across processes.

---

## Diagnosis

### 1. Read the metrics

Two Prometheus metrics come out of `shared/rate-limit.ts`, neither of
which currently has a Grafana panel — query them directly:

```bash
curl -s localhost:3000/metrics | grep -E "ratelimit_hits_total|route_concurrent_requests"
```

- **`ratelimit_hits_total{policy="<name>"}`** (Counter) — increments once
  per rejected (`429`) request, labelled by policy name from the tables
  above. This is the primary signal: `rate(ratelimit_hits_total[5m]) by
  (policy)` tells you which policy is actually being hit and how fast.
- **`route_concurrent_requests{route="<name>"}`** (Gauge) — in-flight
  request count per route (labels: `agent_run`, `bill_audit`,
  `pharmacy_compare`, `drug_interactions`, `pharmacy_order`, from the
  `concurrentRequestsMiddleware(...)` calls in `server.ts`). Useful for
  telling a genuine concurrency spike apart from a client just retrying
  fast after each `429`.

### 2. Throttling vs. abuse — what the metric can and can't tell you

**Be precise about the metric's limits**: `ratelimit_hits_total` has one
label, `policy`. It does **not** carry client IP, so you cannot answer "is
this one IP or many?" from Prometheus alone — `shared/request-logger.ts`
also does not log client IP on the `http` line it writes per request. If
you need to attribute abuse to a specific source, that has to come from
infrastructure-level logs (reverse proxy / CDN / hosting platform access
logs), not from anything CareGuard exports today.

What you *can* determine from CareGuard's own signals:

- **Consistent with legitimate throttling**: `ratelimit_hits_total`
  increases in a pattern that lines up with a known client's fixed poll
  interval (3s / 5s / 10s for the dashboard, above) or with an expected
  traffic pattern (e.g. many caregivers running agent tasks around the
  same time of day). `route_concurrent_requests` stays low — the requests
  aren't overlapping, they're just too frequent for the window.
- **Consistent with abuse / a misbehaving client**: sustained hits on a
  single policy with no let-up (a legitimate client backs off or gives up;
  a scraper or retry-loop doesn't), especially concentrated on
  `pharmacy_order` or `bill_audit` — the two routes that move money or
  parse large payloads. Check `docker compose logs` / your log aggregator
  for `"http"` lines with `status: 429` on that `path` — the volume and
  timing there is your best proxy for "one aggressive client" vs. "diffuse
  legitimate load," even without an IP field.
- Every `429` response — legitimate or not — includes standard headers
  (`standardHeaders: true` in `createRateLimiter`, `shared/rate-limit.ts:49`):
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, plus a
  manually-set `Retry-After` (seconds). These are visible in a browser's
  network tab and are the fastest way to confirm a specific caregiver's
  dashboard is actually hitting a real limit, and which one.

---

## Mitigation (immediate relief)

If legitimate traffic is currently locked out and you need relief before
following the full rollout procedure below:

1. Confirm which **policy label** is actually firing (Diagnosis, above) —
   don't guess. Raising the wrong env var (e.g. `RATE_LIMIT_AGENT_RUN` when
   the shared, non-configurable `agent` policy is what's firing) will look
   like it did nothing.
2. If the firing policy is one of the five env-configurable ones, set the
   corresponding `RATE_LIMIT_*` variable to a higher value (see "Safe
   rollout" for how much) and restart the process — see "Apply the
   change," below.
3. If the firing policy is `agent` or `default` (not env-configurable
   today), the only in-app relief is a full process restart: the
   in-memory store is cleared on restart, which resets every counter for
   every client immediately. This is a blunt instrument — it also resets
   the counter for anyone currently abusing the same policy — so use it
   only as a stopgap while a real fix (code change to make that policy
   configurable, or infra-level IP blocking for confirmed abuse) is
   prepared.

---

## Safe rollout procedure

Follow this when permanently changing one of the five `RATE_LIMIT_*`
values.

### Step 1 — Establish a baseline

Query `ratelimit_hits_total{policy="<name>"}` over a representative window
(a day or more, if you have that much retention) before changing anything.
If it's already at or near zero, you may not need a change at all — check
whether the report of a lockout maps to a *different*, non-configurable
policy instead (see "The interaction that actually locks out the
dashboard," above) before touching an env var.

### Step 2 — Raise gradually, not to an arbitrary large number

Move in roughly 50–100% increments and re-observe, rather than jumping
straight to a number that seems safely large:

```
RATE_LIMIT_AGENT_RUN:        5  → 8  → 12
RATE_LIMIT_BILL_AUDIT:      20  → 30 → 45
RATE_LIMIT_PHARMACY_COMPARE: 30  → 45 → 65
RATE_LIMIT_DRUG_INTERACTIONS:30  → 45 → 65
RATE_LIMIT_PHARMACY_ORDER:  10  → 15 → 22
```

Keep `pharmacy_order` and `agent_run` the most conservative of the five —
they gate on-chain payment submission and LLM-bound work respectively, and
the code comments in `shared/rate-limit.ts` treat both as deliberately
tight for that reason. For `pharmacy_order` specifically, also keep in mind
that every order fans out into multiple Horizon calls (build, submit,
poll); Horizon's own default per-IP limit (3,600 req/hour — see Impact,
above) is a real, separate ceiling upstream of CareGuard's own limit, so
raising `RATE_LIMIT_PHARMACY_ORDER` far past what's needed doesn't just
relax CareGuard's protection, it can start manufacturing Horizon 429s on
CareGuard's own outbound calls (see
[`horizon-down.md`](horizon-down.md) for how those surface).

### Step 3 — Apply the change

**Local / Docker Compose**: edit `.env`, then

```bash
docker compose up -d <service>
```

**not** `docker compose restart` — `restart` reuses the running
container's already-loaded environment and will not pick up the new value
(same caveat documented in
[`rotate-render-secrets.md`](rotate-render-secrets.md) for other env
vars).

**Render** (`render.yaml`): the `RATE_LIMIT_*` variables are not currently
declared in `render.yaml`, so add or edit them under the service's
Environment Variables in the Render Dashboard, then trigger **Manual
Deploy → Restart Service** — Render does not auto-restart a running
service on an environment-variable change alone.

### Step 4 — Confirm the value actually took effect

Because a malformed value silently falls back to the default with no log
line (see "Environment Variables," above), don't assume the deploy worked
— check it:

```bash
curl -s -o /dev/null -D - http://localhost:3000/agent/run -X POST | grep -i ratelimit-limit
```

The `RateLimit-Limit` response header (present on every response, not just
`429`s, since `standardHeaders: true`) reflects the value the process is
actually running with.

### Step 5 — Watch for a full window with no unexpected regression

Watch `ratelimit_hits_total{policy="<name>"}` for at least a couple of
60-second windows of normal traffic:

- It should drop to (near) zero for the policy you just raised, for
  legitimate traffic.
- Open the dashboard and confirm the connection status chip stays
  "Connected" through at least one full cycle of its poll intervals (3s,
  5s, and 10s — see "The interaction that actually locks out the
  dashboard," above) with no `429`s in the browser network tab.
- If you raised `pharmacy_order` or `agent_run`, also check for any new
  `429`s from Horizon or the LLM provider respectively (`agent_llm_error_total`,
  per [`llm-rate-limit.md`](llm-rate-limit.md)) — those indicate you've
  shifted the bottleneck downstream rather than resolved it, and the value
  should come back down.

---

## Rollback

1. Revert the `RATE_LIMIT_*` variable to its previous known-good value —
   or delete it entirely to fall back to the documented default in the
   table above (`parseLimitEnv` treats "unset" and "the default" the
   same).
2. Re-apply with the same restart procedure as Step 3 (`docker compose up
   -d <service>`, or Render Manual Deploy → Restart Service) — the change
   will not take effect without a restart.
3. Re-run Step 4 to confirm the reverted value is actually in effect, then
   watch `ratelimit_hits_total` return to its pre-incident baseline.

---

## Post-mortem template

```
Date / duration:
Affected policy (agent_run / bill_audit / pharmacy_compare / drug_interactions / pharmacy_order / agent / default):
Root cause: [ threshold too tight for legitimate traffic | abuse / misbehaving client | dashboard polling vs. non-configurable "agent" policy ]
Detection lag: (time from first ratelimit_hits_total increase to incident declared)
Mitigation taken:
Remediation (env var + old value → new value, or code change if a non-configurable policy was involved):
Action items:
```

---

## Related

- `shared/rate-limit.ts` — source of every env var, default, and policy
  label referenced in this runbook
- [`docs/adr/unified-vs-split-server.md`](../adr/unified-vs-split-server.md) —
  rationale for per-route token buckets and the `ratelimit_hits_total` /
  `route_concurrent_requests` metrics
- [`llm-rate-limit.md`](llm-rate-limit.md) — the LLM provider's own,
  unrelated 429 (don't confuse the two when `agent_run` traffic is
  involved)
- [`horizon-down.md`](horizon-down.md) — Stellar Horizon outage/rate-limit
  symptoms, relevant if raising `RATE_LIMIT_PHARMACY_ORDER` shifts load
  onto Horizon
- [`rotate-render-secrets.md`](rotate-render-secrets.md) — the
  restart-required / `docker compose up -d` vs. `restart` precedent this
  runbook builds on
- [`docs/troubleshooting.md`](../troubleshooting.md) — existing one-line
  pointer that includes `ratelimit_hits_total` in its `/metrics` triage
  command
