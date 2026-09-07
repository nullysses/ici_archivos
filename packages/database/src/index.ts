import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

export type DatabaseSchema = Record<never, never>;

export type Database = Kysely<DatabaseSchema>;

export function createDatabase(connectionString: string): Database {
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 10 }),
    }),
  });
}

export async function checkDatabase(database: Database): Promise<boolean> {
  try {
    await sql`select 1`.execute(database);
    return true;
  } catch {
    return false;
  }
}
