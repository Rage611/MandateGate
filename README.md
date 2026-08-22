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

# 3. Copy and fill in environment variables
cp .env.local.example .env.local
# Edit .env.local with your real Supabase and Razorpay keys

# 4. Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Health check

Verify the Supabase connection is live:

```bash
curl http://localhost:3000/api/health
# → { "ok": true, "db": "connected" }
```

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | TypeScript type-check (no emit) |
| `npm run format` | Auto-format with Prettier |
| `npm run format:check` | Check formatting without writing |

---

## Project Status

| Phase | Status | Description |
|---|---|---|
| **Phase 0** | 🔄 In Progress | Project scaffold, Supabase connection, CI |
| **Phase 1** | ⏳ Planned | Mandate schema, Ed25519 signing, DB tables |
| **Phase 2** | ⏳ Planned | Gate verification + policy engine API |
| **Phase 3** | ⏳ Planned | Razorpay integration, payment flow |
| **Phase 4** | ⏳ Planned | Agent simulator, load testing, hardening |

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
