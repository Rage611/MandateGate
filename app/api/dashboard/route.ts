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

    // 2. Fetch all mandates
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

    // 3. Fetch consumed requests to determine which pending confirmations are still unresolved
    const { data: consumed } = await db
      .from("consumed_requests")
      .select("mandate_id, request_id");

    const consumedSet = new Set(
      (consumed || []).map((c) => `${c.mandate_id}:${c.request_id}`),
    );

    // Fetch pending confirmation audit rows
    const { data: pendingAudits } = await db
      .from("audit_log")
      .select("*")
      .eq("decision", "pending_confirmation")
      .order("id", { ascending: false });

    // Deduplicate and filter out already consumed/settled requests
    const pendingMap = new Map();
    for (const audit of pendingAudits || []) {
      const key = `${audit.mandate_id}:${audit.request_id}`;
      if (!consumedSet.has(key) && !pendingMap.has(key)) {
        pendingMap.set(key, audit);
      }
    }
    const pendingConfirmations = Array.from(pendingMap.values());

    // 4. Fetch recent payment attempts for settlement context
    const { data: paymentAttempts } = await db
      .from("payment_attempts")
      .select("*")
      .order("id", { ascending: false })
      .limit(30);

    return NextResponse.json({
      auditLogs: auditLogs || [],
      mandates: mandates || [],
      pendingConfirmations,
      paymentAttempts: paymentAttempts || [],
      timestamp: new Date().toISOString(),
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
