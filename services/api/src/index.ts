/**
 * App API Lambda
 *
 * This Lambda backs the user-facing API and the webhook receiver.
 *
 * Responsibilities:
 * - `POST /listings`: validate + persist a listing, then enqueue async publish work
 * - `GET /listings`: list all listings and recent activity for the demo tenant
 * - `POST /webhooks/mock-ebay`: verify signed webhook events and write to activity feed
 *
 * Security model:
 * - `/listings` is protected by HTTP Basic Auth (credentials stored in Secrets Manager)
 * - `/webhooks/mock-ebay` is NOT Basic Auth protected; it is secured via HMAC signature
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { jsonResponse, parseJsonBody, rawBody } from '../../shared/src/http';
import { getSigningSecret } from '../../shared/src/secrets';
import { verifySignedBody } from '../../shared/src/signing';
import type { ActivityItem, ListingItem, MarketplaceWebhookEvent, PublishQueueMessage } from '../../shared/src/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

/**
 * Secrets Manager client used to fetch the Basic Auth credential bundle.
 * Cached in memory for warm Lambda invocations.
 */
const secrets = new SecretsManagerClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const PUBLISH_QUEUE_URL = process.env.PUBLISH_QUEUE_URL!;
const BASIC_AUTH_SECRET_ARN = process.env.BASIC_AUTH_SECRET_ARN;
const TENANT_ID = 'demo';

type BasicAuthSecret = { username: string; password: string };
let cachedBasicAuth: BasicAuthSecret | null = null;

/**
 * Load and cache the Basic Auth credentials from Secrets Manager.
 *
 * Secret JSON shape:
 * `{ "username": "demo", "password": "..." }`
 */
async function getBasicAuthSecret(): Promise<BasicAuthSecret> {
  if (cachedBasicAuth) return cachedBasicAuth;
  if (!BASIC_AUTH_SECRET_ARN) throw new Error('BASIC_AUTH_SECRET_ARN is not configured');

  const response = await secrets.send(new GetSecretValueCommand({ SecretId: BASIC_AUTH_SECRET_ARN }));
  if (!response.SecretString) throw new Error('Basic auth secret had no SecretString');

  const parsed = JSON.parse(response.SecretString) as Partial<BasicAuthSecret>;
  const username = String(parsed.username ?? '').trim();
  const password = String(parsed.password ?? '');
  if (!username || !password) throw new Error('Basic auth secret is missing username or password');

  cachedBasicAuth = { username, password };
  return cachedBasicAuth;
}

/**
 * Standard 401 response for Basic Auth.
 * Includes `WWW-Authenticate` so browsers/clients can prompt for credentials.
 */
function unauthorized(message: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 401,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type,x-mock-signature,x-mock-timestamp,x-internal-signature,x-internal-timestamp',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'www-authenticate': 'Basic realm="Marketplace Aggregator", charset="UTF-8"'
    },
    body: JSON.stringify({ error: message })
  };
}

/**
 * Enforce HTTP Basic Auth for user-facing endpoints.
 * Returns a structured API Gateway response on failure; otherwise returns `null`.
 */
async function requireBasicAuth(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2 | null> {
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
  if (!authHeader?.startsWith('Basic ')) return unauthorized('Authentication required');

  const encoded = authHeader.slice('Basic '.length).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return unauthorized('Invalid credentials');
  }

  const colonIndex = decoded.indexOf(':');
  if (colonIndex < 0) return unauthorized('Invalid credentials');

  const username = decoded.slice(0, colonIndex);
  const password = decoded.slice(colonIndex + 1);
  const secret = await getBasicAuthSecret();

  if (username !== secret.username) return unauthorized('Invalid credentials');

  const supplied = Buffer.from(password);
  const expected = Buffer.from(secret.password);
  if (supplied.length !== expected.length) return unauthorized('Invalid credentials');
  if (!crypto.timingSafeEqual(supplied, expected)) return unauthorized('Invalid credentials');

  return null;
}

