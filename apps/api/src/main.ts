import { readApiConfig } from '@ici/config';
import { checkDatabase, createDatabase } from '@ici/database';
import { createApp } from './app.js';
import { authenticateAccessToken, UnauthenticatedError, type AccessTokenVerifier } from './auth.js';
import { createJoseAccessTokenVerifier } from './oidc.js';
import { createMatterApplicationService } from './matters.js';
import { S3Client } from '@aws-sdk/client-s3';
import { S3DocumentStorage } from '@ici/integration-storage';
import { createExpedienteApplicationService } from './expedientes.js';

const config = readApiConfig();
const database = createDatabase(config.databaseUrl);
const hasOidcConfiguration = [config.oidcIssuer, config.oidcAudience, config.oidcJwksUri, config.oidcDiscoveryUrl].some((value) => value !== undefined);
const accessTokenVerifier: AccessTokenVerifier = hasOidcConfiguration
  ? await createJoseAccessTokenVerifier(config)
  : { verify: () => Promise.reject(new UnauthenticatedError()) };
const documentStorage = config.s3Endpoint !== undefined && config.s3AccessKeyId !== undefined && config.s3SecretAccessKey !== undefined && config.s3QuarantineBucket !== undefined && config.s3CleanBucket !== undefined
  ? new S3DocumentStorage({ client: new S3Client({ endpoint: config.s3Endpoint, region: config.s3Region ?? 'us-east-1', forcePathStyle: config.s3ForcePathStyle ?? false, credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey } }), quarantineBucket: config.s3QuarantineBucket, cleanBucket: config.s3CleanBucket })
  : undefined;
const app = await createApp({
  authenticateAccessToken: (accessToken) => authenticateAccessToken(database, accessTokenVerifier, accessToken),
  matterService: createMatterApplicationService(database),
  expedienteService: createExpedienteApplicationService(database),
  checkDatabase: () => checkDatabase(database),
  version: process.env.npm_package_version ?? '0.0.0',
  webOrigin: config.webOrigin,
  ...(documentStorage === undefined ? {} : { documentDependencies: { database, storage: documentStorage, maxBytes: config.fileUploadDefaultMaxBytes ?? 500n * 1024n * 1024n } }),
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down API');
  await app.close();
  await database.destroy();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await database.destroy();
  process.exitCode = 1;
}
