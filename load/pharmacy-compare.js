/**
 * k6 load test — GET /pharmacy/compare under ramping concurrent reads (Issue #801)
 *
 * Targets services/pharmacy-api/server.ts's GET /pharmacy/compare endpoint, which is
 * backed by a db.ts SQLite store. The goal is to surface any cache/store contention
 * under concurrent reads, verify ranking consistency, and gate latency/error budgets.
 *
 * Usage:
 *   pnpm load:pharmacy-compare
 *   # or directly:
 *   k6 run load/pharmacy-compare.js
 *   BASE_URL=https://your-app.onrender.com k6 run load/pharmacy-compare.js
 *
 * Requires: k6 installed (https://k6.io/docs/getting-started/installation/)
 *
 * IMPORTANT — x402 payment gate: GET /pharmacy/compare is x402-payment-protected
 * ($0.002 per query via OZ Facilitator on Stellar testnet). This script does NOT
 * perform real Stellar payments, so it will receive 402 responses against a live
 * server with a valid OZ_FACILITATOR_API_KEY. To load test the actual comparison
 * computation, run the server with payments disabled (set ENABLE_PAYMENTS=false or
 * pass enablePayments: false to createPharmacyApp). A 402 is treated as an expected
 * "payment gate active" response — it is NOT a failure.
 *
 * Server start with payments disabled (for load testing):
 *   ENABLE_PAYMENTS=false node --import tsx services/pharmacy-api/server.ts
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// --- Metrics ---
const errors5xx = new Counter("errors_5xx");
const successRate = new Rate("success_rate");
const compareDuration = new Trend("pharmacy_compare_duration_ms", true);
const nonEmptyResults = new Counter("non_empty_compare_results");
const emptyResults = new Counter("empty_compare_results");

// --- Config ---
export const options = {
  scenarios: {
    // Ramp up concurrent readers to surface db.ts store contention
    ramping_reads: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 15 },  // ramp to 15 VUs
        { duration: "1m",  target: 30 },  // hold at 30 VUs (hot path)
        { duration: "30s", target: 0 },   // ramp down
      ],
      exec: "compareKnownDrug",
    },
    // Small parallel scenario hitting varied drug+zip combos to test ranking consistency
    varied_params: {
      executor: "constant-vus",
      vus: 5,
      duration: "1m",
      exec: "compareVariedParams",
      startTime: "30s", // overlap with ramp-up phase, not cooldown
    },
  },
  thresholds: {
    // Zero 5xx errors — payment-gate 402s are expected and OK
    errors_5xx: ["count==0"],
    // p95 latency under 800ms for the db-backed store read path
    pharmacy_compare_duration_ms: ["p(95)<800", "p(99)<1500"],
    // Overall success rate (200 or 402 accepted) above 99%
    success_rate: ["rate>0.99"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

// Representative drug/zip combos that exist in the seeded pricing database
// (matches the drugs in shared/pharmacy-pricing.ts and services/pharmacy-api/seed.ts)
const KNOWN_DRUG_PARAMS = [
  { drug: "Lisinopril",    zip: "90210" },
  { drug: "Metformin",     zip: "10001" },
  { drug: "Atorvastatin",  zip: "60601" },
  { drug: "Amlodipine",    zip: "77001" },
  { drug: "Omeprazole",    zip: "30301" },
];

// Params that are likely not in the DB — should return 404 (not 5xx)
const UNKNOWN_DRUG_PARAMS = [
  { drug: "UnknownDrugXYZ", zip: "90210" },
];

const REQUEST_PARAMS = {
  headers: { "Content-Type": "application/json" },
  timeout: "10s",
};

/**
 * Scenario: compare a known drug — should get 200 (payments disabled) or 402 (payments on).
 * Verifies non-empty comparison results are returned under concurrent load.
 */
export function compareKnownDrug() {
  const entry = KNOWN_DRUG_PARAMS[Math.floor(Math.random() * KNOWN_DRUG_PARAMS.length)];
  const url = `${BASE_URL}/pharmacy/compare?drug=${encodeURIComponent(entry.drug)}&zip=${entry.zip}`;

  const start = Date.now();
  const res = http.get(url, REQUEST_PARAMS);
  compareDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "status is 200, 402, or 404": (r) =>
      r.status === 200 || r.status === 402 || r.status === 404,
    "200 response has prices array": (r) => {
      if (r.status !== 200) return true; // payment-gated or not found — skip
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.prices);
      } catch {
        return false;
      }
    },
    "200 prices array is non-empty": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.prices) && body.prices.length > 0;
      } catch {
        return false;
      }
    },
    "200 ranking is consistent (cheapest first)": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        if (!Array.isArray(body.prices) || body.prices.length < 2) return true;
        for (let i = 1; i < body.prices.length; i++) {
          if (body.prices[i].price < body.prices[i - 1].price) return false;
        }
        return true;
      } catch {
        return false;
      }
    },
  });

  if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`5xx from /pharmacy/compare: ${res.status} — ${res.body.slice(0, 200)}`);
  }

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      if (Array.isArray(body.prices) && body.prices.length > 0) {
        nonEmptyResults.add(1);
      } else {
        emptyResults.add(1);
      }
    } catch {
      emptyResults.add(1);
    }
  }

  successRate.add(ok ? 1 : 0);
  sleep(0.1);
}

/**
 * Scenario: varied drug+zip combos including unknown drugs.
 * Confirms unknown drugs return 404 (never 5xx) and store read stays consistent
 * across different query parameters under concurrency.
 */
export function compareVariedParams() {
  // 80% known, 20% unknown
  const useUnknown = Math.random() < 0.2;
  const pool = useUnknown ? UNKNOWN_DRUG_PARAMS : KNOWN_DRUG_PARAMS;
  const entry = pool[Math.floor(Math.random() * pool.length)];
  const url = `${BASE_URL}/pharmacy/compare?drug=${encodeURIComponent(entry.drug)}&zip=${entry.zip}`;

  const start = Date.now();
  const res = http.get(url, REQUEST_PARAMS);
  compareDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "unknown drug gets 404, known gets 200/402": (r) => {
      if (useUnknown) return r.status === 404;
      return r.status === 200 || r.status === 402;
    },
  });

  if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`5xx from /pharmacy/compare (varied): ${res.status} — ${res.body.slice(0, 200)}`);
  }

  successRate.add(ok ? 1 : 0);
  sleep(0.15);
}

export function handleSummary(data) {
  const p95 = data.metrics.pharmacy_compare_duration_ms?.values?.["p(95)"]?.toFixed(0) ?? "?";
  const p99 = data.metrics.pharmacy_compare_duration_ms?.values?.["p(99)"]?.toFixed(0) ?? "?";
  const totalIter = data.metrics.iterations?.values?.count ?? "?";
  const rate = ((data.metrics.success_rate?.values?.rate ?? 0) * 100).toFixed(1);
  const fivexx = data.metrics.errors_5xx?.values?.count ?? 0;
  const nonEmpty = data.metrics.non_empty_compare_results?.values?.count ?? 0;
  const empty = data.metrics.empty_compare_results?.values?.count ?? 0;

  return {
    stdout: `
=== CareGuard Pharmacy Compare Load Test Summary (Issue #801) ===
Iterations:            ${totalIter}
Success rate:          ${rate}%
5xx errors:            ${fivexx}
p95 compare latency:   ${p95}ms
p99 compare latency:   ${p99}ms
Non-empty results:     ${nonEmpty}
Empty results:         ${empty}

Note: 402 responses indicate the x402 payment gate is active — see script header
for how to disable payments on the server for load testing the compare path directly.
`,
  };
}