/**
 * Simple router for API Gateway HTTP API (Lambda proxy).
 *
 * Important: Basic Auth is applied only to `/listings`, not to webhooks.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    const retryMatch = path.match(/^\/listings\/([^/]+)\/retry-publish$/);

    if (
      (path === '/listings' && (method === 'GET' || method === 'POST'))
      || (retryMatch && method === 'POST')
    ) {
      const authError = await requireBasicAuth(event);
      if (authError) return authError;
    }

    if (method === 'OPTIONS') return jsonResponse(204, {});
    if (path === '/listings' && method === 'POST') return await createListing(event);
    if (path === '/listings' && method === 'GET') return await listListings();
    if (retryMatch && method === 'POST') return await retryPublish(retryMatch[1]);
    if (path === '/webhooks/mock-ebay' && method === 'POST') return await receiveMockWebhook(event);

    return jsonResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Unhandled API error', error);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

/**
 * Create a listing and enqueue async publish work.
 *
 * This function writes:
 * - the Listing item (scoped to demo tenant)
 * - an initial Activity feed entry
 */
async function createListing(event: APIGatewayProxyEventV2) {
  const body = parseJsonBody<{ title?: string; description?: string; price?: number | string }>(event.body, event.isBase64Encoded);
  const title = String(body.title ?? '').trim();
  const description = String(body.description ?? '').trim();
  const price = Number(body.price);

  if (title.length < 3 || title.length > 120) return jsonResponse(400, { error: 'title must be between 3 and 120 characters' });
  if (description.length > 2000) return jsonResponse(400, { error: 'description must be 2000 characters or less' });
  if (!Number.isFinite(price) || price <= 0) return jsonResponse(400, { error: 'price must be a positive number' });

  const now = new Date().toISOString();
  const listingId = crypto.randomUUID();
  const priceCents = Math.round(price * 100);
  const publishIdempotencyKey = `${TENANT_ID}:${listingId}:mock-ebay:v1`;

  const listing: ListingItem = {
    pk: `TENANT#${TENANT_ID}`,
    sk: `LISTING#${listingId}`,
    entityType: 'LISTING',
    tenantId: TENANT_ID,
    listingId,
    title,
    description,
    priceCents,
    status: 'PENDING_PUBLISH',
    marketplace: 'mock-ebay',
    publishIdempotencyKey,
    publishAttemptCount: 0,
    latestActivity: 'Listing created; publish queued',
    latestActivityAt: now,
    createdAt: now,
    updatedAt: now
  };

  const activity: ActivityItem = {
    pk: `LISTING#${listingId}`,
    sk: `ACTIVITY#${now}#listing-created`,
    entityType: 'ACTIVITY',
    tenantId: TENANT_ID,
    listingId,
    eventId: `listing-created-${listingId}`,
    eventType: 'listing_created',
    source: 'app',
    message: 'Listing created; publish queued',
    occurredAt: now,
    createdAt: now
  };

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE_NAME, Item: listing, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: TABLE_NAME, Item: activity } }
    ]
  }));

  const message: PublishQueueMessage = {
    tenantId: TENANT_ID,
    listingId,
    idempotencyKey: publishIdempotencyKey,
    title,
    description,
    priceCents
  };

  await sqs.send(new SendMessageCommand({ QueueUrl: PUBLISH_QUEUE_URL, MessageBody: JSON.stringify(message) }));

  return jsonResponse(201, { listing: toPublicListing(listing, [activity]) });
}

/**
 * List all demo-tenant listings with a small slice of recent activity.
 *
 * DynamoDB pattern:
 * - query tenant partition for listings
 * - query per-listing partition for latest activity
 */
async function listListings() {
  const listingsResult = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${TENANT_ID}`, ':sk': 'LISTING#' }
  }));

  const listingItems = (listingsResult.Items ?? []) as ListingItem[];
  listingItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const listings = await Promise.all(listingItems.map(async (listing) => {
    const activitiesResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `LISTING#${listing.listingId}`, ':sk': 'ACTIVITY#' },
      ScanIndexForward: false,
      Limit: 5
    }));
    return toPublicListing(listing, (activitiesResult.Items ?? []) as ActivityItem[]);
  }));

  return jsonResponse(200, { listings });
}

/**
 * Receive signed webhook events from the mock marketplace.
 *
 * Security:
 * - verifies HMAC signature + timestamp window
 * - deduplicates by event ID (conditional write)
 */
