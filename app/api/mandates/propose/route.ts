import { NextRequest, NextResponse } from "next/server";
import { proposeMandateFromText } from "@/lib/mandate/propose";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (!text) {
      return NextResponse.json(
        { error: "text is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    const result = await proposeMandateFromText(text);
    // Both safe proposals and refusals return HTTP 200 —
    // the outcome is content-level, not protocol-level.
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "An unexpected error occurred";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
