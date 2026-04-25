/**
 * Secrets helper
 *
 * Centralized Secrets Manager lookup for the prototype.
 *
 * This project uses a single shared HMAC secret for:
 * - signing internal publish calls (publish-worker -> mock-marketplace)
 * - signing mock webhook deliveries (mock-event-emitter -> app API)
 * - verifying received webhooks (app API)
 *
 * The secret value is cached in-memory for warm Lambda invocations to reduce
 * Secrets Manager API calls.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});
let cachedSecret: string | undefined;

/**
 * Retrieve the shared signing secret from AWS Secrets Manager.
 *
 * The secret ARN is passed in via `SIGNING_SECRET_ARN`.
 */
export async function getSigningSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const secretId = process.env.SIGNING_SECRET_ARN;
  if (!secretId) throw new Error('SIGNING_SECRET_ARN is not configured');
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!response.SecretString) throw new Error('Signing secret had no SecretString');
  cachedSecret = response.SecretString;
  return cachedSecret;
}