async function receiveMockWebhook(event: APIGatewayProxyEventV2) {
  const body = rawBody(event.body, event.isBase64Encoded);
  const secret = await getSigningSecret();
  const timestamp = header(event, 'x-mock-timestamp');
  const signature = header(event, 'x-mock-signature');

  if (!verifySignedBody({ secret, timestamp, signature, body })) return jsonResponse(401, { error: 'invalid webhook signature' });

  const marketplaceEvent = JSON.parse(body) as MarketplaceWebhookEvent;
  const validationError = validateMarketplaceEvent(marketplaceEvent);
  if (validationError) return jsonResponse(400, { error: validationError });

  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk: `WEBHOOK#${marketplaceEvent.eventId}`, sk: 'DEDUP', entityType: 'WEBHOOK_DEDUP', eventId: marketplaceEvent.eventId, ttl, createdAt: now },
      ConditionExpression: 'attribute_not_exists(pk)'
    }));
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') return jsonResponse(200, { duplicate: true });
    throw error;
  }

  const activity = activityFromWebhook(marketplaceEvent, now);
  const update = listingUpdateForEvent(marketplaceEvent, activity.message, now);

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE_NAME, Item: activity } },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: { pk: `TENANT#${marketplaceEvent.tenantId}`, sk: `LISTING#${marketplaceEvent.listingId}` },
          UpdateExpression: update.expression,
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: update.names,
          ExpressionAttributeValues: update.values
        }
      }
    ]
  }));

  return jsonResponse(202, { ok: true });
}

/**
 * User-triggered retry endpoint.
 *
 * Re-queues an existing listing publish without creating a duplicate listing.
 */
async function retryPublish(listingId: string) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND sk = :sk',
    ExpressionAttributeValues: {
      ':pk': `TENANT#${TENANT_ID}`,
      ':sk': `LISTING#${listingId}`
    },
    Limit: 1
  }));

  const listing = (result.Items?.[0] as ListingItem | undefined);
  if (!listing) return jsonResponse(404, { error: 'Listing not found' });
  if (listing.status !== 'PUBLISH_FAILED') return jsonResponse(400, { error: `Cannot retry publish from status ${listing.status}` });

  const now = new Date().toISOString();
  const activity: ActivityItem = {
    pk: `LISTING#${listingId}`,
    sk: `ACTIVITY#${now}#publish-retry-requested`,
    entityType: 'ACTIVITY',
    tenantId: listing.tenantId,
    listingId,
    eventId: `publish-retry-requested-${listingId}-${now}`,
    eventType: 'publish_retry_requested',
    source: 'app',
    message: 'Retry requested; publish queued',
    occurredAt: now,
    createdAt: now
  };

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE_NAME, Item: activity } },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: { pk: `TENANT#${listing.tenantId}`, sk: `LISTING#${listingId}` },
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updatedAt': 'updatedAt',
            '#latestActivity': 'latestActivity',
            '#latestActivityAt': 'latestActivityAt'
          },
          ExpressionAttributeValues: {
            ':status': 'PENDING_PUBLISH',
            ':updatedAt': now,
            ':latestActivity': 'Retry requested; publish queued',
            ':latestActivityAt': now,
            ':publishAttemptCount': 0
          },
          UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, #latestActivity = :latestActivity, #latestActivityAt = :latestActivityAt, publishAttemptCount = :publishAttemptCount REMOVE lastPublishError, lastPublishErrorCode, nextRetryAt, lastPublishAttemptAt'
        }
      }
    ]
  }));

  const message: PublishQueueMessage = {
    tenantId: listing.tenantId,
    listingId,
    idempotencyKey: listing.publishIdempotencyKey,
    title: listing.title,
    description: listing.description,
    priceCents: listing.priceCents
  };

  await sqs.send(new SendMessageCommand({ QueueUrl: PUBLISH_QUEUE_URL, MessageBody: JSON.stringify(message) }));

  return jsonResponse(202, { status: 'retry_queued' });
}

/**
 * Convert a webhook event into a user-facing Activity feed item.
 */
