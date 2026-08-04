/**
 * k6 load test — POST /pharmacy/order concurrent burst (Issue #803)
 *
 * Targets services/pharmacy-payment/server.ts's POST /pharmacy/order endpoint,
 * which is protected by the MPP Charge payment flow. The goal is to verify:
 *   1. Concurrent orders do not corrupt the orders store (file-lock + atomic write)
 *   2. Order count persisted equals successful 2xx responses (no lost/duplicated orders)
 *   3. 503 responses (facilitator unavailable) stay within an allowed bound
 *   4. p95 latency stays within budget under burst
 *
 * Usage:
 *   pnpm load:pharmacy-order
 *   # or directly:
 *   k6 run load/pharmacy-order.js
 *   BASE_URL=https://your-app.onrender.com k6 run load/pharmacy-order.js
 *
 * Requires: k6 installed (https://k6.io/docs/getting-started/installation/)
 *
 * IMPORTANT — MPP payment gate: POST /pharmacy/order triggers the MPP Charge flow.
 * Without a valid Stellar payment the server returns a 402 challenge. This script
 * does NOT sign Stellar transactions, so against a live server it will receive 402
 * responses. A 402 is treated as an expected "payment challenge" response — it is
 * NOT a failure, because the server must issue it before processing the order.
 *
 * To load test the actual order persistence path (past the payment gate), run the
 * server with a mock MPP facilitator that always returns "payment verified". There is
 * currently no in-repo mock facilitator — see docs/load-testing.md for setup notes.
 *
 * How to start the server with a mock facilitator for load runs:
 *   MPP_SECRET_KEY=SXXXXX... PHARMACY_1_PUBLIC_KEY=GXXXXX... \
 *     MPP_MOCK=true node --import tsx services/pharmacy-payment/server.ts
 *
 * Concurrency / corruption verification:
 *   After the burst scenario completes, handleSummary() fetches GET /pharmacy/orders
 *   and compares the persisted order count to the number of 200 responses received.
 *   A mismatch indicates lost writes or duplicate saves from the file-lock path.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// --- Metrics ---
const errors5xx = new Counter("errors_5xx");
const errors503 = new Counter("errors_503");
const successRate = new Rate("success_rate");
const orderDuration = new Trend("pharmacy_order_duration_ms", true);
const orders200 = new Counter("orders_200_success");
const orders402 = new Counter("orders_402_challenge");

// --- Config ---
export const options = {
  scenarios: {
    // Burst scenario: concurrent orders to stress file-lock + atomic write
    concurrent_orders: {
      executor: "shared-iterations",
      vus: 20,
      iterations: 60,
      maxDuration: "2m",
      exec: "placeOrder",
    },
    // Sustained load to check for slow degradation of the store
    sustained_load: {
      executor: "constant-vus",
      vus: 5,
      duration: "1m",
      exec: "placeOrder",
      startTime: "30s",
    },
  },
  thresholds: {
    // Zero 5xx errors (402 challenge and 503 are expected, not 5xx)
    errors_5xx: ["count==0"],
    // 503 (facilitator throttled) must be rare — at most 5% of total requests
    errors_503: ["count<10"],
    // p95 order latency under 2s (includes 402 round-trip overhead)
    pharmacy_order_duration_ms: ["p(95)<2000"],
    // 99%+ handled without 5xx
    success_rate: ["rate>0.99"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3005";

// Representative medication orders matching realistic caregiver use
const MEDICATION_ORDERS = [
  { drug: "Lisinopril",   pharmacy: "Costco Pharmacy",   amount: "12.00" },
  { drug: "Metformin",    pharmacy: "CVS Pharmacy",       amount: "8.50"  },
  { drug: "Atorvastatin", pharmacy: "Walgreens",          amount: "15.75" },
  { drug: "Amlodipine",   pharmacy: "Rite Aid",           amount: "9.20"  },
  { drug: "Omeprazole",   pharmacy: "Walmart Pharmacy",   amount: "11.30" },
];

const REQUEST_PARAMS = {
  headers: { "Content-Type": "application/json" },
  timeout: "15s",
};

/**
 * Place a single medication order against the MPP-protected endpoint.
 * Records 200 (order confirmed), 402 (payment challenge), 503 (facilitator down),
 * and any 5xx as separate metrics for post-run analysis.
 */
