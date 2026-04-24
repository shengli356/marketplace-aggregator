import crypto from 'node:crypto';

export function hmacSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

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

export function signedHeaders(secret: string, body: string, prefix: 'x-mock' | 'x-internal') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    [`${prefix}-timestamp`]: timestamp,
    [`${prefix}-signature`]: hmacSignature(secret, timestamp, body)
  };
}
