#!/usr/bin/env node
/**
 * Manual event trigger script
 *
 * Calls the mock marketplace boundary endpoint (`/mock-marketplace/events`) to
 * enqueue a synthetic marketplace event.
 *
 * This is intentionally separate from the webhook receiver: it simulates the
 * marketplace originating events, then the mock event emitter delivers them as
 * signed webhooks into our system.
 */

const [apiUrlRaw, listingId, marketplaceListingId, eventType, commentText] = process.argv.slice(2);
const apiUrl = apiUrlRaw?.replace(/\/$/, '');

if (!apiUrl || !listingId || !marketplaceListingId || !eventType) {
  console.error('Usage: npm run trigger:event -- <apiUrl> <listingId> <marketplaceListingId> <new_comment|item_sold> [commentText]');
  process.exit(1);
}

if (!['new_comment', 'item_sold'].includes(eventType)) {
  console.error('eventType must be new_comment or item_sold');
  process.exit(1);
}

const payload = eventType === 'new_comment'
  ? { buyerAlias: 'cli_buyer', commentText: commentText ?? 'Is this still available?' }
  : { buyerAlias: 'cli_buyer' };

const response = await fetch(`${apiUrl}/mock-marketplace/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ eventType, listingId, marketplaceListingId, payload })
});

const text = await response.text();
console.log(response.status, text);
if (!response.ok) process.exit(1);
