import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { evaluateGateDecision } from "@/lib/gate/evaluate";
import { beginSettlement } from "@/lib/gate/settle";
import { sanitizeError } from "@/lib/api/sanitize-error";

export const dynamic = "force-dynamic";

/**
 * POST /api/gate/pay
 *
 * The live agent payment endpoint. Accepts a payment request, runs it through
 * the full MandateGate policy engine (all 10 steps: signature verify, lifecycle,
 * temporal, idempotency, scope, cap pre-check, threshold, atomic spend), and if
 * approved triggers Razorpay settlement.
 *
 * Body (JSON):
 *   mandate_id  string  — UUID of the mandate to check against
 *   amount      number  — Amount in paise (integer, > 0, max 1_000_000 = Rs.10,000)
 *   merchant_id string  — Merchant identifier
 *   category    string  — Category code e.g. "GROCERY", "TECH", "TRAVEL"
 *   request_id  string? — Optional idempotency key; auto-generated UUID if omitted
 */

const EXPLANATIONS: Record<string, string> = {
  approved:
    "Gate approved. Razorpay order created — payment is pending capture (settlement completes when Razorpay confirms the charge via webhook).",
  pending_confirmation:
    "Amount exceeds the mandate confirmation threshold — held for human approval. Check the Pending Confirmations panel above.",
  MANDATE_NOT_FOUND:
    "No mandate exists for this ID. The agent is attempting to pay with an unregistered or deleted mandate.",
  INVALID_SIGNATURE:
    "The mandate cryptographic signature is invalid — the mandate has been tampered with or the signing key is wrong.",
  MANDATE_REVOKED:
    "This mandate has been revoked or exhausted and is no longer active.",
  MANDATE_NOT_YET_VALID:
    "The mandate validity window has not started yet.",
  MANDATE_EXPIRED:
    "The mandate validity window has passed. Authorization has expired.",
  DUPLICATE_REQUEST:
    "This request_id was already processed under this mandate. Duplicate payments are blocked to prevent double-spending.",
  OUT_OF_SCOPE:
    "The merchant or category is not in this mandate's allowlist. The agent tried to buy outside its authorised scope.",
  CAP_EXCEEDED:
    "This transaction would push the daily spending past the mandate hard cap. The agent's daily budget is exhausted.",
  EXCEEDS_PER_TXN_LIMIT:
    "The transaction amount exceeds the mandate's per-transaction limit. Even with daily budget remaining, individual transactions are capped.",
  NEEDS_CONFIRMATION:
    "Amount exceeds the confirmation threshold — held for human review.",
};

function explain(decision: string, reason_code?: string | null): string {
  if (decision === "approved") return EXPLANATIONS["approved"];
  if (decision === "pending_confirmation" && reason_code === "NEEDS_CONFIRMATION") {
    return EXPLANATIONS["pending_confirmation"];
  }
  if (reason_code && EXPLANATIONS[reason_code]) return EXPLANATIONS[reason_code];
  return `Decision: ${decision}${reason_code ? ` (${reason_code})` : ""}.`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;

  if (!raw.mandate_id || typeof raw.mandate_id !== "string") {
    return NextResponse.json({ error: "mandate_id is required and must be a string." }, { status: 400 });
  }
  if (
    raw.amount === undefined ||
    raw.amount === null ||
    typeof raw.amount !== "number" ||
    !Number.isInteger(raw.amount) ||
    raw.amount <= 0
  ) {
    return NextResponse.json(
      { error: "amount is required and must be a positive integer in paise. E.g. Rs.100 = 10000 paise." },
      { status: 400 },
    );
  }
  if (raw.amount > 1_000_000) {
    return NextResponse.json(
      { error: "amount exceeds the playground maximum of Rs.10,000 (1,000,000 paise)." },
      { status: 400 },
    );
  }
  if (!raw.merchant_id || typeof raw.merchant_id !== "string") {
    return NextResponse.json({ error: "merchant_id is required and must be a string." }, { status: 400 });
  }
  if (!raw.category || typeof raw.category !== "string") {
    return NextResponse.json({ error: "category is required and must be a string (e.g. GROCERY, TECH, TRAVEL)." }, { status: 400 });
  }

  const request_id =
    raw.request_id && typeof raw.request_id === "string"
      ? raw.request_id
      : `playground-${randomUUID()}`;

  const mandate_id = raw.mandate_id as string;
  const amount = raw.amount as number;
  const merchant_id = raw.merchant_id as string;
  const category = (raw.category as string).toUpperCase();

  let decision;
  try {
    decision = await evaluateGateDecision({ mandate_id, request_id, amount, merchant_id, category });
  } catch (err) {
    return NextResponse.json(
      { error: sanitizeError(err, "gate/pay evaluateGateDecision") },
      { status: 500 },
    );
  }

  let razorpayOrderId: string | null = null;

  if (decision.outcome === "approved") {
    try {
      const settlement = await beginSettlement(
        { mandate_id, request_id, amount, merchant_id, category },
        decision,
      );
      razorpayOrderId = settlement.razorpayOrderId;
    } catch (err) {
      // Settlement failed after gate approval. The gate has already reserved budget
      // (beginSettlement releases it internally via release_spend on order failure),
      // so we must NOT silently return "approved" — the agent has no valid order to pay.
      sanitizeError(err, "gate/pay beginSettlement"); // logs full error server-side
      return NextResponse.json(
        {
          decision: "approved",
          reason_code: null,
          explanation:
            "Gate approved but Razorpay order creation failed. Budget has been released. Please retry.",
          mandate_id,
          request_id,
          amount,
          amount_inr: amount / 100,
          razorpay_order_id: null,
          settlement_error: "Order creation failed — no payment was charged.",
        },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    decision: decision.outcome,
    reason_code: decision.reason_code ?? null,
    explanation: explain(decision.outcome, decision.reason_code),
    mandate_id,
    request_id,
    amount,
    amount_inr: amount / 100,
    razorpay_order_id: razorpayOrderId,
  });
}
