/**
 * lib/mandate/propose.ts — Phase 7
 *
 * Proposes a structured MandateInput from a plain-English description.
 *
 * ISOLATION CONTRACT:
 *   This file MUST NOT import from:
 *     - lib/mandate/sign.ts   (issueMandate)
 *     - lib/supabase/*        (any DB client)
 *     - lib/gate/*            (policy engine)
 *     - lib/razorpay/*        (payment client)
 *
 *   It is a pure function: text in, proposal or refusal out.
 *   The test suite verifies this at the import level.
 *
 * SAFETY CONTRACT:
 *   The LLM may propose a mandate. It may not issue one.
 *   Human approval via /api/mandates/issue is mandatory before any signing.
 */

import OpenAI from "openai";
import type { MandateInput } from "./types";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ProposeResult =
  | { safe: true; proposal: MandateInput }
  | { safe: false; reason: string };

// ---------------------------------------------------------------------------
// OpenAI tool definitions
// ---------------------------------------------------------------------------

const PROPOSE_TOOL = {
  type: "function" as const,
  function: {
    name: "propose_mandate",
    description:
      "Propose a structured, bounded mandate from the user description. Only call this when the request is safe and specific enough to produce a responsible proposal.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Short identifier for the AI agent being authorized (e.g. 'shopping-agent-v1'). Infer from context or use a sensible default.",
        },
        principal_id: {
          type: "string",
          description: "Identifier for the human principal authorizing this mandate (e.g. 'principal-human-1'). Use a sensible default if not specified.",
        },
        scope_merchant_allowlist: {
          type: "array",
          items: { type: "string" },
          description:
            "Specific Razorpay merchant IDs or merchant name slugs. Use empty array [] if no specific merchant is named (means any merchant within allowed categories). If scope is truly unrestricted, REFUSE instead.",
        },
        scope_category_allowlist: {
          type: "array",
          items: { type: "string" },
          description:
            "Allowed spending category codes. Be conservative: include ONLY categories explicitly mentioned or unambiguously implied. Do NOT include adjacent categories not mentioned. Examples: GROCERY, TRAVEL, SAAS, UTILITIES, FOOD, TRANSPORT, HOTEL, ENTERTAINMENT.",
        },
        limits_max_per_txn: {
          type: "number",
          description:
            "Maximum per single transaction in PAISE (1 INR = 100 paise). E.g. Rs 500 = 50000 paise.",
        },
        limits_daily_cap: {
          type: "number",
          description:
            "Total daily spending cap in PAISE. Must be a specific, bounded number. Never use 0 or a value implying no cap.",
        },
        limits_currency: {
          type: "string",
          enum: ["INR"],
          description: "Currency code. Always INR.",
        },
        validity_not_before: {
          type: "string",
          description: "ISO 8601 datetime when mandate becomes valid. Use current time unless user specifies a future start.",
        },
        validity_not_after: {
          type: "string",
          description:
            "ISO 8601 datetime when mandate expires. DEFAULT to 48 hours from now if user does not specify. Use user stated duration if given. HARD LIMIT: never exceed 30 days.",
        },
        confirmation_threshold: {
          type: "number",
          description:
            "Amount in PAISE above which human must confirm each transaction. Typically 70-80% of per-transaction limit.",
        },
      },
      required: [
        "agent_id",
        "principal_id",
        "scope_category_allowlist",
        "scope_merchant_allowlist",
        "limits_max_per_txn",
        "limits_daily_cap",
        "limits_currency",
        "validity_not_before",
        "validity_not_after",
        "confirmation_threshold",
      ],
      additionalProperties: false,
    },
  },
} as const;

