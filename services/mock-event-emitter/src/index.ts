import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import crypto from 'node:crypto';
import { getSigningSecret } from '../../shared/src/secrets';
import { signedHeaders } from '../../shared/src/signing';
import type { MarketplaceWebhookEvent } from '../../shared/src/types';

const WEBHOOK_URL = process.env.WEBHOOK_URL!;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(event.Records.map(async (record) => {
    try {
      const parsed = JSON.parse(record.body) as Omit<MarketplaceWebhookEvent, 'eventId'> & { eventId?: string };
      const webhookEvent: MarketplaceWebhookEvent = {
        eventId: parsed.eventId ?? `evt_${crypto.randomUUID()}`,
        eventType: parsed.eventType,
        tenantId: parsed.tenantId,
        listingId: parsed.listingId,
        marketplace: 'mock-ebay',
        marketplaceListingId: parsed.marketplaceListingId,
        occurredAt: parsed.occurredAt ?? new Date().toISOString(),
        payload: parsed.payload ?? {}
      };
      await sendWebhook(webhookEvent);
    } catch (error) {
      console.error('Mock event emitter failed', { messageId: record.messageId, error });
      failures.push({ itemIdentifier: record.messageId });
    }
  }));

  return { batchItemFailures: failures };
}

async function sendWebhook(event: MarketplaceWebhookEvent) {
  const secret = await getSigningSecret();
  const body = JSON.stringify(event);

  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signedHeaders(secret, body, 'x-mock')
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook receiver returned ${response.status}: ${text}`);
  }
}
