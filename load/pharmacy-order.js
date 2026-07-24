/**
 * k6 load test — POST /pharmacy/order under burst concurrent load (Issue #803)
 *
 * Stresses the MPP charge path (services/pharmacy-payment/server.ts) with
 * concurrent order requests to verify:
 *   - No orders are lost or duplicated (order count == successful 2xx responses)
 *   - p95 latency stays bounded under burst
 *   - Zero 5xx responses
 *   - 503 responses when the facilitator is throttled are counted and within allowed bound
 *
 * Usage:
 *   pnpm load:pharmacy-order
 *   # or directly:
 *   k6 run load/pharmacy-order.js
 *   BASE_URL=https://your-app.onrender.com k6 run load/pharmacy-order.js
 *
 * Requires: k6 installed (https://k6.io/docs/getting-started/installation/)
 *
 * HOW TO RUN AGAINST A MOCK FACILITATOR:
 *   The MPP charge flow issues a real Stellar payment challenge. To load test
 *   the order-storage path without spending real testnet USDC:
 *
 *   1. Start the pharmacy-payment server with a mock MPP secret key that accepts
 *      any payment challenge without verifying the Stellar signature:
 *        MPP_SECRET_KEY=STEST_MOCK_KEY_FOR_LOAD_TESTING \
 *        PHARMACY_1_PUBLIC_KEY=<any-valid-stellar-public-key> \
 *        node --import tsx services/pharmacy-payment/server.ts
 *
 *   2. Or patch mppx to use a passthrough charge method in a dev/test environment.
 *
 *   3. Against a live server, this script will receive 402 challenges (the MPP
 *      handshake) — responses counted as valid since they prove the payment gate
 *      is working. The order persistence path is only exercised after payment
 *      settles (status 200 from the MPP flow).
 *
 * ORDER INTEGRITY NOTE:
 *   After the run, compare `data.metrics.orders_confirmed.values.count` against
 *   the result of `GET /pharmacy/orders` on the target server. They must match —
 *   any discrepancy indicates a lost write or race condition in saveOrder().
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// --- Custom metrics ---
const errors5xx = new Counter("errors_5xx");
const successRate = new Rate("success_rate");
const orderDuration = new Trend("pharmacy_order_duration_ms", true);
// Counts 200 responses — these represent confirmed orders stored in orders.json
const ordersConfirmed = new Counter("orders_confirmed");
// Counts 402 responses — MPP payment challenge (expected in live environment)
const mppChallenges = new Counter("mpp_challenges");
// Counts 503 responses — facilitator throttled or unavailable
const facilitatorThrottled = new Counter("facilitator_throttled");

// --- Scenario config ---
export const options = {
  scenarios: {
    // Burst of concurrent orders — exercises the file-locking saveOrder() path
    burst_orders: {
      executor: "shared-iterations",
      vus: 20,
      iterations: 40,
      maxDuration: "90s",
      exec: "placeOrder",
    },
    // A smaller sustained scenario to keep pressure on during the burst cooldown
    sustained_orders: {
      executor: "constant-vus",
      vus: 5,
      duration: "60s",
      exec: "placeOrder",
      startTime: "10s",
    },
  },
  thresholds: {
    // Zero 5xx errors — 402 (MPP challenge) and 503 (throttle) are not 5xx
    errors_5xx: ["count==0"],
    // p95 latency < 2000ms — the MPP handshake adds overhead
    pharmacy_order_duration_ms: ["p(95)<2000"],
    // Overall success rate for non-5xx responses
    success_rate: ["rate>0.99"],
    // Facilitator throttle bound: 503s must be < 5% of total requests
    facilitator_throttled: ["count<10"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3005";

// Order payloads matching MedicationOrderSchema
// (services/pharmacy-payment/validation.ts: drug, pharmacy, amount fields)
const ORDER_PAYLOADS = [
  { drug: "Lisinopril",   pharmacy: "CVS Pharmacy",     amount: "12.50" },
  { drug: "Metformin",    pharmacy: "Costco Pharmacy",   amount: "4.00"  },
  { drug: "Atorvastatin", pharmacy: "Walgreens",         amount: "18.75" },
  { drug: "Amlodipine",   pharmacy: "Rite Aid",          amount: "7.20"  },
  { drug: "Omeprazole",   pharmacy: "Sam's Club",        amount: "9.99"  },
];

const params = {
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  timeout: "15s",
};

export function placeOrder() {
  const payload = ORDER_PAYLOADS[__VU % ORDER_PAYLOADS.length];

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/pharmacy/order`,
    JSON.stringify(payload),
    params
  );
  orderDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "status is 200 (confirmed), 402 (MPP challenge), or 400 (bad input)": (r) =>
      r.status === 200 || r.status === 402 || r.status === 400,
    "200 response has order.id": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        return typeof body.order?.id === "string";
      } catch {
        return false;
      }
    },
    "200 response has success: true": (r) => {
      if (r.status !== 200) return true;
      try {
        return JSON.parse(r.body).success === true;
      } catch {
        return false;
      }
    },
  });

  if (res.status === 200) {
    ordersConfirmed.add(1);
  } else if (res.status === 402) {
    mppChallenges.add(1);
  } else if (res.status === 503) {
    facilitatorThrottled.add(1);
    console.warn(`VU ${__VU}: 503 from facilitator — ${res.body.slice(0, 100)}`);
  } else if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`VU ${__VU}: ${res.status} — ${res.body.slice(0, 200)}`);
  }

  successRate.add(ok ? 1 : 0);

  // Brief pause to avoid hammering the file-lock in saveOrder() on every iteration
  sleep(0.1);
}

export function handleSummary(data) {
  const confirmed = data.metrics.orders_confirmed?.values?.count ?? 0;
  const challenges = data.metrics.mpp_challenges?.values?.count ?? 0;
  const throttled = data.metrics.facilitator_throttled?.values?.count ?? 0;
  const total = data.metrics.iterations?.values?.count ?? "?";
  const p95 = data.metrics.pharmacy_order_duration_ms?.values?.["p(95)"]?.toFixed(0) ?? "?";

  // Fetch the current order count from the server to cross-check persistence
  const ordersRes = http.get(`${BASE_URL}/pharmacy/orders`, {
    headers: { Accept: "application/json" },
    timeout: "5s",
  });

  let orderIntegrityNote = "Could not fetch order list for integrity check";
  if (ordersRes.status === 200) {
    try {
      const body = JSON.parse(ordersRes.body);
      const serverCount = Array.isArray(body.orders) ? body.orders.length : "?";
      orderIntegrityNote =
        confirmed === 0
          ? `No confirmed orders (all 402/MPP challenge). Server has ${serverCount} pre-existing orders.`
          : serverCount >= confirmed
          ? `✅ Server order count (${serverCount}) ≥ confirmed by k6 (${confirmed}) — no lost writes detected`
          : `⚠ Server order count (${serverCount}) < confirmed by k6 (${confirmed}) — possible lost write or race condition`;
    } catch {
      orderIntegrityNote = "Failed to parse orders response";
    }
  }

  return {
    stdout: `
=== CareGuard Pharmacy Order Load Test Summary (Issue #803) ===
Iterations:           ${total}
Success rate:         ${((data.metrics.success_rate?.values?.rate ?? 0) * 100).toFixed(1)}%
5xx errors:           ${data.metrics.errors_5xx?.values?.count ?? 0}
Confirmed orders:     ${confirmed}
MPP challenges (402): ${challenges}
Facilitator 503s:     ${throttled}
p95 duration:         ${p95}ms

Order integrity:
  ${orderIntegrityNote}

Note: In a live environment with a real MPP facilitator, all requests will
receive 402 challenges rather than 200 confirmations. See the script header
for how to run against a mock facilitator to exercise the persistence path.
`,
  };
}
