/**
 * Signing helpers
 *
 * Provides a small HMAC-based signing scheme used throughout the prototype.
 *
 * Signature format:
 * - `sha256=<hex_digest>` over the string: `${timestamp}.${body}`
 *
 * This is used for two distinct header namespaces:
 * - `x-internal-*`: internal publish calls into the mock marketplace
 * - `x-mock-*`: mock marketplace webhook deliveries into the app API
 */

import crypto from 'node:crypto';

/**
 * Compute a deterministic HMAC signature for a timestamped payload.
 */
export function hmacSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Timing-safe equality check to avoid leaking information via string comparison.
 */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Verify a signed request body.
 *
 * Checks:
 * - timestamp and signature are present
 * - timestamp is within a tolerance window (defaults to 5 minutes)
 * - signature matches the expected HMAC
 */
export function verifySignedBody(params: {
  secret: string;
  timestamp?: string;
  signature?: string;
  body: string;
  toleranceSeconds?: number;
}): boolean {
  const { secret, timestamp, signature, body, toleranceSeconds = 300 } = params;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return false;
  return safeEquals(signature, hmacSignature(secret, timestamp, body));
}

/**
 * Produce a signed header set for a given body.
 * The caller chooses the header prefix namespace.
 */
export function signedHeaders(secret: string, body: string, prefix: 'x-mock' | 'x-internal') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    [`${prefix}-timestamp`]: timestamp,
    [`${prefix}-signature`]: hmacSignature(secret, timestamp, body)
  };
}
