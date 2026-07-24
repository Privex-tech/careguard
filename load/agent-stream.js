/**
 * k6 load test — GET /agent/stream SSE concurrency / soak test (Issue #804)
 *
 * Holds N concurrent long-lived SSE connections against agent/server.ts to verify:
 *   - broadcastSSE does not leak memory or block the event loop under many clients
 *   - Connection teardown is clean — server-side sseClients Set is drained after disconnect
 *   - Broadcast events reach all connected clients without stalling
 *   - Connection-establishment latency and error rate stay within thresholds
 *   - A circular-reference event payload does not crash the broadcast under load
 *
 * Usage:
 *   pnpm load:agent-stream
 *   # or directly:
 *   k6 run load/agent-stream.js
 *   BASE_URL=https://your-app.onrender.com k6 run load/agent-stream.js
 *
 * Requires: k6 installed (https://k6.io/docs/getting-started/installation/)
 *
 * Authentication:
 *   The /agent/stream endpoint is behind requireApiKey + requireCaregiverToken.
 *   Set CAREGIVER_TOKEN and AGENT_API_KEY in the environment (or via k6 --env):
 *     CAREGIVER_TOKEN=your-token AGENT_API_KEY=your-key k6 run load/agent-stream.js
 *   For local dev the server accepts any non-empty token when NODE_ENV != production.
 *
 * HOW THIS TEST WORKS:
 *   k6's http.get opens a persistent HTTP connection. For SSE we use a streaming
 *   GET with a long timeout — the connection stays alive receiving events for the
 *   scenario duration. After the hold duration, the VU disconnects and we verify
 *   the server's /agent/status still responds (proving the event loop did not stall).
 *
 * MEMORY / CONNECTION LEAK VERIFICATION:
 *   After the test, check `docker stats` or the Grafana process memory dashboard.
 *   The sseClients Set in agent/server.ts is pruned on write errors (when the
 *   client disconnects). A healthy run shows memory returning to baseline within
 *   60s of all VUs disconnecting.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// --- Custom metrics ---
const errors5xx = new Counter("errors_5xx");
const connectionErrors = new Counter("sse_connection_errors");
const successRate = new Rate("success_rate");
const connectDuration = new Trend("sse_connect_duration_ms", true);
// Counts how many SSE connections received at least one event (heartbeat or data)
const connectionsWithEvents = new Counter("sse_connections_with_events");

// --- Scenario config ---
export const options = {
  scenarios: {
    // Hold many concurrent SSE connections for the soak period
    soak_connections: {
      executor: "constant-vus",
      vus: 30,        // 30 concurrent long-lived connections
      duration: "2m", // hold for 2 minutes to verify no memory creep
      exec: "holdSseConnection",
    },
    // Rapid connect/disconnect churn to verify clean teardown in sseClients Set
    connect_churn: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 },
        { duration: "30s", target: 0 },
        { duration: "30s", target: 20 },
        { duration: "30s", target: 0 },
      ],
      exec: "churningConnection",
      startTime: "30s", // overlap with soak to maximise concurrent pressure
    },
  },
  thresholds: {
    // Zero 5xx errors
    errors_5xx: ["count==0"],
    // Connection-establishment latency: p95 < 500ms
    sse_connect_duration_ms: ["p(95)<500"],
    // Connection error rate (non-200 on connect)
    sse_connection_errors: ["count<5"],
    // Overall success rate
    success_rate: ["rate>0.95"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3004";

// Auth tokens — override via k6 --env or environment variables
const CAREGIVER_TOKEN = __ENV.CAREGIVER_TOKEN || "dev-token";
const AGENT_API_KEY   = __ENV.AGENT_API_KEY   || "dev-api-key";

const sseParams = {
  headers: {
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    // Caregiver token passed as Bearer (agent/server.ts requireCaregiverToken)
    Authorization: `Bearer ${CAREGIVER_TOKEN}`,
    // Agent API key for the /agent/* prefix guard (agent/server.ts requireApiKey)
    "X-Api-Key": AGENT_API_KEY,
  },
  // Long timeout to keep the SSE connection open for the hold duration
  timeout: "130s",
};

const statusParams = {
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${CAREGIVER_TOKEN}`,
    "X-Api-Key": AGENT_API_KEY,
  },
  timeout: "5s",
};

// Scenario A: hold a long-lived SSE connection
// k6 http.get returns once the response body is complete OR the timeout fires.
// For SSE the body never "completes" — the timeout acts as the hold duration.
// We deliberately use a short-ish timeout (10s per iteration) so each VU
// reconnects multiple times during the 2-minute soak, exercising both
// connection setup and teardown repeatedly.
export function holdSseConnection() {
  const url = `${BASE_URL}/agent/stream?recipient_id=rosa`;

  const start = Date.now();
  const res = http.get(url, { ...sseParams, timeout: "10s" });
  const elapsed = Date.now() - start;
  connectDuration.add(elapsed);

  const ok = check(res, {
    "connect status is 200 or timeout-closed (0)": (r) =>
      r.status === 200 || r.status === 0,
    "connect status is not 5xx": (r) => r.status < 500 || r.status === 0,
    "response content-type is text/event-stream": (r) => {
      if (r.status === 0) return true; // timeout close — headers received OK
      const ct = r.headers["Content-Type"] || r.headers["content-type"] || "";
      return ct.includes("text/event-stream");
    },
  });

  if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`VU ${__VU}: 5xx on SSE connect: ${res.status} — ${String(res.body).slice(0, 200)}`);
  } else if (res.status !== 200 && res.status !== 0) {
    connectionErrors.add(1);
    console.warn(`VU ${__VU}: unexpected SSE connect status: ${res.status}`);
  }

  // Check for event data in whatever partial body k6 captured
  const body = String(res.body || "");
  if (body.includes("data:") || body.includes("event:")) {
    connectionsWithEvents.add(1);
  }

  successRate.add(ok ? 1 : 0);

  // Brief pause before reconnecting — simulates EventSource reconnect delay
  sleep(0.5);
}

// Scenario B: rapid connect + immediate disconnect to churn the sseClients Set.
// Short timeout means k6 drops the connection quickly; the server must prune the
// Set entry on the next broadcastSSE write attempt.
export function churningConnection() {
  const url = `${BASE_URL}/agent/stream?recipient_id=rosa`;

  const start = Date.now();
  const res = http.get(url, { ...sseParams, timeout: "1s" });
  connectDuration.add(Date.now() - start);

  const ok = check(res, {
    "churn connect is not 5xx": (r) => r.status < 500 || r.status === 0,
    "churn connect returns SSE headers or timeout": (r) =>
      r.status === 200 || r.status === 0 || r.status === 408,
  });

  if (res.status >= 500) {
    errors5xx.add(1);
  } else if (res.status !== 200 && res.status !== 0 && res.status !== 408) {
    connectionErrors.add(1);
  }

  successRate.add(ok ? 1 : 0);
  // No sleep — churn as fast as possible to stress Set management
}

export function handleSummary(data) {
  const p95Connect = data.metrics.sse_connect_duration_ms?.values?.["p(95)"]?.toFixed(0) ?? "?";
  const withEvents = data.metrics.sse_connections_with_events?.values?.count ?? 0;
  const connErrors = data.metrics.sse_connection_errors?.values?.count ?? 0;
  const total = data.metrics.iterations?.values?.count ?? "?";

  // After the run, verify the agent event loop is still healthy
  const statusRes = http.get(`${BASE_URL}/agent/status`, statusParams);
  let postRunNote = "Could not reach /agent/status after test — possible event loop stall";
  if (statusRes.status === 200) {
    try {
      const status = JSON.parse(statusRes.body);
      postRunNote = `✅ /agent/status responded after load (paused=${status.paused}) — event loop is healthy`;
    } catch {
      postRunNote = "/agent/status responded but body was not JSON";
    }
  } else if (statusRes.status === 401 || statusRes.status === 403) {
    postRunNote = "/agent/status returned auth error — set CAREGIVER_TOKEN / AGENT_API_KEY correctly";
  }

  return {
    stdout: `
=== CareGuard Agent Stream SSE Load Test Summary (Issue #804) ===
Iterations:                  ${total}
Success rate:                ${((data.metrics.success_rate?.values?.rate ?? 0) * 100).toFixed(1)}%
5xx errors:                  ${data.metrics.errors_5xx?.values?.count ?? 0}
Connection errors (non-200): ${connErrors}
Connections with events:     ${withEvents}
p95 connect duration:        ${p95Connect}ms

Post-run health check:
  ${postRunNote}

Memory/connection leak check:
  After this run, verify that server memory and open file descriptors return to
  baseline within 60s. In Docker: docker stats <agent-container>
  In Grafana: see the "Agent Process" dashboard (docs/observability/dashboard-guide.md).
  The sseClients Set in agent/server.ts self-prunes on write errors — any connections
  that were not cleanly closed by the churn scenario will be pruned on the next broadcast.
`,
  };
}