function activityFromWebhook(event: MarketplaceWebhookEvent, createdAt: string): ActivityItem {
  const occurredAt = event.occurredAt || createdAt;
  const buyerAlias = String(event.payload?.buyerAlias ?? 'buyer');
  const commentText = String(event.payload?.commentText ?? '').slice(0, 500);
  const messageByType: Record<MarketplaceWebhookEvent['eventType'], string> = {
    listing_published: `Published to mock eBay as ${event.marketplaceListingId}`,
    publish_failed: 'Mock eBay rejected the publish request',
    new_comment: `${buyerAlias} commented: ${commentText || '(empty comment)'}`,
    item_sold: `Item sold on mock eBay to ${buyerAlias}`
  };
  return {
    pk: `LISTING#${event.listingId}`,
    sk: `ACTIVITY#${occurredAt}#${event.eventId}`,
    entityType: 'ACTIVITY',
    tenantId: event.tenantId,
    listingId: event.listingId,
    eventId: event.eventId,
    eventType: event.eventType,
    source: 'mock-ebay',
    message: messageByType[event.eventType],
    occurredAt,
    createdAt,
    raw: event
  };
}

/**
 * Prepare a DynamoDB UpdateExpression for the Listing record based on event type.
 */
function listingUpdateForEvent(event: MarketplaceWebhookEvent, latestActivity: string, now: string) {
  const names: Record<string, string> = { '#updatedAt': 'updatedAt', '#latestActivity': 'latestActivity', '#latestActivityAt': 'latestActivityAt' };
  const values: Record<string, unknown> = { ':updatedAt': now, ':latestActivity': latestActivity, ':latestActivityAt': event.occurredAt || now };
  const sets = ['#updatedAt = :updatedAt', '#latestActivity = :latestActivity', '#latestActivityAt = :latestActivityAt'];
  const removes: string[] = [];

  if (event.eventType === 'listing_published') {
    names['#status'] = 'status';
    names['#marketplaceListingId'] = 'marketplaceListingId';
    values[':status'] = 'PUBLISHED';
    values[':marketplaceListingId'] = event.marketplaceListingId;
    sets.push('#status = :status', '#marketplaceListingId = :marketplaceListingId');

    removes.push('lastPublishError', 'lastPublishErrorCode', 'nextRetryAt');
  }
  if (event.eventType === 'publish_failed') {
    names['#status'] = 'status';
    values[':status'] = 'PUBLISH_FAILED';
    sets.push('#status = :status');
  }
  if (event.eventType === 'item_sold') {
    names['#status'] = 'status';
    values[':status'] = 'SOLD';
    sets.push('#status = :status');
  }

  const removeClause = removes.length ? ` REMOVE ${removes.join(', ')}` : '';
  return { expression: `SET ${sets.join(', ')}${removeClause}`, names, values };
}

/**
 * Basic schema validation for inbound webhook events.
 */
function validateMarketplaceEvent(event: MarketplaceWebhookEvent): string | undefined {
  if (!event.eventId) return 'eventId is required';
  if (!event.listingId) return 'listingId is required';
  if (event.tenantId !== TENANT_ID) return 'unknown tenant';
  if (event.marketplace !== 'mock-ebay') return 'unknown marketplace';
  if (!event.marketplaceListingId) return 'marketplaceListingId is required';
  if (!['listing_published', 'publish_failed', 'new_comment', 'item_sold'].includes(event.eventType)) return 'unsupported eventType';
  return undefined;
}

/**
 * Trim internal DDB fields and present a UI-friendly DTO.
 */
function toPublicListing(listing: ListingItem, activities: ActivityItem[]) {
  return {
    listingId: listing.listingId,
    title: listing.title,
    description: listing.description,
    priceCents: listing.priceCents,
    status: listing.status,
    marketplace: listing.marketplace,
    marketplaceListingId: listing.marketplaceListingId,
    publishAttemptCount: listing.publishAttemptCount,
    lastPublishError: listing.lastPublishError,
    lastPublishErrorCode: listing.lastPublishErrorCode,
    lastPublishAttemptAt: listing.lastPublishAttemptAt,
    nextRetryAt: listing.nextRetryAt,
    latestActivity: listing.latestActivity,
    latestActivityAt: listing.latestActivityAt,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    activities: activities.map((activity) => ({
      eventId: activity.eventId,
      eventType: activity.eventType,
      source: activity.source,
      message: activity.message,
      occurredAt: activity.occurredAt
    }))
  };
}

/**
 * Case-insensitive header lookup for API Gateway HTTP API.
 */
function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const lower = name.toLowerCase();
  return event.headers?.[lower] ?? event.headers?.[name];
}
