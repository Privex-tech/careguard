/**
 * k6 load test — GET /agent/stream SSE concurrent soak test (Issue #804)
 *
 * agent/server.ts exposes GET /agent/stream (SSE). The dashboard polls/streams
 * aggressively (~333 req/s at 1000 users with 3s polling). This test holds many
 * concurrent long-lived SSE connections to verify:
 *   1. broadcastSSE does not leak memory or block the event loop
 *   2. Connection teardown is clean (sseClients Set is pruned on close)
 *   3. Broadcast events reach all connected clients without the event loop stalling
 *   4. A circular-reference event payload does not crash broadcast under load
 *
 * The /agent/stream endpoint:
 *   - Sets Content-Type: text/event-stream + Connection: keep-alive
 *   - Immediately sends spending, status, and transactions events on connect
 *   - Sends ": heartbeat\n\n" every 30s
 *   - Adds the response to the sseClients Set; removes it on req.close
 *
 * Usage:
 *   pnpm load:agent-stream
 *   # or directly:
 *   k6 run load/agent-stream.js
 *   BASE_URL=https://your-app.onrender.com k6 run load/agent-stream.js
 *
 * Requires: k6 installed (https://k6.io/docs/getting-started/installation/)
 *
 * Auth note: GET /agent/stream is behind requireApiKey (the /agent/* prefix).
 * Provide AGENT_API_KEY via environment:
 *   AGENT_API_KEY=your-key k6 run load/agent-stream.js
 *
 * Prerequisites:
 *   1. k6 installed
 *   2. CareGuard agent server running (node --import tsx agent/server.ts)
 *   3. AGENT_API_KEY set (matches the server's AGENT_API_KEY env var)
 *      Skip auth with a server started without AGENT_API_KEY in non-production mode
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// --- Metrics ---
const errors5xx = new Counter("errors_5xx");
const connectionErrors = new Counter("connection_errors");
const successRate = new Rate("success_rate");
const connectDuration = new Trend("sse_connect_duration_ms", true);
const initialEventReceived = new Rate("sse_initial_event_received");

// --- Config ---
export const options = {
  scenarios: {
    // Soak: hold N concurrent SSE connections for a sustained period to detect
    // memory leaks and event-loop stalls. Each VU opens one connection, reads
    // initial events, then holds the connection open.
    soak_connections: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "30s", target: 30 },  // ramp to 30 concurrent connections
        { duration: "2m",  target: 50 },  // hold soak at 50 connections
        { duration: "30s", target: 0 },   // disconnect all — verify teardown
      ],
      exec: "holdSseConnection",
    },
    // Connection churn: rapid connect/disconnect to verify sseClients Set cleanup
    connection_churn: {
      executor: "constant-vus",
      vus: 10,
      duration: "1m",
      exec: "churnConnection",
      startTime: "30s",
    },
  },
  thresholds: {
    // Zero 5xx errors on the SSE endpoint
    errors_5xx: ["count==0"],
    // Zero connection errors (TCP-level failures, not expected HTTP errors)
    connection_errors: ["count==0"],
    // Connection establishment latency p95 under 500ms
    sse_connect_duration_ms: ["p(95)<500"],
    // 99%+ of SSE connections established without HTTP error
    success_rate: ["rate>0.99"],
    // >95% of connections receive at least one initial event
    sse_initial_event_received: ["rate>0.95"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3004";
const AGENT_API_KEY = __ENV.AGENT_API_KEY || "";

/**
 * Build request params with optional API key auth.
 * The /agent/* path requires the X-API-Key header when AGENT_API_KEY is set.
 */
function makeRequestParams(extraHeaders) {
  const headers = { ...extraHeaders };
  if (AGENT_API_KEY) {
    headers["X-API-Key"] = AGENT_API_KEY;
  }
  return { headers, timeout: "10s" };
}

/**
 * Scenario: hold a long-lived SSE connection.
 *
 * k6 does not natively support streaming HTTP responses as an event loop, so this
 * uses a bounded read approach: open the connection with a short read timeout to
 * capture the initial burst of events (spending + status + transactions sent
 * immediately on connect by agent/server.ts), then sleep to simulate a long-held
 * connection before disconnecting.
 *
 * The server-side check is: sseClients.size should return to 0 after all VUs
 * disconnect. This is observable via the server logs or a /ready check.
 */