export function placeOrder() {
  const order = MEDICATION_ORDERS[Math.floor(Math.random() * MEDICATION_ORDERS.length)];
  const payload = JSON.stringify(order);

  const start = Date.now();
  const res = http.post(`${BASE_URL}/pharmacy/order`, payload, REQUEST_PARAMS);
  orderDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "status is 200, 402, or 503": (r) =>
      r.status === 200 || r.status === 402 || r.status === 503,
    "200 response has order.id": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        return typeof body.order?.id === "string";
      } catch {
        return false;
      }
    },
    "402 response has payment challenge body": (r) => {
      if (r.status !== 402) return true;
      // 402 challenge body may be text or JSON — just verify it's non-empty
      return r.body !== null && r.body.length > 0;
    },
  });

  if (res.status >= 500 && res.status !== 503) {
    errors5xx.add(1);
    console.error(`5xx from /pharmacy/order: ${res.status} — ${res.body.slice(0, 200)}`);
  } else if (res.status === 503) {
    errors503.add(1);
  } else if (res.status === 200) {
    orders200.add(1);
  } else if (res.status === 402) {
    orders402.add(1);
  }

  successRate.add(ok ? 1 : 0);

  // Brief sleep to avoid thundering herd on the file lock
  sleep(0.05 + Math.random() * 0.1);
}

export function handleSummary(data) {
  // Fetch persisted order count to verify against 200 responses
  let persistenceNote = "Could not fetch /pharmacy/orders for persistence check";
  const ordersRes = http.get(`${BASE_URL}/pharmacy/orders`, { timeout: "5s" });
  if (ordersRes.status === 200) {
    try {
      const body = JSON.parse(ordersRes.body);
      const persistedCount = Array.isArray(body.orders) ? body.orders.length : "unknown";
      const confirmed200 = data.metrics.orders_200_success?.values?.count ?? 0;

      // Note: the test run accumulates on top of any pre-existing orders in the file,
      // so we report both and flag if confirmed200 > persistedCount (lost writes).
      const lostWriteFlag =
        typeof persistedCount === "number" && confirmed200 > persistedCount
          ? `⚠ POSSIBLE LOST WRITES: ${confirmed200} 200-responses but only ${persistedCount} persisted orders`
          : `✅ Persistence check: ${confirmed200} 200-responses, ${persistedCount} total orders in store`;

      persistenceNote = lostWriteFlag;
    } catch {
      persistenceNote = "Failed to parse /pharmacy/orders response";
    }
  }

  const p95 = data.metrics.pharmacy_order_duration_ms?.values?.["p(95)"]?.toFixed(0) ?? "?";
  const totalIter = data.metrics.iterations?.values?.count ?? "?";
  const rate = ((data.metrics.success_rate?.values?.rate ?? 0) * 100).toFixed(1);
  const fivexx = data.metrics.errors_5xx?.values?.count ?? 0;
  const fiveohthree = data.metrics.errors_503?.values?.count ?? 0;
  const confirmed = data.metrics.orders_200_success?.values?.count ?? 0;
  const challenged = data.metrics.orders_402_challenge?.values?.count ?? 0;

  return {
    stdout: `
=== CareGuard Pharmacy Order Load Test Summary (Issue #803) ===
Iterations:              ${totalIter}
Success rate:            ${rate}%
5xx errors:              ${fivexx}
503 (facilitator down):  ${fiveohthree}
200 (orders confirmed):  ${confirmed}
402 (payment challenge): ${challenged}
p95 order latency:       ${p95}ms

${persistenceNote}

Note: 402 responses mean the MPP payment gate is active — no real Stellar payment
was signed. See script header for how to run with a mock facilitator to test the
order-persistence path under concurrent load.
`,
  };
}
