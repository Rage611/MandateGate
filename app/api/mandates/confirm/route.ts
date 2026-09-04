import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { confirmPendingPayment, beginSettlement } from "@/lib/gate/settle";
import type { PaymentRequest } from "@/lib/gate/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as {
      mandate_id?: string;
      request_id?: string;
    };
    const { mandate_id, request_id } = body;

    if (!mandate_id || !request_id) {
      return NextResponse.json(
        { error: "mandate_id and request_id are required" },
        { status: 400 },
      );
    }

    const db = createServerSupabaseClient();
    if (!db) {
      return NextResponse.json(
        { error: "Database client is not configured" },
        { status: 500 },
      );
    }

    // SECURITY: Always fetch request details from the authoritative pending_confirmation
    // audit log entry. We never trust the caller's supplied amount, merchant_id, or
    // category — that would allow substituting different payment details at confirmation
    // time (Codex finding #31). The source of truth is what was evaluated by the gate
    // when it produced the pending_confirmation decision.
    const { data: auditRow, error: auditError } = await db
      .from("audit_log")
      .select("amount, merchant_id, category")
      .eq("mandate_id", mandate_id)
      .eq("request_id", request_id)
      .eq("decision", "pending_confirmation")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (auditError || !auditRow) {
      return NextResponse.json(
        {
          error:
            "No pending confirmation found for this mandate_id / request_id. It may have already been confirmed, rejected, or never held.",
        },
        { status: 404 },
      );
    }

    const request: PaymentRequest = {
      mandate_id,
      request_id,
      amount: Number(auditRow.amount),
      merchant_id: auditRow.merchant_id,
      category: auditRow.category,
    };

    // Call the core policy confirmation engine
    const decision = await confirmPendingPayment(request, db);

    let razorpayOrderId: string | null = null;

    // If approved, trigger settlement order creation
    if (decision.outcome === "approved") {
      try {
        const settlement = await beginSettlement(request, decision, db);
        razorpayOrderId = settlement.razorpayOrderId;
      } catch (settleErr) {
        return NextResponse.json(
          {
            decision,
            error:
              settleErr instanceof Error
                ? settleErr.message
                : "Settlement failed after confirmation approval",
          },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({
      success: decision.outcome === "approved",
      decision,
      razorpayOrderId,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "An unexpected error occurred during confirmation",
      },
      { status: 500 },
    );
  }
}
