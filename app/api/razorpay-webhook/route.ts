/**
 * app/api/razorpay-webhook/route.ts — Phase 3
 *
 * Razorpay webhook receiver.
 *
 * Security contract:
 *   1. Read the raw request body as text (request.text()).
 *      This is required — Razorpay's signature is HMAC-SHA256 of the exact
 *      byte sequence it sent. Parsing to JSON and re-serialising would alter
 *      whitespace and fail the check.
 *   2. Verify the x-razorpay-signature header using Razorpay.validateWebhookSignature
 *      before any state mutation. An unsigned or badly-signed request is
 *      rejected with 401 before touching the DB.
 *   3. Dispatch on event.event. Unknown events return 200 — Razorpay will send
 *      many event types (order.paid, refund.created, etc.) and a non-2xx
 *      response triggers Razorpay's exponential retry schedule.
 *
 * Webhook signature env var: RAZORPAY_WEBHOOK_SECRET
 *   This is NOT the same as RAZORPAY_KEY_SECRET. It is the secret configured
 *   in the Razorpay Dashboard under Settings → Webhooks when you add an endpoint.
 */

import Razorpay from "razorpay";
import { handleCaptured, handleFailed } from "@/lib/gate/settle";

// Force dynamic rendering — this route reads request headers and body.
export const dynamic = "force-dynamic";

// ── Env helper ────────────────────────────────────────────────────────────────

function getWebhookSecret(): string {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "RAZORPAY_WEBHOOK_SECRET is not set. " +
        "Add it to .env.local (Dashboard → Settings → Webhooks → your endpoint → Secret).",
    );
  }
  return secret;
}

// ── Webhook payload types ─────────────────────────────────────────────────────

interface RazorpayWebhookPayload {
  entity: string;
  event: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string; // razorpay_payment_id
        order_id?: string; // razorpay_order_id
      };
    };
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // ── 1. Read raw body ──────────────────────────────────────────────────────
  // Must be read BEFORE any JSON.parse. request.text() returns the raw string
  // exactly as received — no re-serialisation — which is what Razorpay signed.
  const rawBody = await request.text();

  // ── 2. Verify signature before any state change ───────────────────────────
  const signature = request.headers.get("x-razorpay-signature");

  if (!signature) {
    return new Response(
      JSON.stringify({ error: "Missing x-razorpay-signature header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  let webhookSecret: string;
  try {
    webhookSecret = getWebhookSecret();
  } catch (err) {
    // Misconfigured server — return 500 so Razorpay retries.
    console.error(
      "[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET not configured:",
      err,
    );
    return new Response(
      JSON.stringify({ error: "Webhook secret not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const isValid = Razorpay.validateWebhookSignature(
    rawBody,
    signature,
    webhookSecret,
  );

  if (!isValid) {
    // Reject before touching any application state. This protects against
    // spoofed webhooks that could trigger release_spend or audit writes.
    return new Response(
      JSON.stringify({ error: "Invalid webhook signature" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── 3. Parse and dispatch ─────────────────────────────────────────────────
  let event: RazorpayWebhookPayload;
  try {
    event = JSON.parse(rawBody) as RazorpayWebhookPayload;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const orderId = event.payload?.payment?.entity?.order_id;
  const paymentId = event.payload?.payment?.entity?.id;

  try {
    switch (event.event) {
      case "payment.captured": {
        if (!orderId || !paymentId) {
          console.error(
            "[razorpay-webhook] payment.captured missing order_id or payment_id",
            event,
          );
          break;
        }
        await handleCaptured(orderId, paymentId);
        break;
      }

      case "payment.failed": {
        if (!orderId) {
          console.error(
            "[razorpay-webhook] payment.failed missing order_id",
            event,
          );
          break;
        }
        await handleFailed(orderId);
        break;
      }

      default:
        // Unknown event type — ignore but return 200 so Razorpay doesn't retry.
        break;
    }
  } catch (err) {
    // Log and return 500 so Razorpay retries with exponential backoff.
    // Do NOT return 200 on unexpected errors — that would tell Razorpay delivery succeeded.
    console.error(
      `[razorpay-webhook] Error handling event ${event.event}:`,
      err,
    );
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
