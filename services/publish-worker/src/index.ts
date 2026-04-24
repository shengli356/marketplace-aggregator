import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { getSigningSecret } from '../../shared/src/secrets';
import { signedHeaders } from '../../shared/src/signing';
import type { PublishQueueMessage } from '../../shared/src/types';

const MOCK_PUBLISH_URL = process.env.MOCK_PUBLISH_URL!;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(event.Records.map(async (record) => {
    try {
      const message = JSON.parse(record.body) as PublishQueueMessage;
      await publishToMockMarketplace(message);
    } catch (error) {
      console.error('Publish worker failed', { messageId: record.messageId, error });
      failures.push({ itemIdentifier: record.messageId });
    }
  }));

  return { batchItemFailures: failures };
}

async function publishToMockMarketplace(message: PublishQueueMessage) {
  const secret = await getSigningSecret();
  const body = JSON.stringify({
    tenantId: message.tenantId,
    listingId: message.listingId,
    idempotencyKey: message.idempotencyKey,
    title: message.title,
    description: message.description,
    priceCents: message.priceCents
  });

  const response = await fetch(MOCK_PUBLISH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signedHeaders(secret, body, 'x-internal')
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mock marketplace publish failed with ${response.status}: ${text}`);
  }
}
