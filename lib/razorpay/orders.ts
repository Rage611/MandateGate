/**
 * lib/razorpay/orders.ts — Phase 3
 *
 * Thin wrapper around the Razorpay Orders API.
 *
 * The receipt_id is set to the gate's request_id so every Razorpay order is
 * traceable back to the mandate gate decision that authorised it.
 */

import type { Orders } from "razorpay/dist/types/orders";
import { getRazorpayClient } from "./client";

export type RazorpayOrder = Orders.RazorpayOrder;

/**
 * Creates a Razorpay Order in test mode.
 *
 * @param amount     - Amount in paise (smallest INR unit). Must be > 0.
 * @param currency   - ISO currency code. Default "INR".
 * @param receiptId  - The gate's request_id. Max 40 chars, must be unique per order.
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
    receipt: receiptId.slice(0, 40), // Razorpay receipt max length: 40 chars
  });
}
