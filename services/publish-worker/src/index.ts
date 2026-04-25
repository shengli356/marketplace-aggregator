/**
 * Publish Worker Lambda
 *
 * Trigger: SQS publish queue.
 *
 * Responsibility:
 * - consume listing publish messages
 * - call the mock marketplace publish endpoint using an internal HMAC signature
 *
 * Failure model:
 * - on transient errors (429/503), the message will be retried by SQS
 * - after maxReceiveCount, messages land in the Publish DLQ
 */

import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getSigningSecret } from '../../shared/src/secrets';
import { signedHeaders } from '../../shared/src/signing';
import type { ActivityItem, PublishQueueMessage } from '../../shared/src/types';

const MOCK_PUBLISH_URL = process.env.MOCK_PUBLISH_URL!;
const TABLE_NAME = process.env.TABLE_NAME!;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const FETCH_TIMEOUT_MS = 10_000;
const RETRY_DELAY_SECONDS = 30;

/**
 * SQS batch handler.
 * Uses partial batch response so failed records can be retried without dropping the full batch.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(event.Records.map(async (record) => {
    try {
      const message = JSON.parse(record.body) as PublishQueueMessage;
      const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? '1');

      await markPublishAttempt(message, receiveCount);
      await publishToMockMarketplace(message);
    } catch (error) {
      console.error('Publish worker failed', { messageId: record.messageId, error });

      const message = safeParse<PublishQueueMessage>(record.body);
      if (message) {
        const status = classifyFailure(error);
        if (status.kind === 'retryable') {
          await markRetrying(message, status, Number(record.attributes?.ApproximateReceiveCount ?? '1'));
          failures.push({ itemIdentifier: record.messageId });
        } else {
          await markFailed(message, status);
        }
      } else {
        failures.push({ itemIdentifier: record.messageId });
      }
    }
  }));

  return { batchItemFailures: failures };
}

/**
 * Perform the signed publish request to the mock marketplace.
 */
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(MOCK_PUBLISH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedHeaders(secret, body, 'x-internal')
      },
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mock marketplace publish failed with ${response.status}: ${text}`);
  }
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function classifyFailure(error: unknown):
  | { kind: 'retryable'; errorCode: 'RATE_LIMITED' | 'MARKETPLACE_UNAVAILABLE' | 'TIMEOUT'; message: string }
  | { kind: 'non_retryable'; errorCode: 'VALIDATION_ERROR'; message: string } {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('Mock marketplace publish failed with 429')) {
    return { kind: 'retryable', errorCode: 'RATE_LIMITED', message: 'Marketplace is temporarily unavailable. We will retry automatically.' };
  }
  if (message.includes('Mock marketplace publish failed with 5') || message.includes('Mock marketplace publish failed with 503')) {
    return { kind: 'retryable', errorCode: 'MARKETPLACE_UNAVAILABLE', message: 'Marketplace is temporarily unavailable. We will retry automatically.' };
  }
  if (message.includes('aborted') || message.includes('AbortError')) {
    return { kind: 'retryable', errorCode: 'TIMEOUT', message: 'Marketplace timed out. We will retry automatically.' };
  }

  if (
    message.includes('fetch failed')
    || message.includes('Failed to fetch')
    || message.includes('ECONNRESET')
    || message.includes('ENOTFOUND')
    || message.includes('EAI_AGAIN')
    || message.includes('ETIMEDOUT')
  ) {
    return { kind: 'retryable', errorCode: 'MARKETPLACE_UNAVAILABLE', message: 'Marketplace is temporarily unavailable. We will retry automatically.' };
  }

  return { kind: 'non_retryable', errorCode: 'VALIDATION_ERROR', message: 'Listing rejected. Please review details.' };
}

async function markPublishAttempt(message: PublishQueueMessage, receiveCount: number) {
  const now = new Date().toISOString();
  const activity: ActivityItem = {
    pk: `LISTING#${message.listingId}`,
    sk: `ACTIVITY#${now}#publish-attempted`,
    entityType: 'ACTIVITY',
    tenantId: message.tenantId,
    listingId: message.listingId,
    eventId: `publish-attempted-${message.listingId}-${crypto.randomUUID()}`,
    eventType: 'publish_attempted',
    source: 'app',
    message: `Publish attempt ${receiveCount} started`,
    occurredAt: now,
    createdAt: now
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: activity }));

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${message.tenantId}`, sk: `LISTING#${message.listingId}` },
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#updatedAt': 'updatedAt',
      '#latestActivity': 'latestActivity',
      '#latestActivityAt': 'latestActivityAt'
    },
    ExpressionAttributeValues: {
      ':status': 'PUBLISHING',
      ':updatedAt': now,
      ':latestActivity': `Publishing (attempt ${receiveCount})`,
      ':latestActivityAt': now,
      ':inc': 1,
      ':lastPublishAttemptAt': now
    },
    UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, #latestActivity = :latestActivity, #latestActivityAt = :latestActivityAt, lastPublishAttemptAt = :lastPublishAttemptAt REMOVE nextRetryAt ADD publishAttemptCount :inc'
  }));
}

async function markRetrying(
  message: PublishQueueMessage,
  failure: { errorCode: string; message: string },
  receiveCount: number
) {
  const now = new Date().toISOString();
  const nextRetryAt = new Date(Date.now() + RETRY_DELAY_SECONDS * 1000).toISOString();
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${message.tenantId}`, sk: `LISTING#${message.listingId}` },
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#updatedAt': 'updatedAt',
      '#latestActivity': 'latestActivity',
      '#latestActivityAt': 'latestActivityAt'
    },
    ExpressionAttributeValues: {
      ':status': 'PUBLISH_RETRYING',
      ':updatedAt': now,
      ':latestActivity': `${failure.message} (attempt ${receiveCount})`,
      ':latestActivityAt': now,
      ':lastPublishError': failure.message,
      ':lastPublishErrorCode': failure.errorCode,
      ':nextRetryAt': nextRetryAt
    },
    UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, #latestActivity = :latestActivity, #latestActivityAt = :latestActivityAt, lastPublishError = :lastPublishError, lastPublishErrorCode = :lastPublishErrorCode, nextRetryAt = :nextRetryAt'
  }));
}

async function markFailed(
  message: PublishQueueMessage,
  failure: { errorCode: string; message: string }
) {
  const now = new Date().toISOString();
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${message.tenantId}`, sk: `LISTING#${message.listingId}` },
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#updatedAt': 'updatedAt',
      '#latestActivity': 'latestActivity',
      '#latestActivityAt': 'latestActivityAt'
    },
    ExpressionAttributeValues: {
      ':status': 'PUBLISH_FAILED',
      ':updatedAt': now,
      ':latestActivity': failure.message,
      ':latestActivityAt': now,
      ':lastPublishError': failure.message,
      ':lastPublishErrorCode': failure.errorCode
    },
    UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, #latestActivity = :latestActivity, #latestActivityAt = :latestActivityAt, lastPublishError = :lastPublishError, lastPublishErrorCode = :lastPublishErrorCode REMOVE nextRetryAt'
  }));
}
