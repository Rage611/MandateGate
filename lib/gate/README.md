# lib/gate

**Phase 2** — Verification and policy engine.

This module provides the authorization decision engine that evaluates incoming payment requests against cryptographic mandates:

- `types.ts` — Type definitions for `PaymentRequest`, `GateDecision`, `GateOutcome`, and `REASON_CODES` (8 enumerated failure/hold codes).
- `evaluate.ts` — `evaluateGateDecision(request, client?)` running fast-fail sequential checks:
  1. Fetch mandate from database
  2. Verify Ed25519 signature
  3. Validate mandate lifecycle status (`active`)
  4. Temporal validity window checks (`not_before` / `not_after`)
  5. Idempotency check (`consumed_requests`)
  6. Merchant and category scope allowlist verification
  7. Human confirmation threshold check (`pending_confirmation` / `NEEDS_CONFIRMATION`)
  8. Atomic daily spending cap increment (`attempt_spend` RPC)
  9. Record approval in `consumed_requests` and append to `audit_log`
