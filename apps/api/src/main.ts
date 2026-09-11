import { readApiConfig } from '@ici/config';
import { checkDatabase, createDatabase } from '@ici/database';
import { createApp } from './app.js';
import { authenticateAccessToken, UnauthenticatedError, type AccessTokenVerifier } from './auth.js';
import { createJoseAccessTokenVerifier } from './oidc.js';

const config = readApiConfig();
const database = createDatabase(config.databaseUrl);
const hasOidcConfiguration = [config.oidcIssuer, config.oidcAudience, config.oidcJwksUri, config.oidcDiscoveryUrl].some((value) => value !== undefined);
const accessTokenVerifier: AccessTokenVerifier = hasOidcConfiguration
  ? await createJoseAccessTokenVerifier(config)
  : { verify: () => Promise.reject(new UnauthenticatedError()) };
const app = await createApp({
  authenticateAccessToken: (accessToken) => authenticateAccessToken(database, accessTokenVerifier, accessToken),
  checkDatabase: () => checkDatabase(database),
  version: process.env.npm_package_version ?? '0.0.0',
  webOrigin: config.webOrigin,
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
