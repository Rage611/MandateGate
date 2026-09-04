/**
 * lib/razorpay/orders.ts — Phase 3
 *
 * Thin wrapper around the Razorpay Orders API.
 *
 * The receipt is derived from the gate's request_id so every Razorpay order is
 * traceable back to the mandate gate decision that authorised it.
 */

import type { Orders } from "razorpay/dist/types/orders";
import { getRazorpayClient } from "./client";
import { createHash } from "crypto";

export type RazorpayOrder = Orders.RazorpayOrder;

/**
 * Builds a Razorpay receipt string from a request_id.
 *
 * Razorpay receipts are max 40 chars and must be unique per order.
 * A raw slice(0,40) fails when two request_ids share a long common prefix
 * (e.g. "playground-550e8400-..." and "playground-550e8400-..." differ only
 * at char 41+). We use SHA-256 of the full request_id and take the first
 * 16 hex chars, then prefix with "rcp-" for readability: 20 chars total,
 * collision-resistant within any realistic request volume.
 */
function buildReceipt(requestId: string): string {
  const hash = createHash("sha256").update(requestId).digest("hex").slice(0, 16);
  return `rcp-${hash}`;
}

/**
 * Creates a Razorpay Order in test mode.
 *
 * @param amount     - Amount in paise (smallest INR unit). Must be > 0.
 * @param currency   - ISO currency code. Default "INR".
 * @param receiptId  - The gate's request_id. Hashed to a 20-char receipt.
 *                     Used as Razorpay `receipt` for end-to-end traceability.
 *
 * @returns The created RazorpayOrder (includes `id` = razorpay_order_id).
 *
 * @throws  On Razorpay API errors (network, auth, validation). The caller
 *          (beginSettlement in settle.ts) is responsible for catching this
 *          and calling release_spend to return the reserved amount.
 *
 * Test UPI IDs (Razorpay test mode):
 *   success@razorpay — forces a successful payment capture
 *   failure@razorpay — forces a payment failure
 */
export async function createOrder(
  amount: number,
  currency: string = "INR",
  receiptId: string,
): Promise<RazorpayOrder> {
  const rzp = getRazorpayClient();
  return rzp.orders.create({
    amount,
    currency,
    receipt: buildReceipt(receiptId),
  });
}
