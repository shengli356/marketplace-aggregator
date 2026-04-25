/**
 * Publish DLQ handler Lambda
 *
 * Trigger: PublishDlq (dead-letter queue)
 *
 * Purpose:
 * - when a publish message exhausts SQS retries and is moved to the DLQ,
 *   mark the listing as failed with an explicit RETRY_EXHAUSTED error code.
 *
 * This makes retry exhaustion visible in the UI and enables a user-driven
 * manual retry via `POST /listings/{listingId}/retry-publish`.
 */

import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ActivityItem, PublishQueueMessage } from '../../shared/src/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME!;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(event.Records.map(async (record) => {
    try {
      const message = JSON.parse(record.body) as PublishQueueMessage;
      await markRetryExhausted(message);
    } catch (error) {
      console.error('Publish DLQ handler failed', { messageId: record.messageId, error });
      failures.push({ itemIdentifier: record.messageId });
    }
  }));

  return { batchItemFailures: failures };
}

async function markRetryExhausted(message: PublishQueueMessage) {
  const now = new Date().toISOString();

  const activity: ActivityItem = {
    pk: `LISTING#${message.listingId}`,
    sk: `ACTIVITY#${now}#publish-retry-exhausted`,
    entityType: 'ACTIVITY',
    tenantId: message.tenantId,
    listingId: message.listingId,
    eventId: `publish-retry-exhausted-${message.listingId}-${crypto.randomUUID()}`,
    eventType: 'publish_retry_exhausted',
    source: 'app',
    message: 'Publishing failed after multiple attempts.',
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
      ':status': 'PUBLISH_FAILED',
      ':updatedAt': now,
      ':latestActivity': 'Publishing failed after multiple attempts.',
      ':latestActivityAt': now,
      ':lastPublishError': 'Publishing failed after multiple attempts.',
      ':lastPublishErrorCode': 'RETRY_EXHAUSTED'
    },
    UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, #latestActivity = :latestActivity, #latestActivityAt = :latestActivityAt, lastPublishError = :lastPublishError, lastPublishErrorCode = :lastPublishErrorCode REMOVE nextRetryAt'
  }));
}
