/**
 * lib/mandate/__tests__/propose.test.ts — Phase 7
 *
 * TEST STRATEGY:
 *   This file contains ONLY the module isolation test.
 *   It has no OpenAI API calls, costs nothing, and is deterministic.
 *
 *   Behavioral tests (safe proposal, refusal, no-duration default,
 *   conservative scope, refusal consistency loop) are in:
 *     scripts/test-propose-live.ts
 *   Run manually: node .\node_modules\tsx\dist\cli.mjs scripts\test-propose-live.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

describe("proposeMandateFromText — module isolation", () => {
  it("propose.ts has zero imports from sign, supabase, gate, or razorpay", () => {
    const filePath = resolve(process.cwd(), "lib/mandate/propose.ts");
    const source = readFileSync(filePath, "utf8");

    // Extract all import lines
    const importLines = source
      .split("\n")
      .filter((l) => l.trimStart().startsWith("import "));

    const forbidden = [
      // Signing — would allow LLM to directly issue mandates
      "./sign",
      "lib/mandate/sign",
      "@/lib/mandate/sign",
      // Database — would allow LLM to read/write mandate records
      "supabase",
      "@/lib/supabase",
      "../supabase",
      // Gate engine — would allow LLM to bypass policy checks
      "lib/gate",
      "@/lib/gate",
      "../gate",
      // Razorpay — would allow LLM to trigger real payments
      "razorpay",
      "@/lib/razorpay",
      "../razorpay",
    ];

    for (const line of importLines) {
      for (const banned of forbidden) {
        expect(
          line,
          `propose.ts must not import from "${banned}" — found: ${line.trim()}`,
        ).not.toContain(banned);
      }
    }
  });

  it("propose.ts exports only ProposeResult type and proposeMandateFromText function (no database functions)", async () => {
    // Dynamically inspect the module's named exports
    // We do this without calling the function (no API key needed)
    const mod = await import("../propose");
    const exportedKeys = Object.keys(mod);

    // Must export the main function
    expect(exportedKeys).toContain("proposeMandateFromText");
    expect(typeof mod.proposeMandateFromText).toBe("function");

    // Must NOT export anything that sounds like it touches the DB or signing
    const dangerousExports = exportedKeys.filter(
      (k) =>
        k.toLowerCase().includes("issue") ||
        k.toLowerCase().includes("sign") ||
        k.toLowerCase().includes("insert") ||
        k.toLowerCase().includes("supabase") ||
        k.toLowerCase().includes("database"),
    );

    expect(
      dangerousExports,
      `propose.ts must not export any DB/signing functions; found: ${dangerousExports.join(", ")}`,
    ).toHaveLength(0);
  });

  it("proposeMandateFromText returns safe:false immediately for empty input (no API call)", async () => {
    const { proposeMandateFromText } = await import("../propose");

    // Empty string is caught before any API call
    const result = await proposeMandateFromText("");
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.reason).toBeTruthy();
    }
  });

  it("proposeMandateFromText throws (not returns safe:false) when OPENAI_API_KEY is missing", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const { proposeMandateFromText } = await import("../propose");

    await expect(
      proposeMandateFromText("let the agent spend Rs 500 on groceries today"),
    ).rejects.toThrow("OPENAI_API_KEY");

    // Restore
    if (originalKey !== undefined) {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });
});
