export function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,x-mock-signature,x-mock-timestamp,x-internal-signature,x-internal-timestamp',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

export function parseJsonBody<T = Record<string, unknown>>(body?: string, isBase64Encoded?: boolean): T {
  if (!body) return {} as T;
  const raw = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  return JSON.parse(raw) as T;
}

export function rawBody(body?: string, isBase64Encoded?: boolean): string {
  if (!body) return '';
  return isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
}
