/**
 * Shared domain types
 *
 * These types are used by:
 * - API Lambda (listings + webhook receiver)
 * - publish worker (SQS message contract)
 * - mock marketplace (event shapes)
 * - mock event emitter (webhook payload)
 *
 * DynamoDB single-table design (high level):
 * - Listings live under `PK=TENANT#<tenantId>` with `SK=LISTING#<listingId>`
 * - Activity feed entries live under `PK=LISTING#<listingId>` with `SK=ACTIVITY#<time>#<eventId>`
 */

export type ListingStatus =
  | 'PENDING_PUBLISH'
  | 'PUBLISHING'
  | 'PUBLISH_RETRYING'
  | 'PUBLISHED'
  | 'PUBLISH_FAILED'
  | 'SOLD';

export type MarketplaceEventType = 'listing_published' | 'publish_failed' | 'new_comment' | 'item_sold';

export interface ListingItem {
  pk: string;
  sk: string;
  entityType: 'LISTING';
  tenantId: string;
  listingId: string;
  title: string;
  description: string;
  priceCents: number;
  status: ListingStatus;
  marketplace: 'mock-ebay';
  publishIdempotencyKey: string;
  marketplaceListingId?: string;
  publishAttemptCount?: number;
  lastPublishError?: string;
  lastPublishErrorCode?: string;
  lastPublishAttemptAt?: string;
  nextRetryAt?: string;
  latestActivity?: string;
  latestActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityItem {
  pk: string;
  sk: string;
  entityType: 'ACTIVITY';
  tenantId: string;
  listingId: string;
  eventId: string;
  eventType: MarketplaceEventType | 'listing_created' | 'publish_retry_requested' | 'publish_attempted' | 'publish_retry_exhausted';
  source: 'app' | 'mock-ebay';
  message: string;
  occurredAt: string;
  createdAt: string;
  raw?: unknown;
}

export interface PublishQueueMessage {
  tenantId: string;
  listingId: string;
  idempotencyKey: string;
  title: string;
  description: string;
  priceCents: number;
}

export interface MarketplaceWebhookEvent {
  eventId: string;
  eventType: MarketplaceEventType;
  tenantId: string;
  listingId: string;
  marketplace: 'mock-ebay';
  marketplaceListingId: string;
  occurredAt: string;
  payload?: Record<string, unknown>;
}
