/**
 * app/api/razorpay-webhook/__tests__/webhook.test.ts — Phase 3
 *
 * Tests for the Razorpay webhook route handler.
 *
 * Strategy:
 *   - The route handler is imported directly and called with a mock Request object.
 *   - handleCaptured and handleFailed are mocked via vi.mock so the test controls
 *     whether they succeed or throw.
 *   - Webhook signatures are computed using Node's crypto module with HMAC-SHA256,
 *     exactly as Razorpay does — so we test real signature verification, not a mock.
 *   - No live Razorpay API or ngrok tunnel needed.
 *
 * Webhook signature algorithm (same as Razorpay):
 *   HMAC-SHA256(rawBody, webhookSecret) → hex digest
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { createHmac } from "crypto";

// ── Mock settle.ts handlers ───────────────────────────────────────────────────
vi.mock("@/lib/gate/settle", () => ({
  handleCaptured: vi.fn(),
  handleFailed: vi.fn(),
  beginSettlement: vi.fn(),
  confirmPendingPayment: vi.fn(),
}));

import { handleCaptured, handleFailed } from "@/lib/gate/settle";
import { POST } from "../route";

const mockHandleCaptured = handleCaptured as Mock;
const mockHandleFailed = handleFailed as Mock;

// ── Constants ─────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-webhook-secret-12345";
const ORDER_ID = "order_abc123";
const PAYMENT_ID = "pay_xyz789";

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function buildPayload(
  eventName: string,
  orderId: string = ORDER_ID,
  paymentId: string = PAYMENT_ID,
): string {
  return JSON.stringify({
    entity: "event",
    event: eventName,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
        },
      },
    },
  });
}

function buildRequest(body: string, signature: string | null): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (signature !== null) {
    headers.set("x-razorpay-signature", signature);
  }
  return new Request("http://localhost/api/razorpay-webhook", {
    method: "POST",
    headers,
    body,
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  mockHandleCaptured.mockReset();
  mockHandleFailed.mockReset();
  mockHandleCaptured.mockResolvedValue(undefined);
  mockHandleFailed.mockResolvedValue(undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// Valid signatures — dispatch tests
// ────────────────────────────────────────────────────────────────────────────

describe("valid signature — payment.captured", () => {
  it("returns 200 and calls handleCaptured with orderId and paymentId", async () => {
    const body = buildPayload("payment.captured");
    const sig = computeSignature(body, WEBHOOK_SECRET);
    const req = buildRequest(body, sig);

    const res = await POST(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ received: true });
    expect(mockHandleCaptured).toHaveBeenCalledOnce();
    expect(mockHandleCaptured).toHaveBeenCalledWith(ORDER_ID, PAYMENT_ID);
    expect(mockHandleFailed).not.toHaveBeenCalled();
  });
});

describe("valid signature — payment.failed", () => {
  it("returns 200 and calls handleFailed with orderId", async () => {
    const body = buildPayload("payment.failed");
    const sig = computeSignature(body, WEBHOOK_SECRET);
    const req = buildRequest(body, sig);

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockHandleFailed).toHaveBeenCalledOnce();
    expect(mockHandleFailed).toHaveBeenCalledWith(ORDER_ID);
    expect(mockHandleCaptured).not.toHaveBeenCalled();
  });
});

describe("valid signature — unknown event type", () => {
  it("returns 200 but does not call any handler", async () => {
    const body = buildPayload("order.paid");
    const sig = computeSignature(body, WEBHOOK_SECRET);
    const req = buildRequest(body, sig);

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockHandleCaptured).not.toHaveBeenCalled();
    expect(mockHandleFailed).not.toHaveBeenCalled();
  });

  it("also ignores refund.created", async () => {
    const body = JSON.stringify({
      entity: "event",
      event: "refund.created",
      payload: {},
    });
    const sig = computeSignature(body, WEBHOOK_SECRET);
    const req = buildRequest(body, sig);

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockHandleCaptured).not.toHaveBeenCalled();
    expect(mockHandleFailed).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Signature validation failures — no state change
// ────────────────────────────────────────────────────────────────────────────

describe("missing signature header", () => {
  it("returns 401 before calling any handler", async () => {
    const body = buildPayload("payment.captured");
    const req = buildRequest(body, null); // no signature header

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(mockHandleCaptured).not.toHaveBeenCalled();
    expect(mockHandleFailed).not.toHaveBeenCalled();
  });
});

describe("invalid signature — tampered payload", () => {
  it("returns 401 when payload was modified after signing", async () => {
    const originalBody = buildPayload("payment.captured");
    // Sign the original body
    const sig = computeSignature(originalBody, WEBHOOK_SECRET);
    // But send a tampered body
    const tamperedBody = buildPayload(
      "payment.captured",
      "order_EVIL",
      "pay_EVIL",
    );

    const req = buildRequest(tamperedBody, sig);
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(mockHandleCaptured).not.toHaveBeenCalled();
  });

  it("returns 401 when signature uses wrong secret", async () => {
    const body = buildPayload("payment.captured");
    const wrongSig = computeSignature(body, "wrong-secret");

    const req = buildRequest(body, wrongSig);
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(mockHandleCaptured).not.toHaveBeenCalled();
  });

  it("returns 401 for a completely bogus signature value", async () => {
    const body = buildPayload("payment.captured");
    const req = buildRequest(body, "not-a-real-signature");

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(mockHandleCaptured).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Handler errors — should return 500 (so Razorpay retries)
// ────────────────────────────────────────────────────────────────────────────

describe("handler throws", () => {
  it("returns 500 when handleCaptured throws", async () => {
    mockHandleCaptured.mockRejectedValueOnce(new Error("DB down"));

    const body = buildPayload("payment.captured");
    const sig = computeSignature(body, WEBHOOK_SECRET);
    const req = buildRequest(body, sig);

    const res = await POST(req);

    expect(res.status).toBe(500);
    // Razorpay will retry because of the 500
  });

  it("returns 500 when handleFailed throws", async () => {
    mockHandleFailed.mockRejectedValueOnce(new Error("release_spend failed"));

    const body = buildPayload("payment.failed");
    const sig = computeSignature(body, WEBHOOK_SECRET);
    const req = buildRequest(body, sig);

    const res = await POST(req);

    expect(res.status).toBe(500);
  });
});
