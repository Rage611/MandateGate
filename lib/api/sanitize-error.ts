/**
 * lib/api/sanitize-error.ts
 *
 * Sanitize unknown errors before returning them to API clients.
 *
 * WHY THIS EXISTS:
 *   Supabase DB errors can contain connection strings, table names, column
 *   names, and internal query structure - information that aids attackers.
 *   Raw JS errors can contain stack traces or internal state.
 *
 *   This function always logs the full error server-side (for ops/debugging)
 *   and returns a safe, generic message to the caller.
 *
 *   Specific policy decisions are surfaced through GateDecision.reason_code
 *   and EXPLANATIONS map - never through raw error strings.
 *
 * USAGE:
 *   In any catch block of a public API route:
 *     return NextResponse.json(
 *       { error: sanitizeError(err, 'gate/pay') },
 *       { status: 500 },
 *     );
 */

export function sanitizeError(err: unknown, context: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Always log full details server-side so ops can investigate.
  console.error("[" + context + "] Internal error:", raw);
  // Return a safe, retry-friendly message to the client.
  // Do NOT include the raw message - it may contain DB internals.
  return "An internal error occurred. The request was not processed. Please retry.";
}
