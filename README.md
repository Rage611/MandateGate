# MandateGate

> See [/docs/problem-brief.md](./docs/problem-brief.md) for the full project description.

MandateGate is a merchant-side authorization gate for AI-agent-initiated payments.
It lets merchants define structured, cryptographically-signed mandates that control
what an AI agent is permitted to purchase on their behalf — scope, amount limits,
expiry, and per-transaction policy — and enforces those constraints before any
Razorpay payment is created.

---

## Setup

```bash
# 1. Clone
git clone <your-repo-url>

# 2. Install dependencies
npm install

# 3. Environment Variables
cp .env.local.example .env.local
# Edit .env.local with:
# - Supabase keys (URL, Anon, Service Role)
# - Razorpay keys (Key ID, Secret, Webhook Secret)
# - OpenAI API Key (for NLP mandate authoring)

# 4. Database Setup (Supabase)
# Push migrations to your Supabase project in order:
supabase link --project-ref your-project-ref
supabase db push

# 5. Generate Mandate Keys
# Generate the Ed25519 signing keypair and add them to .env.local
npm run generate-keys

# 6. Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

> **Note on Webhooks:** For Razorpay test mode settlement to work, you must forward webhook events to your local dev server via ngrok or the Razorpay CLI, mapped to `http://localhost:3000/api/razorpay/webhook`.

### Health check

Verify the Supabase connection is live:

```bash
curl http://localhost:3000/api/health
# → { "ok": true, "db": "connected" }
```

---

## Available Scripts

| Command                | Description                      |
| ---------------------- | -------------------------------- |
| `npm run dev`          | Start development server         |
| `npm run build`        | Production build                 |
| `npm run start`        | Start production server          |
| `npm run lint`         | Run ESLint                       |
| `npm run typecheck`    | TypeScript type-check (no emit)  |
| `npm run test`         | Run Vitest test suite            |
| `npm run simulate`     | Run the Agent Simulator E2E test |

---

## Project Status

| Phase       | Status         | Description                                |
| ----------- | -------------- | ------------------------------------------ |
| **Phase 0** | ✅ Complete    | Project scaffold, Supabase connection, CI  |
| **Phase 1** | ✅ Complete    | Mandate schema, Ed25519 signing, DB tables |
| **Phase 2** | ✅ Complete    | Gate verification + policy engine API      |
| **Phase 3** | ✅ Complete    | Razorpay integration, payment flow         |
| **Phase 4** | ✅ Complete    | Agent simulator, load testing, hardening   |
| **Phase 5** | ✅ Complete    | Ops dashboard (Read-only + Confirm action) |
| **Phase 6** | ✅ Complete    | UI/UX visual polish                        |
| **Phase 7** | ✅ Complete    | Natural language mandate authoring (LLM)   |

---

## Stack

- **Next.js 16** (App Router, TypeScript strict mode)
- **Supabase** (PostgreSQL + Auth)
- **Tailwind CSS v4**
- **Razorpay** (test mode, Phase 3+)

## Folder Structure

```
app/
  api/            Route handlers
lib/
  supabase/       Supabase client factories
  mandate/        Mandate schema + signing (Phase 1)
  gate/           Verification/policy engine (Phase 2)
  razorpay/       Razorpay client wrapper (Phase 3)
db/
  migrations/     SQL migration files
scripts/          One-off utility scripts
docs/             Architecture docs, problem brief, postmortems
```
