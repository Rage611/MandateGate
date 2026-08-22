#!/usr/bin/env tsx
/**
 * Key Generation Script — run once, copy output to .env.local
 *
 * Usage:
 *   npx tsx scripts/generate-keys.ts
 *
 * Output:
 *   MANDATE_SIGNING_PRIVATE_KEY=<base64>
 *   MANDATE_SIGNING_PUBLIC_KEY=<base64>
 *
 * IMPORTANT:
 *   - This script prints to stdout only. It never writes to any file.
 *   - Copy the output manually into .env.local.
 *   - Never commit the private key. Never log it in production.
 *   - Generate a new keypair for each environment (dev, staging, prod).
 *   - The private key must be kept secret; the public key can be shared.
 */

import { generateMandateKeyPair } from "../lib/mandate/keys";

const { publicKey, privateKey } = generateMandateKeyPair();

console.log("# Paste the following into your .env.local file:");
console.log("#");
console.log("# WARNING: Keep MANDATE_SIGNING_PRIVATE_KEY secret.");
console.log("# Never commit it, never log it, never expose it to the browser.");
console.log("");
console.log(`MANDATE_SIGNING_PRIVATE_KEY=${privateKey}`);
console.log(`MANDATE_SIGNING_PUBLIC_KEY=${publicKey}`);
