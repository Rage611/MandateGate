import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = createServerSupabaseClient();

  if (!supabase) {
    return NextResponse.json({ ok: true, db: "not configured" });
  }

  try {
    const { error } = await supabase.rpc("pg_catalog.version");

    // If rpc isn't available, fall back to a raw SQL query via the REST API.
    // We use `.from()` on a known Postgres built-in view as a simple ping.
    if (error) {
      // Fallback: just try to reach Supabase at all.
      const { error: pingError } = await supabase
        .from("_health_check_nonexistent_table_")
        .select("*")
        .limit(1);

      // PGRST116 = table not found — this means the DB connection itself works.
      if (pingError && pingError.code !== "PGRST116") {
        console.error("[health] Supabase ping error:", pingError);
        return NextResponse.json(
          { ok: false, db: "error", detail: pingError.message },
          { status: 503 },
        );
      }
    }

    return NextResponse.json({ ok: true, db: "connected" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[health] Unexpected error:", message);
    return NextResponse.json(
      { ok: false, db: "error", detail: message },
      { status: 503 },
    );
  }
}
