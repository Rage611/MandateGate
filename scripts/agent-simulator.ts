/**
 * scripts/agent-simulator.ts — Phase 4
 *
 * Simulates an AI shopping agent running 7 distinct scenarios against the
 * real MandateGate policy engine and Razorpay settlement pipeline.
 *
 * Usage:
 *   npm run simulate
 *
 * Exits with 0 if all scenarios pass, or 1 if any fail.
 */

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { createServerSupabaseClient } from "../lib/supabase/server";
import { issueMandate } from "../lib/mandate/sign";
import { evaluateGateDecision } from "../lib/gate/evaluate";
import {
  beginSettlement,
  handleCaptured,
  handleFailed,
  confirmPendingPayment,
} from "../lib/gate/settle";
import { REASON_CODES, type MandateRow } from "../lib/gate/types";
import { getRazorpayClient } from "../lib/razorpay/client";

// Ensure Razorpay client doesn't hit live mode (client enforces this via prefix).
getRazorpayClient();

const db = createServerSupabaseClient();
if (!db) {
  console.error("Missing Supabase credentials in .env.local");
  process.exit(1);
}
// TypeScript cannot narrow through process.exit() (typed void, not never),
// so we assert non-null explicitly after the guard.
const safeDb = db!;

const privateKey = process.env.MANDATE_SIGNING_PRIVATE_KEY;
if (!privateKey) {
  console.error("Missing MANDATE_SIGNING_PRIVATE_KEY in .env.local");
  process.exit(1);
}

const NOW = new Date();
const TOMORROW = new Date(NOW.getTime() + 86_400_000);

let passedCount = 0;
let failedCount = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function logScenario(title: string, desc: string) {
  console.log(
    `\n======================================================================`,
  );
  console.log(`\x1b[1m\x1b[36m${title}\x1b[0m`);
  console.log(`\x1b[3m${desc}\x1b[0m`);
  console.log(
    `----------------------------------------------------------------------`,
  );
}

