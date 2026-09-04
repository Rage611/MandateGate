import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { confirmPendingPayment, beginSettlement } from "@/lib/gate/settle";
import type { PaymentRequest } from "@/lib/gate/types";

export const dynamic = "force-dynamic";

interface ConfirmRequestBody {
  mandate_id?: string;
  request_id?: string;
  amount?: number;
  merchant_id?: string;
  category?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body: ConfirmRequestBody = await req.json().catch(() => ({}));
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

    let request: PaymentRequest;

    if (
      body.amount !== undefined &&
      body.merchant_id !== undefined &&
      body.category !== undefined
    ) {
      request = {
        mandate_id,
        request_id,
        amount: Number(body.amount),
        merchant_id: String(body.merchant_id),
        category: String(body.category),
      };
    } else {
      // Look up original request details from the pending_confirmation audit log entry
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
              "Pending confirmation record not found in audit log. Please supply amount, merchant_id, and category.",
          },
          { status: 404 },
        );
      }

      request = {
        mandate_id,
        request_id,
        amount: Number(auditRow.amount),
        merchant_id: auditRow.merchant_id,
        category: auditRow.category,
      };
    }

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
