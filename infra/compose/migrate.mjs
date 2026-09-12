import process from 'node:process';
import { applyFoundationMigrations, createDatabase } from '../../packages/database/dist/index.js';

const database = createDatabase(process.env.DATABASE_URL, { maxConnections: 1 });
try {
  await applyFoundationMigrations(database);
} finally {
  await database.destroy();
}
