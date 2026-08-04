/**
 * k6 load test — GET /drug/interactions under concurrent load (Issue #802)
 *
 * Targets services/drug-interaction-api/server.ts's GET /drug/interactions endpoint,
 * which runs an O(n²) pair-checking loop over the submitted drug list. The goal is to:
 *   1. Confirm the MAX_TEXT_LIST_ITEMS=20 cap rejects over-limit lists quickly (not slowly)
 *   2. Verify p95 latency stays bounded under concurrency with large (≤20) drug lists
 *   3. Record returned interaction-pair counts across the load run
 *
 * Usage:
 *   pnpm load:drug-interactions
 *   # or directly:
 *   k6 run load/drug-interactions.js
 *   BASE_URL=https://your-app.onrender.com k6 run load/drug-interactions.js
 *
 * Requires: k6 installed (https://k6.io/docs/getting-started/installation/)
 *
 * IMPORTANT — x402 payment gate: GET /drug/interactions is x402-payment-protected
 * ($0.001 per check via OZ Facilitator on Stellar testnet). This script does NOT
 * perform real Stellar payments, so it will receive 402 responses against a live
 * server with a valid OZ_FACILITATOR_API_KEY. A 402 is treated as an expected
 * "payment gate active" response and is NOT a failure.
 *
 * To load test the actual interaction computation, run the drug interaction server
 * with the payment middleware bypassed (remove or mock applyX402Middleware).
 *
 * CI / manual runs:
 *   pnpm load:drug-interactions                              # localhost:3003
 *   BASE_URL=http://staging:3003 k6 run load/drug-interactions.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// --- Metrics ---
const errors5xx = new Counter("errors_5xx");
const successRate = new Rate("success_rate");
const checkDuration = new Trend("drug_interaction_check_duration_ms", true);
const interactionPairsTotal = new Counter("interaction_pairs_total");
const overLimitRejections = new Counter("over_limit_rejections");

// --- Config ---
export const options = {
  scenarios: {
    // Small drug lists (2–5 meds): typical real-world use case
    small_lists: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 10 },
        { duration: "1m",  target: 25 },
        { duration: "30s", target: 0 },
      ],
      exec: "checkSmallList",
    },
    // Large drug lists (18–20 meds, at the cap): stresses the O(n²) path
    large_lists: {
      executor: "constant-vus",
      vus: 5,
      duration: "1m",
      exec: "checkLargeList",
      startTime: "30s",
    },
    // Over-limit lists (21+ meds): must be rejected quickly, never processed
    over_limit: {
      executor: "constant-vus",
      vus: 3,
      duration: "1m",
      exec: "checkOverLimit",
      startTime: "30s",
    },
  },
  thresholds: {
    // Zero 5xx — cap violations must return 400, not 500
    errors_5xx: ["count==0"],
    // p95 latency under 600ms (O(n²) on 20 drugs is still fast; if it degrades
    // under concurrency that's the signal we want to catch)
    drug_interaction_check_duration_ms: ["p(95)<600"],
    // 99%+ of requests handled without error
    success_rate: ["rate>0.99"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3003";

// Drugs that exist in the interaction database
// (from services/drug-interaction-api/logic.ts's INTERACTIONS table)
const ALL_KNOWN_DRUGS = [
  "Lisinopril",
  "Metformin",
  "Atorvastatin",
  "Amlodipine",
  "Potassium",
  "Ibuprofen",
  "Omeprazole",
  "Alcohol",
  "Grapefruit",
];

// Extra drug names to pad lists up to the 20-item cap
const EXTRA_DRUGS = [
  "Aspirin",
  "Warfarin",
  "Clopidogrel",
  "Simvastatin",
  "Losartan",
  "Hydrochlorothiazide",
  "Gabapentin",
  "Levothyroxine",
  "Pantoprazole",
  "Sertraline",
  "Escitalopram",
];

const REQUEST_PARAMS = {
  timeout: "10s",
};

/** Build a comma-separated drug list string of the requested length. */
function buildMedsList(count) {
  const pool = [...ALL_KNOWN_DRUGS, ...EXTRA_DRUGS];
  const selected = [];
  for (let i = 0; i < count; i++) {
    selected.push(pool[i % pool.length]);
  }
  return selected.join(",");
}

/**
 * Scenario: small drug list (2–5 meds).
 * Representative of real-world caregiver use: Rosa's 4 medications.
 */
