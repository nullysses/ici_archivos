import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { checkDatabase, createDatabase, type Database } from './index.js';

describe('PostgreSQL boundary', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let database: Database | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
  });

  afterAll(async () => {
    await database?.destroy();
    await container?.stop();
  });

  it('executes a real database health query', async () => {
    if (database === undefined) throw new Error('PostgreSQL test container did not start');
    await expect(checkDatabase(database)).resolves.toBe(true);
  });
});
