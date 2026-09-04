/**
 * lib/razorpay/client.ts — Phase 3
 *
 * Singleton Razorpay client, initialised from env vars.
 *
 * Only test-mode keys are permitted (rzp_test_* prefix). The constructor
 * asserts this so we can never accidentally run with live keys in dev.
 *
 * Usage:
 *   import { getRazorpayClient } from "@/lib/razorpay/client";
 *   const rzp = getRazorpayClient();
 *   const order = await rzp.orders.create(...);
 */

import Razorpay from "razorpay";

// ── Env helpers ───────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `${name} is not set. Add it to .env.local and restart the dev server.`,
    );
  }
  return val;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _client: Razorpay | null = null;

/**
 * Returns the Razorpay singleton.
 *
 * Throws if RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET are missing, or if the
 * key is a live-mode key (live keys would make test payments charge real money).
 */
export function getRazorpayClient(): Razorpay {
  if (_client) return _client;

  const keyId = requireEnv("RAZORPAY_KEY_ID");
  const keySecret = requireEnv("RAZORPAY_KEY_SECRET");

  if (!keyId.startsWith("rzp_test_")) {
    throw new Error(
      `RAZORPAY_KEY_ID must be a test-mode key (starts with rzp_test_). ` +
        `Got: ${keyId.slice(0, 12)}... — refusing to initialise with a live key.`,
    );
  }

  _client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return _client;
}

/**
 * Resets the singleton — for use in tests only.
 * Call before each test that exercises client initialisation.
 */
export function _resetRazorpayClientForTests(): void {
  _client = null;
}
