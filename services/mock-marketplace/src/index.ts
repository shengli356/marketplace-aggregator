/**
 * Mock Marketplace Lambda
 *
 * This Lambda represents the external marketplace boundary (eBay-like).
 * It exists to demonstrate the realities of third-party integrations:
 * - asynchronous workflows
 * - rate limiting and transient failures
 * - idempotency requirements
 *
 * Endpoints:
 * - `POST /mock-marketplace/publish`: signed internal call from our publish worker
 * - `POST /mock-marketplace/events`: demo-only manual injector for comment/sale events
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { jsonResponse, parseJsonBody, rawBody } from '../../shared/src/http';
import { getSigningSecret } from '../../shared/src/secrets';
import { verifySignedBody } from '../../shared/src/signing';
import type { MarketplaceEventType } from '../../shared/src/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const MOCK_EVENT_QUEUE_URL = process.env.MOCK_EVENT_QUEUE_URL!;

/**
 * Synthetic failure rate used to simulate 429s and 5xx errors.
 * Default is ~15% to prove retry/idempotency behavior.
 */
const FAILURE_RATE = Number(process.env.SIMULATED_FAILURE_RATE ?? '0.15');
const TENANT_ID = 'demo';

type PublishRequest = {
  tenantId: string;
  listingId: string;
  idempotencyKey: string;
  title: string;
  description: string;
  priceCents: number;
};

type ManualEventRequest = {
  eventType: MarketplaceEventType;
  listingId: string;
  marketplaceListingId?: string;
  payload?: Record<string, unknown>;
};

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    if (method === 'OPTIONS') return jsonResponse(204, {});
    if (path === '/mock-marketplace/publish' && method === 'POST') return await publish(event);
    if (path === '/mock-marketplace/events' && method === 'POST') return await triggerManualEvent(event);

    return jsonResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Mock marketplace error', error);
    return jsonResponse(500, { error: 'mock marketplace internal error' });
  }
}

/**
 * Accept a publish request from our system.
 *
 * Security:
 * - requires an internal HMAC signature on the request
 *
 * Correctness:
 * - enforces idempotency by recording `MOCK_PUBLISH#<idempotencyKey>`
 * - intentionally returns 429/503 sometimes to trigger retries
 *
 * Side effects:
 * - on success, enqueues a `listing_published` event onto the mock event queue
 */
async function publish(event: APIGatewayProxyEventV2) {
  const raw = rawBody(event.body, event.isBase64Encoded);
  const secret = await getSigningSecret();
  const timestamp = header(event, 'x-internal-timestamp');
  const signature = header(event, 'x-internal-signature');

  if (!verifySignedBody({ secret, timestamp, signature, body: raw })) return jsonResponse(401, { error: 'invalid internal signature' });

  const body = JSON.parse(raw) as PublishRequest;
  if (body.tenantId !== TENANT_ID || !body.listingId || !body.idempotencyKey) return jsonResponse(400, { error: 'invalid publish request' });

  const existing = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `MOCK_PUBLISH#${body.idempotencyKey}`, sk: 'META' }
  }));

  if (existing.Item) {
    return jsonResponse(202, { accepted: true, duplicate: true, marketplaceListingId: existing.Item.marketplaceListingId });
  }

  const roll = Math.random();
  if (roll < FAILURE_RATE * 0.66) return jsonResponse(429, { error: 'synthetic rate limit from mock marketplace' });
  if (roll < FAILURE_RATE) return jsonResponse(503, { error: 'synthetic transient marketplace failure' });

  const now = new Date().toISOString();
  const marketplaceListingId = `MOCK-${body.listingId.slice(0, 8).toUpperCase()}`;

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `MOCK_PUBLISH#${body.idempotencyKey}`,
        sk: 'META',
        entityType: 'MOCK_PUBLISH',
        tenantId: body.tenantId,
        listingId: body.listingId,
        marketplaceListingId,
        idempotencyKey: body.idempotencyKey,
        acceptedAt: now
      },
      ConditionExpression: 'attribute_not_exists(pk)'
    }));
  } catch (error: any) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
  }

  await enqueueMarketplaceEvent({
    eventType: 'listing_published',
    listingId: body.listingId,
    marketplaceListingId,
    payload: { title: body.title, priceCents: body.priceCents },
    delaySeconds: 3
  });

  return jsonResponse(202, { accepted: true, marketplaceListingId });
}

/**
 * Demo-only endpoint to trigger marketplace events (comment/sale) without waiting.
 * In a real integration, the marketplace would POST webhooks to our receiver.
 */
async function triggerManualEvent(event: APIGatewayProxyEventV2) {
  const body = parseJsonBody<ManualEventRequest>(event.body, event.isBase64Encoded);
  if (!body.listingId) return jsonResponse(400, { error: 'listingId is required' });
  if (!['new_comment', 'item_sold'].includes(body.eventType)) return jsonResponse(400, { error: 'eventType must be new_comment or item_sold' });

  const marketplaceListingId = body.marketplaceListingId || `MOCK-${body.listingId.slice(0, 8).toUpperCase()}`;
  await enqueueMarketplaceEvent({
    eventType: body.eventType,
    listingId: body.listingId,
    marketplaceListingId,
    payload: body.payload ?? {},
    delaySeconds: 0
  });

  return jsonResponse(202, { accepted: true });
}

/**
 * Enqueue an event onto the mock event queue.
 * A separate SQS-triggered Lambda (mock-event-emitter) delivers the signed webhook.
 */
async function enqueueMarketplaceEvent(params: {
  eventType: MarketplaceEventType;
  listingId: string;
  marketplaceListingId: string;
  payload: Record<string, unknown>;
  delaySeconds: number;
}) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: MOCK_EVENT_QUEUE_URL,
    DelaySeconds: params.delaySeconds,
    MessageBody: JSON.stringify({
      eventType: params.eventType,
      tenantId: TENANT_ID,
      listingId: params.listingId,
      marketplace: 'mock-ebay',
      marketplaceListingId: params.marketplaceListingId,
      occurredAt: new Date().toISOString(),
      payload: params.payload
    })
  }));
}

/**
 * Case-insensitive header lookup for API Gateway HTTP API.
 */
function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const lower = name.toLowerCase();
  return event.headers?.[lower] ?? event.headers?.[name];
}
