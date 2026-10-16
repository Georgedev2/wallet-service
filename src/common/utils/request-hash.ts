import { createHash } from 'crypto';

/**
 * SHA-256 of the request's meaningful fields, stored with the idempotency key so a
 * reused key with a different payload can be detected. Pass money as a string
 * (JSON can't serialise bigint) and use null, not undefined, for absent fields.
 */
export function requestHash(parts: (string | null)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
