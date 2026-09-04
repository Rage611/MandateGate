# Problem Brief: Authorization Gateways for Autonomous AI Agents

## 1. Executive Summary

Autonomous AI agents (shopping assistants, supply procurement bots, travel concierges) are rapidly transitioning from conversational interfaces to economic actors capable of executing real monetary transactions. 

Existing payment authorization infrastructure (cards, 2FA/3DS, UPI AutoPay) was architected entirely around human presence at the terminal or recurring fixed-subscription billing. When an autonomous software agent initiates an ad-hoc transaction, there is currently **no standardized mechanism** to enforce fine-grained, cryptographically verifiable financial boundaries without exposing naked credentials or requiring manual human intervention on every penny spent.

**MandateGate** bridges this gap as a merchant-side cryptographic policy gate and settlement middleware sitting directly between AI agents and payment gateways like Razorpay.

---

## 2. The Core Problem & Threat Model

### The Dual Failure Mode of Modern Agentic Spending
When delegating spending authority to an autonomous LLM-driven agent, human principals and merchants currently face two unworkable extremes:

1. **Unbounded Over-Privilege**: Handing an agent a static API key, corporate virtual card, or pre-authorized billing token. If the agent hallucinates, enters an infinite retry loop, falls victim to prompt injection, or suffers model drift, it can drain accounts in seconds.
2. **Paralyzing Friction**: Requiring 2FA / OTP verification for every sub-transaction ($2 for milk, $5 for API credits). This completely defeats the premise of autonomous delegation.

### Specific Threat Vectors Addressed
* **Prompt Injection & Scope Creep**: An agent authorized to purchase grocery supplies is manipulated via untrusted third-party web content into buying electronics or luxury goods.
* **Algorithmic Runaway (Looping)**: An agent caught in a recursive tool-calling loop executes hundreds of identical payments before being killed.
* **Replay & Tampering**: An untrusted actor captures a legitimate transaction payload and modifies the amount or merchant recipient in flight.
* **Gateway/Network Partition Inconsistencies**: A gateway accepts an order but fails settlement; without compensating reconciliation, the agent's internal budget becomes permanently desynchronized from the actual bank balance.

---

## 3. Regulatory & Architectural Context

### NPCI UAP & Account Payee (AP2) Evolution
India's digital payment ecosystem (led by RBI and NPCI) has strict mandates regarding Additional Factor of Authentication (AFA) and e-mandates. While UPI AutoPay addresses pre-authorized recurring debits for fixed utilities, it does not support:
* Dynamic per-transaction merchant/category allowlists.
* Ephemeral time-to-live validity windows measured in hours.
* Hierarchical escalation thresholds (e.g., auto-approve transactions under ₹500, but hold transactions between ₹500 and ₹1,500 for a human single-click sign-off).

MandateGate implements this granular delegation layer at the merchant/agent perimeter, ensuring compliance with strict spending guardrails before any Razorpay order is ever generated.

---

## 4. Design Tenets & Constraints

1. **Deterministic Financial Verification**:
   No probabilistic LLM is ever permitted to decide if a transaction passes financial authorization. Cryptographic verification (Ed25519), time windows, scope allowlists, and cap accounting are strictly deterministic code.
2. **Race-Safe Concurrency**:
   Cap consumption cannot be handled with application-level `SELECT ... UPDATE` logic. It is enforced in Postgres using atomic single-statement updates (`attempt_spend`) with row-level locking.
3. **Append-Only Auditing**:
   Every authorization decision—approval, rejection, hold, or settlement compensation—is written to an audit log where `UPDATE` and `DELETE` privileges are explicitly revoked at the SQL level.
4. **Compensating Settlements**:
   Gate authorization acts as a reservation of budget. If the upstream Razorpay settlement fails, funds are automatically and atomically returned to the daily spend capacity (`release_spend`).

---

## 5. Non-Goals

* **Not a Wallet/Custodial Service**: MandateGate does not hold customer fiat balances; it enforces policy and dispatches settlement orders directly to Razorpay.
* **Not an End-to-End Banking Switch**: It operates as an authorization gatekeeper on top of standard payment infrastructure, preparing merchant systems for the arrival of autonomous AI agents.

