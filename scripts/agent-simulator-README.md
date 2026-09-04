# Agent Simulator (`npm run simulate`)

This script acts as the protagonist for the MandateGate demo. It plays the role of an autonomous AI shopping agent equipped with a mandate, firing real payment requests against our gate policy engine and simulating Razorpay settlement.

## What it demonstrates

This simulator proves that the core value proposition of MandateGate works end-to-end: **AI agents can be given autonomous spending power that is strictly bounded, tamper-proof, and fully auditable.**

We demonstrate this through 7 distinct scenarios:

### Scenario 1: The Happy Path (Approved & Settled)

**What happens:** The agent attempts a valid, in-scope purchase well within its limits. The gate approves it, an order is created, and the payment settles.
**Why it matters:** Proves the basic mechanics work. The agent can spend money autonomously when it follows the rules.

### Scenario 2: The Hard Limit (Cap Exceeded)

**What happens:** The agent attempts a purchase that would push its total daily spend over the mandate's `daily_cap`.
**Why it matters:** AI agents can hallucinate or go rogue. The hard cap ensures that no matter what the agent tries to do, the financial blast radius is strictly contained. The transaction is instantly rejected.

### Scenario 3: The Walled Garden (Out of Scope)

**What happens:** The agent tries to buy from an electronics merchant, but its mandate only allows grocery and subscription merchants.
**Why it matters:** Proves that we can restrict _where_ and _what_ an agent can buy. An agent authorized to buy your groceries cannot be tricked into buying laptops.

### Scenario 4: The Network Glitch (Idempotency)

**What happens:** The exact same request from Scenario 1 is sent again.
**Why it matters:** Distributed systems retry requests all the time. MandateGate enforces strict idempotency—the duplicate request is rejected and the daily spend is not double-counted.

### Scenario 5: The Time Bomb (Expired Mandate)

**What happens:** The agent tries to use a mandate that expired 1 second ago.
**Why it matters:** Mandates are ephemeral. You can grant an agent a temporary budget (e.g., "valid for the next 24 hours"). Once time is up, the authorization vanishes.

### Scenario 6: The Human in the Loop (Confirmation Threshold)

**What happens:** The agent requests a large payment (e.g., $1,000) that exceeds the `confirmation_threshold` but is under the hard cap. The gate holds the payment in a `pending_confirmation` state. Later, a human (or a simulated approval) confirms it.
**Why it matters:** It provides an escalation path. Routine purchases happen instantly, while high-value purchases automatically page a human for a second pair of eyes, without hard-blocking the agent's workflow immediately.

### Scenario 7: The Bounced Check (Settlement Failure)

**What happens:** The gate approves a payment and reserves the funds, but the actual Razorpay settlement fails. The gate automatically detects the failure and releases the reserved funds back to the mandate.
**Why it matters:** Ensures the agent isn't artificially penalized by network or payment gateway failures. If the money didn't actually move, the agent gets its budget back.

## How to run

1. Ensure `.env.local` contains real test-mode Supabase and Razorpay credentials, as well as the mandate signing key pair.
2. Run `npm run simulate`

The output is formatted for readability and includes explicit pass/fail checks for each scenario.

---

## Real Bug Found by This Simulator (Before It Hit the Demo)

**What the bug was:** Scenario 2 (The Hard Limit) exposed a check-ordering defect in `lib/gate/evaluate.ts`. When a request exceeded **both** the `confirmation_threshold` (soft gate) **and** the `daily_cap` (hard gate), the gate incorrectly returned `pending_confirmation` (`NEEDS_CONFIRMATION`) instead of immediately rejecting with `CAP_EXCEEDED`.

**The concrete failure:** With `daily_cap = 150,000` (₹1,500), `confirmation_threshold = 100,000` (₹1,000), and `30,000` already spent, a request for `140,000` (₹1,400) would push total spend to `170,000 > 150,000`. The gate routed this to `pending_confirmation`, meaning it would have asked a human to approve a payment that `confirmPendingPayment()` was guaranteed to then reject at `attempt_spend()` — the cap check would have failed even with explicit human approval.

**Why check ordering matters:** Hard constraints (daily cap — a financial limit) must always be evaluated before soft constraints (confirmation threshold — a UX escalation prompt). If you check the soft gate first, you can surface a human approval UX for requests that are categorically impossible to honour, which erodes trust in the system and wastes the merchant's time.

**The fix:** A non-atomic cap pre-check was inserted as step (g) in `evaluateGateDecision()`, between the scope check (f) and the confirmation threshold check (now h). This pre-check reads the already-fetched `row.daily_spent` and rejects with `CAP_EXCEEDED` before ever reaching the threshold evaluation. The authoritative, race-safe cap enforcement remains the atomic `attempt_spend()` SQL function at step (i) — the pre-check is a UX optimisation, not a security boundary, and the code comment says so explicitly.

**Caught when:** Running `npm run simulate` in Phase 4, before the demo was recorded. Scenario 2 showed `pending_confirmation` where `CAP_EXCEEDED` was expected.
