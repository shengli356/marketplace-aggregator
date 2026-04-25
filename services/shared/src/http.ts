/**
 * HTTP helpers
 *
 * Small utilities shared by Lambda handlers.
 *
 * Note: These helpers include permissive CORS headers for the prototype UI.
 * In production, CORS should be locked down to known origins and headers.
 */

export function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type,x-mock-signature,x-mock-timestamp,x-internal-signature,x-internal-timestamp',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

/**
 * Parse JSON from the API Gateway event body.
 * Supports both plain text and base64-encoded payloads.
 */
export function parseJsonBody<T = Record<string, unknown>>(body?: string, isBase64Encoded?: boolean): T {
  if (!body) return {} as T;
  const raw = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  return JSON.parse(raw) as T;
}

/**
 * Return the unparsed request body string.
 * Used for signature verification where the exact body bytes matter.
 */
export function rawBody(body?: string, isBase64Encoded?: boolean): string {
  if (!body) return '';
  return isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
}