function assertPass(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS:\x1b[0m ${msg}`);
  } else {
    console.log(`  \x1b[31m✘ FAIL:\x1b[0m ${msg}`);
    throw new Error("Assertion failed");
  }
}

async function insertMandate(mandate: ReturnType<typeof issueMandate>) {
  const row: MandateRow = {
    mandate_id: mandate.mandate_id,
    agent_id: mandate.agent_id,
    principal_id: mandate.principal_id,
    scope_merchant_allowlist: mandate.scope.merchant_allowlist,
    scope_category_allowlist: mandate.scope.category_allowlist,
    limits_max_per_txn: mandate.limits.max_per_txn,
    limits_daily_cap: mandate.limits.daily_cap,
    limits_currency: mandate.limits.currency,
    validity_not_before: mandate.validity.not_before,
    validity_not_after: mandate.validity.not_after,
    confirmation_threshold: mandate.confirmation_threshold,
    nonce: mandate.nonce,
    status: mandate.status,
    signature: mandate.signature,
    daily_spent: 0,
  };
  const { error } = await safeDb.from("mandates").insert(row);
  if (error) throw new Error(`Failed to insert mandate: ${error.message}`);
}

async function getDailySpent(mandate_id: string): Promise<number> {
  const { data, error } = await safeDb
    .from("mandates")
    .select("daily_spent")
    .eq("mandate_id", mandate_id)
    .single();
  if (error) throw error;
  return Number(data.daily_spent);
}

async function getSettlementStatus(
  mandate_id: string,
  request_id: string,
): Promise<string> {
  const { data, error } = await safeDb
    .from("payment_attempts")
    .select("settlement_status")
    .eq("mandate_id", mandate_id)
    .eq("request_id", request_id)
    .single();
  if (error) throw error;
  return data.settlement_status;
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n\x1b[1m\x1b[35mStarting Agent Simulator\x1b[0m\n`);

  // ── Setup: issue mandate
  const mandate = issueMandate(
    {
      agent_id: "agent-demo",
      principal_id: "user-demo",
      scope: {
        merchant_allowlist: ["merchant_grocery", "merchant_subscription"],
        category_allowlist: [],
      },
      limits: {
        max_per_txn: 50_000,
        daily_cap: 150_000,
        currency: "INR",
      },
      validity: {
        not_before: NOW.toISOString(),
        not_after: TOMORROW.toISOString(),
      },
      confirmation_threshold: 100_000,
    },
    privateKey!,
  );
  await insertMandate(mandate);
  console.log(`Created Mandate: ${mandate.mandate_id}`);
  console.log(`  Limits: max ₹500/txn, cap ₹1,500/day, threshold ₹1,000/txn`);
  console.log(`  Allowed Merchants: grocery, subscription`);

  // ── Scenario 1: Normal approved purchase
  try {
    logScenario(
      "Scenario 1: The Happy Path",
      "Agent requests ₹300 for groceries. Should be approved, captured, and tracked.",
    );
    const req1 = {
      mandate_id: mandate.mandate_id,
      request_id: "req-001",
      amount: 30_000,
      merchant_id: "merchant_grocery",
      category: "GROCERY",
    };

    const decision = await evaluateGateDecision(req1);
    console.log(`  Gate Decision: ${decision.outcome}`);
    assertPass(decision.outcome === "approved", "Gate approved request");

    const { razorpayOrderId } = await beginSettlement(req1, decision);
    console.log(`  Created Razorpay Order: ${razorpayOrderId}`);

    // Simulate webhook
    await handleCaptured(razorpayOrderId, "pay_sim123");

    const spent = await getDailySpent(mandate.mandate_id);
    const status = await getSettlementStatus(
      mandate.mandate_id,
      req1.request_id,
    );
    console.log(
      `  Post-capture state: daily_spent = ₹${spent / 100}, status = ${status}`,
    );

    assertPass(spent === 30_000, "daily_spent incremented by 30000");
    assertPass(status === "captured", "Settlement status is captured");
    passedCount++;
  } catch (err) {
    console.error(`  \x1b[31m✘ FAIL:\x1b[0m ${err}`);
    failedCount++;
  }

  // ── Scenario 2: Cap exceeded
  try {
    logScenario(
      "Scenario 2: The Hard Limit",
      "Agent requests ₹1,400, pushing total daily spend past the ₹1,500 cap.",
    );
    const req2 = {
      mandate_id: mandate.mandate_id,
      request_id: "req-002",
      amount: 140_000,
      merchant_id: "merchant_grocery",
      category: "GROCERY",
    };

    const decision = await evaluateGateDecision(req2);
    console.log(
      `  Gate Decision: ${decision.outcome} (Reason: ${decision.reason_code})`,
    );
    assertPass(
      decision.outcome === "rejected" &&
        decision.reason_code === REASON_CODES.CAP_EXCEEDED,
      "Gate rejected for CAP_EXCEEDED",
    );

    const spent = await getDailySpent(mandate.mandate_id);
    console.log(`  Post-rejection state: daily_spent = ₹${spent / 100}`);
    assertPass(spent === 30_000, "daily_spent unchanged at 30000");
    passedCount++;
  } catch (err) {
    console.error(`  \x1b[31m✘ FAIL:\x1b[0m ${err}`);
    failedCount++;
  }

  // ── Scenario 3: Out of scope
  try {
    logScenario(
      "Scenario 3: The Walled Garden",
      "Agent attempts a ₹100 purchase at an electronics merchant (not allowed).",
    );
    const req3 = {
      mandate_id: mandate.mandate_id,
      request_id: "req-003",
      amount: 10_000,
      merchant_id: "merchant_electronics",
      category: "ELECTRONICS",
    };

    const decision = await evaluateGateDecision(req3);
    console.log(
      `  Gate Decision: ${decision.outcome} (Reason: ${decision.reason_code})`,
    );
    assertPass(
      decision.outcome === "rejected" &&
        decision.reason_code === REASON_CODES.OUT_OF_SCOPE,
      "Gate rejected for OUT_OF_SCOPE",
    );
    passedCount++;
  } catch (err) {
    console.error(`  \x1b[31m✘ FAIL:\x1b[0m ${err}`);
    failedCount++;
  }

  // ── Scenario 4: Duplicate request
  try {
    logScenario(
      "Scenario 4: The Network Glitch (Idempotency)",
      "Agent resends exactly the same request as Scenario 1 (req-001).",
    );
    const req4 = {
      mandate_id: mandate.mandate_id,
      request_id: "req-001", // Replay
      amount: 30_000,
      merchant_id: "merchant_grocery",
      category: "GROCERY",
    };

    const preSpent = await getDailySpent(mandate.mandate_id);
    const decision = await evaluateGateDecision(req4);
    const postSpent = await getDailySpent(mandate.mandate_id);

    console.log(
      `  Gate Decision: ${decision.outcome} (Reason: ${decision.reason_code})`,
    );
    console.log(
      `  State: daily_spent before = ₹${preSpent / 100}, after = ₹${postSpent / 100}`,
    );

    assertPass(
      decision.outcome === "rejected" &&
        decision.reason_code === REASON_CODES.DUPLICATE_REQUEST,
      "Gate rejected for DUPLICATE_REQUEST",
    );
    assertPass(
      preSpent === postSpent,
      "daily_spent NOT incremented a second time",
    );
    passedCount++;
  } catch (err) {
    console.error(`  \x1b[31m✘ FAIL:\x1b[0m ${err}`);
    failedCount++;
  }

  // ── Scenario 5: Expired mandate
  try {
    logScenario(
      "Scenario 5: The Time Bomb (Expired Mandate)",
      "Agent uses a newly issued mandate that expired 1 second ago.",
    );
    const expiredMandate = issueMandate(
      {
        agent_id: "agent-demo",
        principal_id: "user-demo",
        scope: { merchant_allowlist: [], category_allowlist: [] },
        limits: { max_per_txn: 50_000, daily_cap: 150_000, currency: "INR" },
        validity: {
          not_before: new Date(NOW.getTime() - 86400000).toISOString(),
          not_after: new Date(NOW.getTime() - 1000).toISOString(), // 1 second ago
        },
        confirmation_threshold: 100_000,
      },
      privateKey!,
    );
    await insertMandate(expiredMandate);

    const req5 = {
      mandate_id: expiredMandate.mandate_id,
      request_id: "req-005-expired",
      amount: 10_000,
      merchant_id: "any",
      category: "any",
    };

    const decision = await evaluateGateDecision(req5);
    console.log(
      `  Gate Decision: ${decision.outcome} (Reason: ${decision.reason_code})`,
    );
    assertPass(
      decision.outcome === "rejected" &&
        decision.reason_code === REASON_CODES.MANDATE_EXPIRED,
      "Gate rejected for MANDATE_EXPIRED",
    );
    passedCount++;
  } catch (err) {
    console.error(`  \x1b[31m✘ FAIL:\x1b[0m ${err}`);
    failedCount++;
  }

  // ── Scenario 6: Confirmation threshold
  try {
    logScenario(
      "Scenario 6: The Human in the Loop (Confirmation Threshold)",
      "Agent requests ₹1,200. Over ₹1,000 threshold but under cap. Held then confirmed.",
    );
    const req6 = {
      mandate_id: mandate.mandate_id,
      request_id: "req-004",
      amount: 120_000,
      merchant_id: "merchant_grocery",
      category: "GROCERY",
    };

    const preSpent = await getDailySpent(mandate.mandate_id);
    const decision = await evaluateGateDecision(req6);
    const midSpent = await getDailySpent(mandate.mandate_id);

    console.log(
      `  Gate Decision: ${decision.outcome} (Reason: ${decision.reason_code})`,
    );
    console.log(`  Intermediate State: daily_spent = ₹${midSpent / 100}`);

    assertPass(
      decision.outcome === "pending_confirmation" &&
        decision.reason_code === REASON_CODES.NEEDS_CONFIRMATION,
      "Gate held for NEEDS_CONFIRMATION",
    );
    assertPass(
      preSpent === midSpent,
      "daily_spent NOT incremented while pending",
    );

    console.log(`  ... simulating human clicking 'Confirm' ...`);
    const confirmed = await confirmPendingPayment(req6);

    console.log(`  Confirmation Decision: ${confirmed.outcome}`);
    assertPass(
      confirmed.outcome === "approved",
      "Payment successfully confirmed",
    );

    const { razorpayOrderId } = await beginSettlement(req6, confirmed);
    await handleCaptured(razorpayOrderId, "pay_sim456");

    const postSpent = await getDailySpent(mandate.mandate_id);
    const status = await getSettlementStatus(
      mandate.mandate_id,
      req6.request_id,
    );

    console.log(
      `  Post-capture state: daily_spent = ₹${postSpent / 100}, status = ${status}`,
    );
    assertPass(
      postSpent === 150_000,
      "daily_spent properly incremented after confirmation",
    );
    assertPass(status === "captured", "Settlement status is captured");
    passedCount++;
  } catch (err) {
    console.error(`  \x1b[31m✘ FAIL:\x1b[0m ${err}`);
    failedCount++;
  }

  // ── Scenario 7: Settlement failure with release
  try {
    logScenario(
      "Scenario 7: The Bounced Check (Settlement Failure)",
      "Agent requests ₹200 (using a fresh mandate). Approved, but settlement fails. Reserved funds are released.",
    );
    const freshMandate = issueMandate(
      {
        agent_id: "agent-demo",
        principal_id: "user-demo",
        scope: { merchant_allowlist: [], category_allowlist: [] },
        limits: { max_per_txn: 50_000, daily_cap: 150_000, currency: "INR" },
        validity: {
          not_before: NOW.toISOString(),
          not_after: TOMORROW.toISOString(),
        },
        confirmation_threshold: 100_000,
      },
      privateKey!,
    );
    await insertMandate(freshMandate);

    const req7 = {
      mandate_id: freshMandate.mandate_id,
      request_id: "req-005",
      amount: 20_000,
      merchant_id: "any",
      category: "any",
    };

    const decision = await evaluateGateDecision(req7);
    const reservedSpent = await getDailySpent(freshMandate.mandate_id);

    console.log(`  Gate Decision: ${decision.outcome}`);
    console.log(`  Reserved State: daily_spent = ₹${reservedSpent / 100}`);
    assertPass(decision.outcome === "approved", "Gate approved request");
    assertPass(reservedSpent === 20_000, "Spend was reserved correctly");

    const { razorpayOrderId } = await beginSettlement(req7, decision);

    // Simulate webhook for payment failed
    await handleFailed(razorpayOrderId);

    const finalSpent = await getDailySpent(freshMandate.mandate_id);
    const status = await getSettlementStatus(
      freshMandate.mandate_id,
      req7.request_id,
    );

    console.log(
      `  Post-failure state: daily_spent = ₹${finalSpent / 100}, status = ${status}`,
    );
    assertPass(status === "failed", "Settlement status is failed");
    assertPass(finalSpent === 0, "daily_spent released back down by 20000");
    passedCount++;
  } catch (err) {
    console.error(`  \x1b[31m✘ FAIL:\x1b[0m ${err}`);
    failedCount++;
  }

  // ── Summary
  console.log(
    `\n======================================================================`,
  );
  console.log(`\x1b[1m\x1b[35mSummary\x1b[0m`);
  console.log(
    `----------------------------------------------------------------------`,
  );
  console.log(`Passed: ${passedCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`Total:  ${passedCount + failedCount}`);

  if (failedCount > 0) {
    console.error(`\n\x1b[31mScript finished with errors.\x1b[0m`);
    process.exit(1);
  } else {
    console.log(`\n\x1b[32mAll scenarios passed successfully.\x1b[0m`);
    process.exit(0);
  }
}

run();
