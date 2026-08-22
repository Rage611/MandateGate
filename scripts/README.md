# scripts

One-off utility scripts (not part of the production build).

Planned scripts:

- `simulate-agent.ts` — Sends a synthetic mandate-gated payment request to the local API (Phase 3)
- `generate-keys.ts` — Generates Ed25519 signing keypair and prints base64-encoded values for `.env.local` (Phase 1)

Run scripts directly with `ts-node` or `tsx`:

```bash
npx tsx scripts/simulate-agent.ts
```

_Nothing here yet — scripts added alongside their respective phases._
