import { NextRequest, NextResponse } from "next/server";
import { issueMandate } from "@/lib/mandate/sign";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { MandateInput } from "@/lib/mandate/types";
import type { MandateRow } from "@/lib/gate/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/mandates/issue
 *
 * Accepts a human-approved MandateInput (the reviewed/possibly-edited proposal
 * from /api/mandates/propose) and issues a real, signed mandate.
 *
 * DESIGN: This route trusts the human's input entirely. It does NOT re-run
 * safety checks from the proposal stage — the human has reviewed the values
 * and is free to set a lower cap, higher cap, narrower scope, or any other
 * adjustment. Final responsibility is the human's once they approve.
 *
 * Only validates schema completeness (required fields present, correct types).
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      mandateInput?: unknown;
    };

    if (!body.mandateInput || typeof body.mandateInput !== "object") {
      return NextResponse.json(
        { error: "mandateInput is required" },
        { status: 400 },
      );
    }

    const input = body.mandateInput as Record<string, unknown>;

    // Validate required fields — schema completeness only, no safety re-checking
    const missingFields: string[] = [];
    if (typeof input.agent_id !== "string" || !input.agent_id)
      missingFields.push("agent_id");
    if (typeof input.principal_id !== "string" || !input.principal_id)
      missingFields.push("principal_id");
    if (!input.scope || typeof input.scope !== "object")
      missingFields.push("scope");
    if (!input.limits || typeof input.limits !== "object")
      missingFields.push("limits");
    if (!input.validity || typeof input.validity !== "object")
      missingFields.push("validity");
    if (typeof input.confirmation_threshold !== "number")
      missingFields.push("confirmation_threshold");

    if (missingFields.length > 0) {
      return NextResponse.json(
        { error: `Missing required fields: ${missingFields.join(", ")}` },
        { status: 400 },
      );
    }

    const scope = input.scope as Record<string, unknown>;
    const limits = input.limits as Record<string, unknown>;
    const validity = input.validity as Record<string, unknown>;

    if (!Array.isArray(scope.merchant_allowlist))
      missingFields.push("scope.merchant_allowlist");
    if (!Array.isArray(scope.category_allowlist))
      missingFields.push("scope.category_allowlist");
    if (typeof limits.max_per_txn !== "number") missingFields.push("limits.max_per_txn");
    if (typeof limits.daily_cap !== "number") missingFields.push("limits.daily_cap");
    if (typeof validity.not_before !== "string") missingFields.push("validity.not_before");
    if (typeof validity.not_after !== "string") missingFields.push("validity.not_after");

    if (missingFields.length > 0) {
      return NextResponse.json(
        { error: `Missing required fields: ${missingFields.join(", ")}` },
        { status: 400 },
      );
    }

    const mandateInput: MandateInput = {
      agent_id: String(input.agent_id),
      principal_id: String(input.principal_id),
      scope: {
        merchant_allowlist: scope.merchant_allowlist as string[],
        category_allowlist: scope.category_allowlist as string[],
      },
      limits: {
        max_per_txn: Number(limits.max_per_txn),
        daily_cap: Number(limits.daily_cap),
        currency: typeof limits.currency === "string" ? limits.currency : "INR",
      },
      validity: {
        not_before: String(validity.not_before),
        not_after: String(validity.not_after),
      },
      confirmation_threshold: Number(input.confirmation_threshold),
    };

    const privateKey = process.env.MANDATE_SIGNING_PRIVATE_KEY;
    if (!privateKey) {
      return NextResponse.json(
        { error: "Mandate signing key is not configured on the server" },
        { status: 500 },
      );
    }

    // Sign the mandate — uses the unchanged issueMandate() from Phase 1
    const mandate = issueMandate(mandateInput, privateKey);

    const db = createServerSupabaseClient();
    if (!db) {
      return NextResponse.json(
        { error: "Database client is not configured" },
        { status: 500 },
      );
    }

    // Insert using the exact MandateRow shape the simulator uses
    const row: MandateRow = {
      mandate_id: mandate.mandate_id,
      agent_id: mandate.agent_id,
      principal_id: mandate.principal_id,
      scope_merchant_allowlist: mandate.scope.merchant_allowlist,
      scope_category_allowlist: mandate.scope.category_allowlist,
      limits_max_per_txn: mandate.limits.max_per_txn,
      limits_daily_cap: mandate.limits.daily_cap,
      limits_currency: mandate.limits.currency,
      validity_not_before: mandate.validity.not_before,
      validity_not_after: mandate.validity.not_after,
      confirmation_threshold: mandate.confirmation_threshold,
      nonce: mandate.nonce,
      status: mandate.status,
      signature: mandate.signature,
      daily_spent: 0,
    };

    const { error: insertError } = await db.from("mandates").insert(row);

    if (insertError) {
      return NextResponse.json(
        { error: `Failed to store mandate: ${insertError.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      mandate_id: mandate.mandate_id,
      agent_id: mandate.agent_id,
      validity: mandate.validity,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "An unexpected error occurred during mandate issuance",
      },
      { status: 500 },
    );
  }
}