export function checkSmallList() {
  const count = 2 + Math.floor(Math.random() * 4); // 2, 3, 4, or 5
  const meds = buildMedsList(count);
  const url = `${BASE_URL}/drug/interactions?meds=${encodeURIComponent(meds)}`;

  const start = Date.now();
  const res = http.get(url, REQUEST_PARAMS);
  checkDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "status is 200 or 402 (payment gate)": (r) =>
      r.status === 200 || r.status === 402,
    "200 response has interactionCount": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        return typeof body.interactionCount === "number";
      } catch {
        return false;
      }
    },
    "200 response has interactions array": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.interactions);
      } catch {
        return false;
      }
    },
  });

  if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`5xx from /drug/interactions (small): ${res.status} — ${res.body.slice(0, 200)}`);
  }

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      interactionPairsTotal.add(body.interactionCount ?? 0);
    } catch {
      // parse failure already flagged by checks above
    }
  }

  successRate.add(ok ? 1 : 0);
  sleep(0.1);
}

/**
 * Scenario: large drug list (18–20 meds, at the cap boundary).
 * Stresses the O(n²) pair-checking loop. p95 must stay within budget even
 * under concurrent load.
 */
export function checkLargeList() {
  // 18, 19, or 20 — all within MAX_TEXT_LIST_ITEMS=20
  const count = 18 + Math.floor(Math.random() * 3);
  const meds = buildMedsList(count);
  const url = `${BASE_URL}/drug/interactions?meds=${encodeURIComponent(meds)}`;

  const start = Date.now();
  const res = http.get(url, REQUEST_PARAMS);
  checkDuration.add(Date.now() - start);

  const ok = check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "status is 200 or 402 (payment gate)": (r) =>
      r.status === 200 || r.status === 402,
    "large list 200 has interactionCount": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        return typeof body.interactionCount === "number";
      } catch {
        return false;
      }
    },
  });

  if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`5xx from /drug/interactions (large): ${res.status} — ${res.body.slice(0, 200)}`);
  }

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      interactionPairsTotal.add(body.interactionCount ?? 0);
    } catch {
      // ignore
    }
  }

  successRate.add(ok ? 1 : 0);
  sleep(0.2);
}

/**
 * Scenario: over-limit drug list (21+ meds, exceeds MAX_TEXT_LIST_ITEMS=20).
 * These must be rejected QUICKLY (400 validation error), not processed —
 * the O(n²) loop must never run on an over-limit list.
 * Rejection latency is tracked: if it's high, the cap is not enforcing early.
 */
export function checkOverLimit() {
  // 21–25 drugs, clearly over the cap
  const count = 21 + Math.floor(Math.random() * 5);
  const meds = buildMedsList(count);
  const url = `${BASE_URL}/drug/interactions?meds=${encodeURIComponent(meds)}`;

  const start = Date.now();
  const res = http.get(url, REQUEST_PARAMS);
  const elapsed = Date.now() - start;
  checkDuration.add(elapsed);

  const ok = check(res, {
    "over-limit list is rejected with 400 (not 500)": (r) => r.status === 400,
    "over-limit rejection is fast (< 200ms)": (_r) => elapsed < 200,
    "400 body has error message": (r) => {
      if (r.status !== 400) return true;
      try {
        const body = JSON.parse(r.body);
        return typeof body.error === "string" && body.error.length > 0;
      } catch {
        return false;
      }
    },
  });

  if (res.status >= 500) {
    errors5xx.add(1);
    console.error(`5xx from /drug/interactions (over-limit): ${res.status} — ${res.body.slice(0, 200)}`);
  }

  if (res.status === 400) {
    overLimitRejections.add(1);
  }

  successRate.add(ok ? 1 : 0);
  sleep(0.1);
}

export function handleSummary(data) {
  const p95 = data.metrics.drug_interaction_check_duration_ms?.values?.["p(95)"]?.toFixed(0) ?? "?";
  const totalIter = data.metrics.iterations?.values?.count ?? "?";
  const rate = ((data.metrics.success_rate?.values?.rate ?? 0) * 100).toFixed(1);
  const fivexx = data.metrics.errors_5xx?.values?.count ?? 0;
  const pairs = data.metrics.interaction_pairs_total?.values?.count ?? 0;
  const rejections = data.metrics.over_limit_rejections?.values?.count ?? 0;

  return {
    stdout: `
=== CareGuard Drug Interactions Load Test Summary (Issue #802) ===
Iterations:                   ${totalIter}
Success rate:                 ${rate}%
5xx errors:                   ${fivexx}
p95 check latency:            ${p95}ms
Total interaction pairs seen: ${pairs}
Over-limit rejections (400):  ${rejections}

Note: 402 responses indicate the x402 payment gate is active — see script header
for how to bypass it for load testing the interaction computation path directly.

Over-limit rejection fast-path: if the rejection latency is >200ms, the Zod
validation cap is not short-circuiting before the O(n²) loop.
`,
  };
}
