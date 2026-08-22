import type { UnsignedMandate } from "./types";

/**
 * Recursively-typed JSON value, mirroring the JSON spec.
 * Used to safely cast Mandate fields for canonical serialisation.
 */
type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];
type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * Recursively re-orders all object keys lexicographically (depth-first).
 * Array order is preserved — only object keys are sorted.
 */
function stableSortKeys(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    // Primitive: return as-is.
    return value;
  }
  if (Array.isArray(value)) {
    // Array: recurse into each element without reordering the array itself.
    return value.map(stableSortKeys);
  }
  // Object: sort keys lexicographically and recurse into values.
  return Object.keys(value)
    .sort()
    .reduce<JsonObject>((acc, key) => {
      acc[key] = stableSortKeys(value[key]);
      return acc;
    }, {});
}

/**
 * Produces a deterministic canonical JSON string from an unsigned mandate.
 *
 * WHY CANONICAL ORDERING MATTERS
 * ───────────────────────────────
 * JSON.stringify() serialises object keys in insertion order, which is
 * engine-defined and not guaranteed to be stable across environments or even
 * across two runs of the same code. Two objects with identical data but
 * different key order produce byte-for-byte different strings:
 *
 *   `{"a":1,"b":2}` ≠ `{"b":2,"a":1}`
 *
 * Because a digital signature authenticates the exact byte sequence that was
 * signed, a verifier that serialises keys in a different order than the signer
 * will produce a different string — and verification will fail even for a
 * completely unmodified, valid mandate.
 *
 * Solution: before signing *or* before verifying, both sides run
 * `canonicalize()`. This sorts all object keys recursively so that the same
 * logical mandate always maps to the exact same byte string, regardless of how
 * the object was constructed in memory.
 *
 * The function is deterministic: given the same UnsignedMandate it always
 * produces the same output. The output contains no whitespace beyond what
 * JSON.stringify() emits for values (i.e. none for compact mode).
 */
export function canonicalize(mandate: UnsignedMandate): string {
  // The cast to JsonValue is safe: UnsignedMandate is entirely JSON-serialisable
  // (no Dates, Buffers, undefined, or circular references).
  const sorted = stableSortKeys(mandate as unknown as JsonValue);
  return JSON.stringify(sorted);
}
