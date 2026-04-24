import { FormEvent, useEffect, useMemo, useState } from 'react';

type Activity = { eventId: string; eventType: string; source: string; message: string; occurredAt: string };
type Listing = {
  listingId: string;
  title: string;
  description: string;
  priceCents: number;
  status: 'PENDING_PUBLISH' | 'PUBLISHING' | 'PUBLISHED' | 'PUBLISH_FAILED' | 'SOLD';
  marketplace: string;
  marketplaceListingId?: string;
  latestActivity?: string;
  latestActivityAt?: string;
  createdAt: string;
  updatedAt: string;
  activities: Activity[];
};

type RuntimeConfig = { apiBaseUrl: string };
const fallbackConfig: RuntimeConfig = { apiBaseUrl: 'http://localhost:3000' };

export default function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [listings, setListings] = useState<Listing[]>([]);
  const [title, setTitle] = useState('Vintage camera');
  const [description, setDescription] = useState('Works well. Includes strap and case.');
  const [price, setPrice] = useState('125.50');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apiBaseUrl = useMemo(() => (config?.apiBaseUrl ?? fallbackConfig.apiBaseUrl).replace(/\/$/, ''), [config?.apiBaseUrl]);

  async function loadConfig() {
    try {
      const response = await fetch('/config.json', { cache: 'no-store' });
      setConfig(response.ok ? await response.json() : fallbackConfig);
    } catch {
      setConfig(fallbackConfig);
    } finally {
      setConfigLoaded(true);
    }
  }

  async function loadListings() {
    const response = await fetch(`${apiBaseUrl}/listings`);
    if (!response.ok) throw new Error(`Failed to load listings: ${response.status}`);
    const data = await response.json();
    setListings(data.listings ?? []);
  }

  useEffect(() => { loadConfig(); }, []);

  useEffect(() => {
    if (!configLoaded) return;
    loadListings().catch((err) => setError(err.message));
    const timer = window.setInterval(() => {
      loadListings().catch((err) => setError(err.message));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [apiBaseUrl, configLoaded]);

  async function createListing(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${apiBaseUrl}/listings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, description, price })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `Create failed: ${response.status}`);
      setMessage('Listing created. Publish is queued; the feed will update after the mock marketplace webhook arrives.');
      await loadListings();
    } catch (err: any) {
      setError(err.message ?? 'Create failed');
    } finally {
      setLoading(false);
    }
  }

  async function triggerEvent(listing: Listing, eventType: 'new_comment' | 'item_sold') {
    setError(null);
    setMessage(null);
    const payload = eventType === 'new_comment'
      ? { buyerAlias: 'buyer_123', commentText: 'Is this still available?' }
      : { buyerAlias: 'buyer_123' };
    try {
      const response = await fetch(`${apiBaseUrl}/mock-marketplace/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType, listingId: listing.listingId, marketplaceListingId: listing.marketplaceListingId, payload })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `Event failed: ${response.status}`);
      setMessage(`Mock ${eventType} event accepted. Waiting for webhook delivery...`);
      window.setTimeout(() => loadListings().catch((err) => setError(err.message)), 1200);
    } catch (err: any) {
      setError(err.message ?? 'Event trigger failed');
    }
  }

  return (
    <main className="page">
      <section className="hero">
        <h1>Marketplace Aggregator</h1>
        <p>Create a listing once, publish it to a mocked eBay-like marketplace, and watch marketplace events roll into one activity feed.</p>
      </section>
      <div className="grid">
        <section className="card">
          <h2>Create listing</h2>
          <form onSubmit={createListing}>
            <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={120} required /></label>
            <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} /></label>
            <label>Price<input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" required /></label>
            <button disabled={loading || !configLoaded}>{loading ? 'Creating…' : 'Create and publish'}</button>
          </form>
          {message && <div className="success">{message}</div>}
          {error && <div className="error">{error}</div>}
        </section>
        <section className="card">
          <div className="listings-header">
            <h2>Listings and activity</h2>
            <button className="secondary" onClick={() => loadListings().catch((err) => setError(err.message))}>Refresh</button>
          </div>
          {listings.length === 0 ? <p className="muted">No listings yet.</p> : listings.map((listing) => (
            <article className="listing" key={listing.listingId}>
              <div className="listing-title-row">
                <div>
                  <strong>{listing.title}</strong>
                  <div className="muted">${(listing.priceCents / 100).toFixed(2)} · {listing.marketplaceListingId ?? 'not published yet'}</div>
                </div>
                <span className={`status ${listing.status}`}>{listing.status}</span>
              </div>
              {listing.description && <p>{listing.description}</p>}
              <ul className="activity">
                {listing.activities.map((activity) => (
                  <li key={activity.eventId}>
                    <strong>{activity.eventType}</strong> — {activity.message}<br />
                    <small className="muted">{new Date(activity.occurredAt).toLocaleString()} · {activity.source}</small>
                  </li>
                ))}
              </ul>
              <div className="actions">
                <button className="secondary" disabled={!listing.marketplaceListingId || listing.status === 'SOLD'} onClick={() => triggerEvent(listing, 'new_comment')}>Mock comment</button>
                <button className="secondary" disabled={!listing.marketplaceListingId || listing.status === 'SOLD'} onClick={() => triggerEvent(listing, 'item_sold')}>Mock sale</button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
