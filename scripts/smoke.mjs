#!/usr/bin/env node
const apiUrl = process.argv[2]?.replace(/\/$/, '');
if (!apiUrl) {
  console.error('Usage: npm run smoke -- https://YOUR_API_URL');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} failed ${response.status}: ${text}`);
  return data;
}

console.log('Creating listing...');
const create = await request('/listings', {
  method: 'POST',
  body: JSON.stringify({
    title: `Smoke test camera ${Date.now()}`,
    description: 'Created by deployed smoke test',
    price: 42.5
  })
});

const listingId = create.listing.listingId;
console.log('Listing ID:', listingId);

let listing;
for (let i = 0; i < 12; i++) {
  await sleep(3000);
  const list = await request('/listings');
  listing = list.listings.find((item) => item.listingId === listingId);
  console.log(`Poll ${i + 1}:`, listing?.status, listing?.marketplaceListingId ?? '(no marketplace id yet)');
  if (listing?.marketplaceListingId) break;
}

if (!listing?.marketplaceListingId) {
  throw new Error('Listing did not publish in time. Check Publish DLQ and Lambda logs. The mock may have exhausted retries.');
}

console.log('Triggering comment...');
await request('/mock-marketplace/events', {
  method: 'POST',
  body: JSON.stringify({
    eventType: 'new_comment',
    listingId,
    marketplaceListingId: listing.marketplaceListingId,
    payload: { buyerAlias: 'smoke_buyer', commentText: 'Can you ship today?' }
  })
});

await sleep(1500);
console.log('Triggering sale...');
await request('/mock-marketplace/events', {
  method: 'POST',
  body: JSON.stringify({
    eventType: 'item_sold',
    listingId,
    marketplaceListingId: listing.marketplaceListingId,
    payload: { buyerAlias: 'smoke_buyer' }
  })
});

await sleep(2500);
const finalList = await request('/listings');
const finalListing = finalList.listings.find((item) => item.listingId === listingId);
console.log(JSON.stringify(finalListing, null, 2));
console.log('Smoke test complete.');
