export type ListingStatus = 'PENDING_PUBLISH' | 'PUBLISHING' | 'PUBLISHED' | 'PUBLISH_FAILED' | 'SOLD';

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
  eventType: MarketplaceEventType | 'listing_created';
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
