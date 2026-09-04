/**
 * app/api/dashboard/__tests__/dashboard-route.test.ts — Phase 5
 *
 * Tests for the GET /api/dashboard route handler.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock Supabase server client ───────────────────────────────────────────────
const mockSelect = vi.fn();
const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });

const mockDb = {
  from: mockFrom,
};

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(() => mockDb),
}));

import { GET } from "../route";

describe("GET /api/dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches audit logs, mandates, pending confirmations, and payment attempts", async () => {
    const mockAuditLogs = [
      {
        id: 1,
        mandate_id: "m-1",
        request_id: "req-1",
        decision: "approved",
        amount: 30000,
        merchant_id: "grocery",
      },
    ];

    const mockMandates = [
      {
        mandate_id: "m-1",
        status: "active",
        daily_spent: 30000,
        limits_daily_cap: 150000,
      },
    ];

    const mockConsumed = [{ mandate_id: "m-1", request_id: "req-1" }];

    const mockPendingAudits = [
      {
        id: 2,
        mandate_id: "m-1",
        request_id: "req-pending",
        decision: "pending_confirmation",
        amount: 120000,
      },
    ];

    const mockPaymentAttempts = [
      {
        id: 1,
        mandate_id: "m-1",
        request_id: "req-1",
        settlement_status: "captured",
      },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "audit_log") {
        return {
          select: vi.fn().mockImplementation(() => ({
            order: vi.fn().mockImplementation(() => ({
              limit: vi
                .fn()
                .mockResolvedValue({ data: mockAuditLogs, error: null }),
            })),
            eq: vi.fn().mockReturnValue({
              order: vi
                .fn()
                .mockResolvedValue({ data: mockPendingAudits, error: null }),
            }),
          })),
        };
      }
      if (table === "mandates") {
        return {
          select: vi.fn().mockReturnValue({
            order: vi
              .fn()
              .mockResolvedValue({ data: mockMandates, error: null }),
          }),
        };
      }
      if (table === "consumed_requests") {
        return {
          select: vi
            .fn()
            .mockResolvedValue({ data: mockConsumed, error: null }),
        };
      }
      if (table === "payment_attempts") {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi
                .fn()
                .mockResolvedValue({ data: mockPaymentAttempts, error: null }),
            }),
          }),
        };
      }
      return { select: vi.fn() };
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.auditLogs).toHaveLength(1);
    expect(json.mandates).toHaveLength(1);
    expect(json.pendingConfirmations).toHaveLength(1);
    expect(json.pendingConfirmations[0].request_id).toBe("req-pending");
    expect(json.paymentAttempts).toHaveLength(1);
    expect(json.timestamp).toBeDefined();
  });
});
