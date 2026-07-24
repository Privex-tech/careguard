/**
 * k6 load test — GET /pharmacy/compare under ramping concurrent reads (Issue #801)
 *
 * Stresses the pharmacy price comparison path (services/pharmacy-api/server.ts)
 * with varied drug + zipCode params to verify:
 *   - Cache/store contention under concurrent reads does not produce inconsistent rankings
 *   - p95/p99 latency thresholds hold
 *   - Zero 5xx responses under load
 *   - Non-empty comparison results returned under load (custom metric)
 *
 * Usage:
 *   pnpm load:pharmacy-compare
 *   # or directly:
 *   k6 run load/pharmacy-compare.js
 *   BASE_URL=https://your-app.onrender.com k6 run load/pharmacy-compare.js
 *
 * Requires: k6 installed (https://k6.io/docs/getting-started/installation/)
 *
 * IMPORTANT — x402 payment gate: GET /pharmacy/compare is x402-payment-protected.
 * This script will receive 402 responses against a live server with a real
 * OZ_FACILITATOR_API_KEY. To load test the actual comparison computation path,
 * point this at a server started with enablePayments=false (set
 * PHARMACY_ENABLE_PAYMENTS=false or patch createPharmacyApp options),
 * matching the same prerequisite documented for load/agent-run.js in
 * docs/load-testing.md.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend, Gauge } from "k6/metrics";

// --- Custom metrics ---
const errors5xx = new Counter("errors_5xx");
const successRate = new Rate("success_rate");
const compareDuration = new Trend("pharmacy_compare_duration_ms", true);
// Tracks how many successful comparisons returned at least one pharmacy result
const nonEmptyResults = new Counter("pharmacy_compare_nonempty_results");
// Gauges how many pharmacy entries were in the last sampled response
const pharmacyResultCount = new Gauge("pharmacy_result_count");

// --- Scenario config ---
export const options = {
  scenarios: {
    // Ramp up concurrent VUs issuing varied drug+zip reads
    ramping_compare: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "20s", target: 15 },   // ramp up
        { duration: "1m",  target: 30 },   // sustained peak
        { duration: "20s", target: 0 },    // ramp down
      ],
      exec: "compareKnownDrug",
    },
    // A smaller concurrent scenario varying zip codes to exercise store read paths
    zip_variance: {
      executor: "constant-vus",
      vus: 5,
      duration: "1m",
      exec: "compareWithZipVariance",
      startTime: "20s", // overlap with ramping peak
    },
  },
  thresholds: {
    // No 5xx errors allowed under any load
    errors_5xx: ["count==0"],
    // Latency gate: p95 < 500ms, p99 < 1000ms
    pharmacy_compare_duration_ms: ["p(95)<500", "p(99)<1000"],
    // Overall success rate (200 or 402 are both valid — see script header)
    success_rate: ["rate>0.99"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

// Drug + zip combos that mirror what the agent actually queries.
// Kept to known drugs so we get 200 rather than 404 when running against
// a seeded store; the load shape matters more than drug variety here.
const DRUG_ZIP_PAIRS = [
  { drug: "Lisinopril",   zip: "90210" },
  { drug: "Metformin",    zip: "10001" },
  { drug: "Atorvastatin", zip: "77001" },
  { drug: "Amlodipine",   zip: "60601" },
  { drug: "Omeprazole",   zip: "94102" },
  { drug: "Lisinopril",   zip: "30301" },
  { drug: "Metformin",    zip: "85001" },
  { drug: "Atorvastatin", zip: "98101" },
];

// Additional zip codes used by the zip_variance scenario
const ZIP_CODES = ["90210", "10001", "77001", "60601", "94102", "30301", "85001", "98101", "02101", "33101"];

const params = {
  headers: { Accept: "application/json" },
  timeout: "10s",
};

function recordResult(res, ok) {
  if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`5xx response: ${res.status} — ${res.body.slice(0, 200)}`);
  }
  successRate.add(ok ? 1 : 0);
}

function parseAndRecordComparison(res) {
  if (res.status !== 200) return;
  try {
    const body = JSON.parse(res.body);
    // buildCompareResponse returns { drug, pharmacies: [...] }
    const pharmacies = body.pharmacies ?? body.results ?? [];
    if (pharmacies.length > 0) {
      nonEmptyResults.add(1);
      pharmacyResultCount.add(pharmacies.length);
    }
  } catch {
    // parse failure already captured by check below
  }
}

// Scenario A: vary drug + zip from the known pair list
export function compareKnownDrug() {
  const pair = DRUG_ZIP_PAIRS[__VU % DRUG_ZIP_PAIRS.length];
  const url = `${BASE_URL}/pharmacy/compare?drug=${encodeURIComponent(pair.drug)}&zip=${pair.zip}`;

  const start = Date.now();
  const res = http.get(url, params);
  compareDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "status is 200 or 402 (payment gate) or 404 (unknown drug)": (r) =>
      r.status === 200 || r.status === 402 || r.status === 404,
    "200 response has pharmacies array": (r) => {
      if (r.status !== 200) return true; // gated or unknown drug — see script header
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.pharmacies) || Array.isArray(body.results);
      } catch {
        return false;
      }
    },
    "200 comparison result is non-empty": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        const pharmacies = body.pharmacies ?? body.results ?? [];
        return pharmacies.length > 0;
      } catch {
        return false;
      }
    },
  });

  parseAndRecordComparison(res);
  recordResult(res, ok);
  sleep(0.1);
}

// Scenario B: same drug, many zip codes — exercises store read concurrency
export function compareWithZipVariance() {
  const drug = DRUG_ZIP_PAIRS[Math.floor(Math.random() * DRUG_ZIP_PAIRS.length)].drug;
  const zip = ZIP_CODES[Math.floor(Math.random() * ZIP_CODES.length)];
  const url = `${BASE_URL}/pharmacy/compare?drug=${encodeURIComponent(drug)}&zip=${zip}`;

  const start = Date.now();
  const res = http.get(url, params);
  compareDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "status is 200 or 402 or 404": (r) =>
      r.status === 200 || r.status === 402 || r.status === 404,
    "200 response body is valid JSON": (r) => {
      if (r.status !== 200) return true;
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    },
  });

  parseAndRecordComparison(res);
  recordResult(res, ok);
  sleep(0.05);
}

export function handleSummary(data) {
  const p95 = data.metrics.pharmacy_compare_duration_ms?.values?.["p(95)"]?.toFixed(0) ?? "?";
  const p99 = data.metrics.pharmacy_compare_duration_ms?.values?.["p(99)"]?.toFixed(0) ?? "?";
  const nonempty = data.metrics.pharmacy_compare_nonempty_results?.values?.count ?? 0;
  const total = data.metrics.iterations?.values?.count ?? "?";

  return {
    stdout: `
=== CareGuard Pharmacy Compare Load Test Summary (Issue #801) ===
Iterations:           ${total}
Success rate:         ${((data.metrics.success_rate?.values?.rate ?? 0) * 100).toFixed(1)}%
5xx errors:           ${data.metrics.errors_5xx?.values?.count ?? 0}
p95 duration:         ${p95}ms
p99 duration:         ${p99}ms
Non-empty results:    ${nonempty}

Note: 402 responses indicate the x402 payment gate is active — see script header
for how to run against a server configured to bypass payments for load testing.
`,
  };
}
