import { readApiConfig } from '@ici/config';
import { checkDatabase, createDatabase } from '@ici/database';
import { createApp } from './app.js';

const config = readApiConfig();
const database = createDatabase(config.databaseUrl);
const app = await createApp({
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

