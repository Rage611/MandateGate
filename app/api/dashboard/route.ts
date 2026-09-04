import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = createServerSupabaseClient();
    if (!db) {
      return NextResponse.json(
        { error: "Database client is not configured" },
        { status: 500 },
      );
    }

    // 1. Fetch recent audit logs (newest first, limit 30)
    // Critical — 500 if this fails.
    const { data: auditLogs, error: auditError } = await db
      .from("audit_log")
      .select("*")
      .order("id", { ascending: false })
      .limit(30);

    if (auditError) {
      return NextResponse.json(
        { error: `Failed to fetch audit log: ${auditError.message}` },
        { status: 500 },
      );
    }

    // 2. Fetch all mandates — critical, 500 if this fails.
    const { data: mandates, error: mandatesError } = await db
      .from("mandates")
      .select("*")
      .order("created_at", { ascending: false });

    if (mandatesError) {
      return NextResponse.json(
        { error: `Failed to fetch mandates: ${mandatesError.message}` },
        { status: 500 },
      );
    }

    // Warnings array: collects non-critical failures so the UI can show
    // an amber banner instead of silently displaying wrong data.
    const warnings: string[] = [];

    // 3. Fetch consumed requests to determine which pending confirmations
    //    are still unresolved. Non-critical — degrade gracefully.
    const { data: consumed, error: consumedError } = await db
      .from("consumed_requests")
      .select("mandate_id, request_id");

    if (consumedError) {
      console.error("[dashboard] consumed_requests fetch failed:", consumedError.message);
      warnings.push("Pending confirmation status may be incomplete — consumed_requests unavailable.");
    }

    const consumedSet = new Set(
      (consumed || []).map((c) => `${c.mandate_id}:${c.request_id}`),
    );

    // 4. Fetch pending confirmation audit rows. Non-critical.
    const { data: pendingAudits, error: pendingError } = await db
      .from("audit_log")
      .select("*")
      .eq("decision", "pending_confirmation")
      .order("id", { ascending: false });

    if (pendingError) {
      console.error("[dashboard] pendingAudits fetch failed:", pendingError.message);
      warnings.push("Pending confirmations could not be loaded — please refresh.");
    }

    // Deduplicate and filter out already consumed/settled requests.
    const pendingMap = new Map();
    for (const audit of pendingAudits || []) {
      const key = `${audit.mandate_id}:${audit.request_id}`;
      if (!consumedSet.has(key) && !pendingMap.has(key)) {
        pendingMap.set(key, audit);
      }
    }
    const pendingConfirmations = Array.from(pendingMap.values());

    // 5. Fetch recent payment attempts. Non-critical.
    const { data: paymentAttempts, error: attemptsError } = await db
      .from("payment_attempts")
      .select("*")
      .order("id", { ascending: false })
      .limit(30);

    if (attemptsError) {
      console.error("[dashboard] paymentAttempts fetch failed:", attemptsError.message);
      warnings.push("Payment attempt history could not be loaded — please refresh.");
    }

    return NextResponse.json({
      auditLogs: auditLogs || [],
      mandates: mandates || [],
      pendingConfirmations,
      paymentAttempts: paymentAttempts || [],
      timestamp: new Date().toISOString(),
      // Non-empty only when a non-critical query failed. UI shows amber banner.
      warnings,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "An unexpected error occurred fetching dashboard data",
      },
      { status: 500 },
    );
  }
}