const REFUSE_TOOL = {
  type: "function" as const,
  function: {
    name: "refuse_mandate",
    description:
      "Refuse to propose a mandate when the request is unsafe, unbounded, or too ambiguous to produce a responsible authorization.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Clear, plain-English explanation of why this mandate cannot be safely proposed.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const now = new Date();
  const nowIso = now.toISOString();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  return `You are a mandate authorization assistant for MandateGate, a high-assurance payment control system.

A MANDATE authorizes an AI agent to spend real money on behalf of a human within strict bounds. You propose a structured mandate from plain English. You are NOT issuing it — a human reviews and approves your proposal first.

CURRENT TIME: ${nowIso}

ALL MONETARY VALUES ARE IN PAISE (1 INR = 100 paise). Rs 500 = 50000 paise.

WHEN TO CALL propose_mandate:
- The request has a SPECIFIC, BOUNDED monetary cap
- The scope has identifiable merchants or categories (not "anything")
- The validity has a reasonable window (default 48h if not stated)

WHEN TO CALL refuse_mandate — YOU MUST REFUSE if:
1. No cap or "unlimited" / "whatever needed" / "no limit" — REFUSE
2. Scope is "any merchant" / "anywhere" / "anything" / effectively unrestricted — REFUSE
3. Validity DURATION is strictly more than 30 calendar days (e.g. "valid for 3 months", "valid for 60 days", "valid forever") — REFUSE. Durations of 30 days or less (e.g. "7 days", "2 weeks", "1 month") are ALLOWED.
4. Request so vague that a responsible cap or category cannot be inferred — REFUSE

CONSERVATIVE INTERPRETATION (when ambiguous but not unsafe):
- "groceries" → ["GROCERY"] NOT ["GROCERY", "FOOD", "SUPERMARKET"]
- "travel stuff" → ["TRAVEL"] NOT ["TRAVEL", "HOTEL", "TRANSPORT", "ENTERTAINMENT", "FOOD"]
- "software tools" → ["SAAS"] NOT ["SAAS", "UTILITIES", "ENTERTAINMENT"]
- Default validity: 48 hours from now (${in48h}) when not specified — NEVER open-ended
- Default per-txn limit: daily_cap / 2 when not specified

Call exactly one tool: propose_mandate or refuse_mandate. No free text.`;
}

// ---------------------------------------------------------------------------
// Exported function
// ---------------------------------------------------------------------------

/**
 * Proposes a structured MandateInput from a plain-English user description.
 *
 * Uses OpenAI tool calling to guarantee schema conformance.
 * Returns a safe proposal for human review, or a refusal with reason.
 *
 * ISOLATION: No access to issueMandate(), Supabase, gate engine, or Razorpay.
 */
export async function proposeMandateFromText(
  userInput: string,
): Promise<ProposeResult> {
  if (!userInput || !userInput.trim()) {
    return { safe: false, reason: "No mandate description was provided." };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Cannot call LLM for mandate proposal.",
    );
  }

  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: userInput.trim() },
    ],
    tools: [PROPOSE_TOOL, REFUSE_TOOL],
    tool_choice: "required",
    temperature: 0.1,
  });

  const message = response.choices[0]?.message;
  const rawToolCall = message?.tool_calls?.[0];

  if (!rawToolCall) {
    return {
      safe: false,
      reason: "The proposal system failed to produce a structured response. Please rephrase your request.",
    };
  }

  // Narrow to function-type tool call (the only type we use)
  if (rawToolCall.type !== "function") {
    return {
      safe: false,
      reason: "The proposal system returned an unexpected tool type. Please try again.",
    };
  }

  const toolCall = rawToolCall;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
  } catch {
    return {
      safe: false,
      reason: "The proposal system returned an unparseable response. Please try again.",
    };
  }

  if (toolCall.function.name === "refuse_mandate") {
    return {
      safe: false,
      reason: String(args.reason ?? "The request cannot be safely authorized."),
    };
  }

  if (toolCall.function.name === "propose_mandate") {
    const proposal: MandateInput = {
      agent_id: String(args.agent_id ?? "ai-agent-v1"),
      principal_id: String(args.principal_id ?? "principal-human-1"),
      scope: {
        merchant_allowlist: Array.isArray(args.scope_merchant_allowlist)
          ? (args.scope_merchant_allowlist as string[])
          : [],
        category_allowlist: Array.isArray(args.scope_category_allowlist)
          ? (args.scope_category_allowlist as string[])
          : [],
      },
      limits: {
        max_per_txn: Number(args.limits_max_per_txn),
        daily_cap: Number(args.limits_daily_cap),
        currency: "INR",
      },
      validity: {
        not_before: String(args.validity_not_before),
        not_after: String(args.validity_not_after),
      },
      confirmation_threshold: Number(args.confirmation_threshold),
    };

    return { safe: true, proposal };
  }

  return {
    safe: false,
    reason: "Unrecognized proposal response. Please try again.",
  };
}
