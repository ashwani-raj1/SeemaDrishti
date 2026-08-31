/**
 * Short, sortable, prefixed ids. The prefix makes a raw database row or a log
 * line readable without looking up which table it came from.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomSuffix(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomSuffix()}`;
}

export const nowIso = (): string => new Date().toISOString();
