import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});
let cachedSecret: string | undefined;

export async function getSigningSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const secretId = process.env.SIGNING_SECRET_ARN;
  if (!secretId) throw new Error('SIGNING_SECRET_ARN is not configured');
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!response.SecretString) throw new Error('Signing secret had no SecretString');
  cachedSecret = response.SecretString;
  return cachedSecret;
}
