/**
 * lib/gate/__tests__/settle.test.ts — Phase 3
 *
 * Settlement state machine tests.
 *
 * All tests use a hand-rolled mock Supabase client and a mock createOrder.
 * No live DB or Razorpay API connection is needed.
 *
 * Coverage:
 *   beginSettlement — success path
 *   beginSettlement — createOrder failure → release_spend + audit + rethrow
 *   handleCaptured  — success path + idempotency (double webhook)
 *   handleFailed    — success path + idempotency (double webhook, release_spend not called twice)
 *   confirmPendingPayment — approved path, revoked-while-pending, expired-while-pending, cap-consumed-while-pending, double-confirmation
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { generateMandateKeyPair } from "../../mandate/keys";
import { issueMandate } from "../../mandate/sign";
import type { MandateInput } from "../../mandate/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MandateRow, PaymentRequest } from "../types";
import { REASON_CODES } from "../types";

// ── Mock createOrder ──────────────────────────────────────────────────────────
// We mock the Razorpay orders module so tests never hit the real API.
vi.mock("../../razorpay/orders", () => ({
  createOrder: vi.fn(),
}));

import { createOrder } from "../../razorpay/orders";
import {
  beginSettlement,
  handleCaptured,
  handleFailed,
  confirmPendingPayment,
} from "../settle";

const mockCreateOrder = createOrder as Mock;

// ── Test keypair ──────────────────────────────────────────────────────────────
const { publicKey, privateKey } = generateMandateKeyPair();
process.env.MANDATE_SIGNING_PUBLIC_KEY = publicKey;

// ── Mandate fixture ───────────────────────────────────────────────────────────

const NOW = new Date();
const YESTERDAY = new Date(NOW.getTime() - 86_400_000);
const NEXT_YEAR = new Date(NOW.getTime() + 365 * 86_400_000);
const LAST_YEAR = new Date(NOW.getTime() - 365 * 86_400_000);

function makeInput(overrides: Partial<MandateInput> = {}): MandateInput {
  return {
    agent_id: "agent-test",
    principal_id: "principal-test",
    scope: {
      merchant_allowlist: ["merchant-A"],
      category_allowlist: ["TRAVEL"],
    },
    limits: {
      max_per_txn: 100_000,
      daily_cap: 500_000,
      currency: "INR",
    },
    validity: {
      not_before: YESTERDAY.toISOString(),
      not_after: NEXT_YEAR.toISOString(),
    },
    confirmation_threshold: 200_000,
    ...overrides,
  };
}

// ── Mock Supabase builder for settle tests ────────────────────────────────────

interface SettleMockState {
  mandateRow: MandateRow | null;
  consumedRequests: Set<string>; // "mandate_id:request_id"
  auditLog: Array<Record<string, unknown>>;
  paymentAttempts: Array<Record<string, unknown>>;
  dailySpent: number;
  rpcError?: string; // if set, all rpc() calls return this error
  updateError?: string; // if set, update().select() returns 0 rows (already processed)
}

/**
 * Builds a minimal Supabase mock for settle.ts tests.
 *
 * settle.ts uses:
 *   db.from("payment_attempts").insert(...)
 *   db.from("payment_attempts").update(...).eq(...).eq(...).select("*")
 *   db.from("payment_attempts").update(...).eq(...)   [order_id stamp]
 *   db.from("audit_log").insert(...)
 *   db.from("consumed_requests").select().eq().eq().maybeSingle()
 *   db.from("consumed_requests").insert(...)
 *   db.from("mandates").select().eq().single()
 *   db.rpc("attempt_spend", ...)
 *   db.rpc("release_spend", ...)
 */