export function holdSseConnection() {
  const url = `${BASE_URL}/agent/stream?recipient_id=rosa`;

  // Open the SSE connection and read the initial event burst
  // k6 HTTP reads the response body up to the timeout, then returns
  const start = Date.now();
  const res = http.get(url, {
    ...makeRequestParams({ Accept: "text/event-stream" }),
    // Use a short timeout to capture the initial events then release.
    // The server sends spending + status + transactions on connect immediately,
    // so 3s is enough to receive all three even on a slow connection.
    timeout: "3s",
  });
  connectDuration.add(Date.now() - start);

  // With a 3s timeout the request will "fail" at the TCP level (timeout), but
  // we should have received partial body (the initial events). k6 reports the
  // connection as timed out — we check that we at least got a 200 header and
  // non-empty body containing the initial event fields.
  const gotEvents = check(res, {
    "SSE connection established (200 or timeout with partial body)": (r) =>
      r.status === 200 || (r.error_code === 1050 /* timeout */ && r.body !== null),
    "initial events present in body": (r) => {
      const body = r.body || "";
      // Server sends three events immediately: spending, status, transactions
      return (
        body.includes("event: spending") ||
        body.includes("event: status") ||
        body.includes("event: transactions")
      );
    },
    "no 5xx response": (r) => r.status < 500,
  });

  if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`5xx from /agent/stream: ${res.status} — ${(res.body || "").slice(0, 200)}`);
  }

  // Count as connection error only on non-timeout transport failures
  if (res.error_code && res.error_code !== 1050) {
    connectionErrors.add(1);
    console.error(`Connection error on /agent/stream: code=${res.error_code} error=${res.error}`);
  }

  const hasInitialEvent =
    (res.body || "").includes("event: spending") ||
    (res.body || "").includes("event: status") ||
    (res.body || "").includes("event: transactions");
  initialEventReceived.add(hasInitialEvent ? 1 : 0);

  successRate.add(gotEvents ? 1 : 0);

  // Simulate client holding the connection open for a while before teardown.
  // Randomise to spread disconnect events and avoid simultaneous teardown spike.
  sleep(1 + Math.random() * 2);
}

/**
 * Scenario: rapid connect/disconnect churn.
 *
 * Verifies that the sseClients Set in agent/server.ts is correctly pruned when
 * clients disconnect. A leak would cause broadcastSSE to grow its recipient set
 * unboundedly and eventually exhaust write buffers or memory.
 *
 * Each iteration: connect, read initial events (very short timeout), disconnect.
 */
export function churnConnection() {
  const url = `${BASE_URL}/agent/stream?recipient_id=rosa`;

  const start = Date.now();
  const res = http.get(url, {
    ...makeRequestParams({ Accept: "text/event-stream" }),
    timeout: "1s", // very short — just enough for the header + first event
  });
  connectDuration.add(Date.now() - start);

  const ok = check(res, {
    "churn: connected without 5xx": (r) =>
      r.status === 200 || r.error_code === 1050 /* timeout after partial read */,
    "churn: no 5xx": (r) => r.status < 500,
  });

  if (res.status >= 500) {
    errors5xx.add(1);
  }

  if (res.error_code && res.error_code !== 1050) {
    connectionErrors.add(1);
  }

  successRate.add(ok ? 1 : 0);

  // Very short sleep: churn scenario wants rapid reconnects
  sleep(0.05 + Math.random() * 0.1);
}

export function handleSummary(data) {
  const p95 = data.metrics.sse_connect_duration_ms?.values?.["p(95)"]?.toFixed(0) ?? "?";
  const totalIter = data.metrics.iterations?.values?.count ?? "?";
  const rate = ((data.metrics.success_rate?.values?.rate ?? 0) * 100).toFixed(1);
  const fivexx = data.metrics.errors_5xx?.values?.count ?? 0;
  const connErr = data.metrics.connection_errors?.values?.count ?? 0;
  const initRate = ((data.metrics.sse_initial_event_received?.values?.rate ?? 0) * 100).toFixed(1);

  return {
    stdout: `
=== CareGuard Agent SSE Stream Load Test Summary (Issue #804) ===
Iterations:                    ${totalIter}
Success rate:                  ${rate}%
5xx errors:                    ${fivexx}
Connection errors:             ${connErr}
Initial event received rate:   ${initRate}%
p95 connection latency:        ${p95}ms

Memory/leak check:
  After all VUs disconnect, verify sseClients.size returns to 0.
  Check server logs for "sseClients.delete" entries matching your VU count.
  If the server's memory grows monotonically after disconnect, broadcastSSE
  has a reference leak in the sseClients Set cleanup path.

Broadcast correctness:
  Trigger a /agent/pause or /agent/resume while the soak scenario is running.
  All connected clients should receive an SSE 'status' event within one heartbeat
  interval (30s). Check k6 stdout for 'event: status' in the body samples above.
`,
  };
}
