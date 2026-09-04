/**
 * app/api/mandates/confirm/__tests__/confirm-route.test.ts — Phase 5
 *
 * Tests for the POST /api/mandates/confirm route handler.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// ── Mock settle.ts handlers ───────────────────────────────────────────────────
vi.mock("@/lib/gate/settle", () => ({
  confirmPendingPayment: vi.fn(),
  beginSettlement: vi.fn(),
}));

// ── Mock Supabase server client ───────────────────────────────────────────────
const mockMaybeSingle = vi.fn();
const mockLimit = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
const mockEqDecision = vi.fn().mockReturnValue({ order: mockOrder });
const mockEqRequestId = vi.fn().mockReturnValue({ eq: mockEqDecision });
const mockEqMandateId = vi.fn().mockReturnValue({ eq: mockEqRequestId });
const mockSelect = vi.fn().mockReturnValue({ eq: mockEqMandateId });
const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });

const mockDb = {
  from: mockFrom,
};

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(() => mockDb),
}));

import { confirmPendingPayment, beginSettlement } from "@/lib/gate/settle";
import { POST } from "../route";

const mockConfirmPendingPayment = confirmPendingPayment as Mock;
const mockBeginSettlement = beginSettlement as Mock;

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/mandates/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/mandates/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when mandate_id is missing", async () => {
    const req = makeRequest({ request_id: "req-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("mandate_id and request_id are required");
  });

  it("returns 400 when request_id is missing", async () => {
    const req = makeRequest({ mandate_id: "mandate-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("mandate_id and request_id are required");
  });

  it("approves and initiates settlement when full payload is provided", async () => {
    mockConfirmPendingPayment.mockResolvedValueOnce({
      outcome: "approved",
      mandate_id: "mandate-1",
      request_id: "req-1",
    });
    mockBeginSettlement.mockResolvedValueOnce({
      razorpayOrderId: "order_rzp123",
    });

    const req = makeRequest({
      mandate_id: "mandate-1",
      request_id: "req-1",
      amount: 120_000,
      merchant_id: "grocery",
      category: "FOOD",
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.decision.outcome).toBe("approved");
    expect(data.razorpayOrderId).toBe("order_rzp123");

    expect(mockConfirmPendingPayment).toHaveBeenCalledWith(
      {
        mandate_id: "mandate-1",
        request_id: "req-1",
        amount: 120_000,
        merchant_id: "grocery",
        category: "FOOD",
      },
      mockDb,
    );
    expect(mockBeginSettlement).toHaveBeenCalledTimes(1);
  });

  it("looks up request details from audit_log if omitted from payload", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        amount: "150000",
        merchant_id: "travel",
        category: "FLIGHTS",
      },
      error: null,
    });

    mockConfirmPendingPayment.mockResolvedValueOnce({
      outcome: "approved",
      mandate_id: "mandate-1",
      request_id: "req-1",
    });
    mockBeginSettlement.mockResolvedValueOnce({
      razorpayOrderId: "order_rzp456",
    });

    const req = makeRequest({
      mandate_id: "mandate-1",
      request_id: "req-1",
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.razorpayOrderId).toBe("order_rzp456");
    expect(mockConfirmPendingPayment).toHaveBeenCalledWith(
      {
        mandate_id: "mandate-1",
        request_id: "req-1",
        amount: 150_000,
        merchant_id: "travel",
        category: "FLIGHTS",
      },
      mockDb,
    );
  });

  it("returns 404 when audit_log lookup fails for omitted details", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const req = makeRequest({
      mandate_id: "mandate-1",
      request_id: "req-unknown",
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("Pending confirmation record not found");
    expect(mockConfirmPendingPayment).not.toHaveBeenCalled();
  });

  it("propagates rejection from confirmPendingPayment without calling beginSettlement", async () => {
    mockConfirmPendingPayment.mockResolvedValueOnce({
      outcome: "rejected",
      reason_code: "CAP_EXCEEDED",
      mandate_id: "mandate-1",
      request_id: "req-1",
    });

    const req = makeRequest({
      mandate_id: "mandate-1",
      request_id: "req-1",
      amount: 200_000,
      merchant_id: "grocery",
      category: "FOOD",
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(false);
    expect(data.decision.outcome).toBe("rejected");
    expect(data.decision.reason_code).toBe("CAP_EXCEEDED");
    expect(mockBeginSettlement).not.toHaveBeenCalled();
  });
});