function buildSettleMockClient(state: SettleMockState): SupabaseClient {
  const fromImpl = (table: string) => {
    // Chainable builder
    const builder = {
      _filters: {} as Record<string, unknown>,
      _updates: {} as Record<string, unknown>,

      select<T = unknown>() {
        return {
          eq: (col: string, val: unknown) => ({
            eq: (col2: string, val2: unknown) => ({
              maybeSingle: (): Promise<{ data: unknown; error: null }> => {
                if (table === "consumed_requests") {
                  const key = `${col === "mandate_id" ? val : val2}:${col2 === "request_id" ? val2 : val}`;
                  const found = state.consumedRequests.has(key);
                  return Promise.resolve({
                    data: found ? { request_id: val2 } : null,
                    error: null,
                  });
                }
                return Promise.resolve({ data: null, error: null });
              },
            }),
            single<U = T>(): Promise<{
              data: U | null;
              error: { message: string } | null;
            }> {
              if (table === "mandates") {
                if (!state.mandateRow) {
                  return Promise.resolve({
                    data: null,
                    error: { message: "No rows" },
                  });
                }
                return Promise.resolve({
                  data: state.mandateRow as unknown as U,
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      },

      insert(payload: Record<string, unknown>) {
        if (table === "audit_log") {
          state.auditLog.push(payload);
          return Promise.resolve({ error: null });
        }
        if (table === "payment_attempts") {
          state.paymentAttempts.push({ ...payload });
          return Promise.resolve({ error: null });
        }
        if (table === "consumed_requests") {
          const key = `${payload.mandate_id}:${payload.request_id}`;
          state.consumedRequests.add(key);
          return Promise.resolve({ error: null });
        }
        return Promise.resolve({ error: null });
      },

      update(updates: Record<string, unknown>) {
        // Returns a chainable that accumulates eq() filters then resolves on select().
        const filters: Record<string, unknown> = {};
        const chain = {
          eq(col: string, val: unknown) {
            filters[col] = val;
            return chain;
          },
          select<U = unknown>(): Promise<{ data: U[] | null; error: null }> {
            if (table === "payment_attempts") {
              if (state.updateError) {
                return Promise.resolve({ data: [], error: null });
              }
              // Find matching row(s) by the filters
              const matching = state.paymentAttempts.filter((row) =>
                Object.entries(filters).every(([k, v]) => row[k] === v),
              );
              if (matching.length === 0) {
                return Promise.resolve({ data: [], error: null });
              }
              // Apply updates to matching rows
              for (const row of matching) {
                Object.assign(row, updates);
              }
              return Promise.resolve({
                data: matching as unknown as U[],
                error: null,
              });
            }
            return Promise.resolve({ data: [], error: null });
          },
          // For the order_id stamp (no .select() chained)
          then(resolve: (val: { error: null }) => void) {
            if (table === "payment_attempts") {
              const matching = state.paymentAttempts.filter((row) =>
                Object.entries(filters).every(([k, v]) => row[k] === v),
              );
              for (const row of matching) {
                Object.assign(row, updates);
              }
            }
            resolve({ error: null });
          },
        };
        return chain;
      },
    };

    return builder;
  };

  const rpcImpl = (
    fn: string,
    params: { p_mandate_id: string; p_amount: number },
  ) => {
    if (state.rpcError) {
      return Promise.resolve({
        data: null,
        error: { message: state.rpcError },
      });
    }
    if (fn === "attempt_spend") {
      const dailyCap = state.mandateRow?.limits_daily_cap ?? 0;
      if (state.dailySpent + params.p_amount <= dailyCap) {
        state.dailySpent += params.p_amount;
        return Promise.resolve({
          data: [{ new_daily_spent: state.dailySpent }],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    }
    if (fn === "release_spend") {
      state.dailySpent = Math.max(state.dailySpent - params.p_amount, 0);
      return Promise.resolve({
        data: [{ new_daily_spent: state.dailySpent }],
        error: null,
      });
    }
    return Promise.resolve({ data: [], error: null });
  };

  return { from: fromImpl, rpc: rpcImpl } as unknown as SupabaseClient;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mandateToRow(
  m: ReturnType<typeof issueMandate>,
  overrides: Partial<MandateRow> = {},
): MandateRow {
  return {
    mandate_id: m.mandate_id,
    agent_id: m.agent_id,
    principal_id: m.principal_id,
    scope_merchant_allowlist: m.scope.merchant_allowlist,
    scope_category_allowlist: m.scope.category_allowlist,
    limits_max_per_txn: m.limits.max_per_txn,
    limits_daily_cap: m.limits.daily_cap,
    limits_currency: m.limits.currency,
    validity_not_before: m.validity.not_before,
    validity_not_after: m.validity.not_after,
    confirmation_threshold: m.confirmation_threshold,
    nonce: m.nonce,
    status: m.status,
    signature: m.signature,
    daily_spent: 0,
    ...overrides,
  };
}

function makeRequest(
  mandate_id: string,
  overrides: Partial<PaymentRequest> = {},
): PaymentRequest {
  return {
    mandate_id,
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    amount: 10_000,
    merchant_id: "merchant-A",
    category: "TRAVEL",
    ...overrides,
  };
}

// ── Test state ────────────────────────────────────────────────────────────────

let state: SettleMockState;
let mandate: ReturnType<typeof issueMandate>;
let client: SupabaseClient;

beforeEach(() => {
  mandate = issueMandate(makeInput(), privateKey);
  state = {
    mandateRow: mandateToRow(mandate),
    consumedRequests: new Set(),
    auditLog: [],
    paymentAttempts: [],
    dailySpent: 0,
  };
  client = buildSettleMockClient(state);
  mockCreateOrder.mockReset();
});

// ────────────────────────────────────────────────────────────────────────────
// beginSettlement
// ────────────────────────────────────────────────────────────────────────────

describe("beginSettlement", () => {
  it("inserts a pending payment_attempts row and returns razorpayOrderId on success", async () => {
    const ORDER_ID = "order_abc123";
    mockCreateOrder.mockResolvedValueOnce({ id: ORDER_ID });

    const request = makeRequest(mandate.mandate_id);
    // Simulate: consumed_requests already has the approved entry
    state.consumedRequests.add(`${mandate.mandate_id}:${request.request_id}`);

    const decision = {
      outcome: "approved" as const,
      mandate_id: mandate.mandate_id,
      request_id: request.request_id,
    };

    const result = await beginSettlement(request, decision, client);

    expect(result.razorpayOrderId).toBe(ORDER_ID);
    expect(state.paymentAttempts).toHaveLength(1);
    const attempt = state.paymentAttempts[0];
    expect(attempt.mandate_id).toBe(mandate.mandate_id);
    expect(attempt.request_id).toBe(request.request_id);
    expect(attempt.amount).toBe(request.amount);
    expect(attempt.razorpay_order_id).toBe(ORDER_ID);
    expect(attempt.settlement_status).toBe("pending");
    // No audit log for successful begin (audit is written at capture/fail time).
    expect(state.auditLog).toHaveLength(0);
  });

  it("calls release_spend and writes audit with ORDER_CREATION_FAILED_SPEND_RELEASED when createOrder throws", async () => {
    mockCreateOrder.mockRejectedValueOnce(new Error("Razorpay API error"));
    // Pre-spend the amount (simulating evaluateGateDecision having reserved it)
    state.dailySpent = 10_000;

    const request = makeRequest(mandate.mandate_id);
    const decision = {
      outcome: "approved" as const,
      mandate_id: mandate.mandate_id,
      request_id: request.request_id,
    };

    await expect(beginSettlement(request, decision, client)).rejects.toThrow(
      "Razorpay API error",
    );

    // Spend must be released (daily_spent back to 0)
    expect(state.dailySpent).toBe(0);

    // Audit row written documenting the compensating event
    expect(state.auditLog).toHaveLength(1);
    expect(state.auditLog[0]).toMatchObject({
      decision: "settled",
      reason_code: REASON_CODES.ORDER_CREATION_FAILED_SPEND_RELEASED,
      mandate_id: mandate.mandate_id,
      request_id: request.request_id,
    });

    // The payment_attempts row should be updated to 'failed'
    expect(state.paymentAttempts[0]?.settlement_status).toBe("failed");
  });

  it("throws if decision outcome is not 'approved'", async () => {
    const request = makeRequest(mandate.mandate_id);
    const decision = {
      outcome: "rejected" as const,
      reason_code: REASON_CODES.CAP_EXCEEDED,
      mandate_id: mandate.mandate_id,
      request_id: request.request_id,
    };

    await expect(beginSettlement(request, decision, client)).rejects.toThrow(
      "beginSettlement called with non-approved outcome",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleCaptured
// ────────────────────────────────────────────────────────────────────────────

describe("handleCaptured", () => {
  const ORDER_ID = "order_cap123";
  const PAYMENT_ID = "pay_captured456";

  beforeEach(() => {
    // Pre-populate a pending payment_attempts row
    state.paymentAttempts.push({
      id: 1,
      mandate_id: mandate.mandate_id,
      request_id: "req-cap",
      amount: 10_000,
      currency: "INR",
      razorpay_order_id: ORDER_ID,
      razorpay_payment_id: null,
      settlement_status: "pending",
    });
  });

  it("transitions to 'captured' and writes a settled audit row", async () => {
    await handleCaptured(ORDER_ID, PAYMENT_ID, client);

    const attempt = state.paymentAttempts[0];
    expect(attempt.settlement_status).toBe("captured");
    expect(attempt.razorpay_payment_id).toBe(PAYMENT_ID);

    expect(state.auditLog).toHaveLength(1);
    expect(state.auditLog[0]).toMatchObject({
      decision: "settled",
      reason_code: null,
      mandate_id: mandate.mandate_id,
    });
  });

  it("is idempotent: second call with same orderId does nothing (already captured)", async () => {
    await handleCaptured(ORDER_ID, PAYMENT_ID, client);
    expect(state.auditLog).toHaveLength(1);

    // Second call — CAS finds no 'pending' row
    await handleCaptured(ORDER_ID, PAYMENT_ID, client);

    // Audit log must not grow
    expect(state.auditLog).toHaveLength(1);
    expect(state.paymentAttempts[0].settlement_status).toBe("captured");
  });

  it("is a no-op for an unknown orderId (no matching row)", async () => {
    await handleCaptured("order_UNKNOWN", PAYMENT_ID, client);
    expect(state.auditLog).toHaveLength(0);
    expect(state.paymentAttempts[0].settlement_status).toBe("pending");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleFailed
// ────────────────────────────────────────────────────────────────────────────

describe("handleFailed", () => {
  const ORDER_ID = "order_fail789";

  beforeEach(() => {
    state.dailySpent = 10_000; // reserved by attempt_spend before beginSettlement
    state.paymentAttempts.push({
      id: 2,
      mandate_id: mandate.mandate_id,
      request_id: "req-fail",
      amount: 10_000,
      currency: "INR",
      razorpay_order_id: ORDER_ID,
      razorpay_payment_id: null,
      settlement_status: "pending",
    });
  });

  it("releases spend, transitions to 'failed', writes audit with SETTLEMENT_FAILED_SPEND_RELEASED", async () => {
    await handleFailed(ORDER_ID, client);

    expect(state.dailySpent).toBe(0);
    expect(state.paymentAttempts[0].settlement_status).toBe("failed");
    expect(state.auditLog).toHaveLength(1);
    expect(state.auditLog[0]).toMatchObject({
      decision: "settled",
      reason_code: REASON_CODES.SETTLEMENT_FAILED_SPEND_RELEASED,
      mandate_id: mandate.mandate_id,
    });
  });

  it("is idempotent: second call does NOT call release_spend again", async () => {
    await handleFailed(ORDER_ID, client);
    expect(state.dailySpent).toBe(0);
    expect(state.auditLog).toHaveLength(1);

    // Artificially put some spend back to detect if release_spend fires again
    state.dailySpent = 9999;

    await handleFailed(ORDER_ID, client);

    // release_spend must NOT have fired — dailySpent unchanged
    expect(state.dailySpent).toBe(9999);
    // Audit log must not grow
    expect(state.auditLog).toHaveLength(1);
  });

  it("is a no-op for an unknown orderId", async () => {
    await handleFailed("order_UNKNOWN", client);
    expect(state.dailySpent).toBe(10_000); // no change
    expect(state.auditLog).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// confirmPendingPayment
// ────────────────────────────────────────────────────────────────────────────

describe("confirmPendingPayment", () => {
  it("approves when mandate is still valid and cap is available", async () => {
    const request = makeRequest(mandate.mandate_id);
    const decision = await confirmPendingPayment(request, client);

    expect(decision.outcome).toBe("approved");
    expect(decision.reason_code).toBeUndefined();

    // attempt_spend must have been called (dailySpent updated)
    expect(state.dailySpent).toBe(request.amount);

    // consumed_requests inserted
    expect(
      state.consumedRequests.has(`${mandate.mandate_id}:${request.request_id}`),
    ).toBe(true);

    // audit row written
    expect(state.auditLog).toHaveLength(1);
    expect(state.auditLog[0]).toMatchObject({ decision: "approved" });
  });

  it("rejects with MANDATE_REVOKED when mandate was revoked while pending", async () => {
    if (state.mandateRow) state.mandateRow.status = "revoked";
    const request = makeRequest(mandate.mandate_id);
    const decision = await confirmPendingPayment(request, client);

    expect(decision.outcome).toBe("rejected");
    expect(decision.reason_code).toBe(REASON_CODES.MANDATE_REVOKED);
    expect(state.dailySpent).toBe(0); // no spend committed
  });

  it("rejects with MANDATE_EXPIRED when mandate expired while pending", async () => {
    const expiredMandate = issueMandate(
      makeInput({
        validity: {
          not_before: LAST_YEAR.toISOString(),
          not_after: YESTERDAY.toISOString(), // already expired
        },
      }),
      privateKey,
    );
    state.mandateRow = mandateToRow(expiredMandate);
    const request = makeRequest(expiredMandate.mandate_id);
    const decision = await confirmPendingPayment(request, client);

    expect(decision.outcome).toBe("rejected");
    expect(decision.reason_code).toBe(REASON_CODES.MANDATE_EXPIRED);
    expect(state.dailySpent).toBe(0);
  });

  it("rejects with CAP_EXCEEDED when cap was consumed while pending", async () => {
    // Fully consume the daily cap
    state.dailySpent = state.mandateRow!.limits_daily_cap;
    const request = makeRequest(mandate.mandate_id);
    const decision = await confirmPendingPayment(request, client);

    expect(decision.outcome).toBe("rejected");
    expect(decision.reason_code).toBe(REASON_CODES.CAP_EXCEEDED);
  });

  it("rejects with MANDATE_NOT_FOUND when mandate was deleted", async () => {
    state.mandateRow = null;
    const request = makeRequest(mandate.mandate_id);
    const decision = await confirmPendingPayment(request, client);

    expect(decision.outcome).toBe("rejected");
    expect(decision.reason_code).toBe(REASON_CODES.MANDATE_NOT_FOUND);
  });

  it("rejects with DUPLICATE_REQUEST on double-confirmation of same request_id", async () => {
    const request = makeRequest(mandate.mandate_id);
    // Pre-mark as already consumed
    state.consumedRequests.add(`${mandate.mandate_id}:${request.request_id}`);

    const decision = await confirmPendingPayment(request, client);

    expect(decision.outcome).toBe("rejected");
    expect(decision.reason_code).toBe(REASON_CODES.DUPLICATE_REQUEST);
    expect(state.dailySpent).toBe(0); // no spend committed on duplicate
  });

  it("rejects with OUT_OF_SCOPE when merchant is not in allowlist", async () => {
    const request = makeRequest(mandate.mandate_id, {
      merchant_id: "merchant-NOT-ALLOWED",
    });
    const decision = await confirmPendingPayment(request, client);

    expect(decision.outcome).toBe("rejected");
    expect(decision.reason_code).toBe(REASON_CODES.OUT_OF_SCOPE);
    expect(state.dailySpent).toBe(0);
  });
});
