import { readFile } from 'node:fs/promises';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { InstitutionId, JsonObject } from '@ici/domain';
import type { DatabaseSchema } from './schema.js';

export type Database = Kysely<DatabaseSchema>;
export type DatabaseTransaction = Transaction<DatabaseSchema>;
export type DatabaseExecutor = Database | DatabaseTransaction;

export function createDatabase(connectionString: string, options: { readonly maxConnections?: number } = {}): Database {
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: options.maxConnections ?? 10 }),
    }),
  });
}

export async function checkDatabase(database: DatabaseExecutor): Promise<boolean> {
  try {
    await sql`select 1`.execute(database);
    return true;
  } catch {
    return false;
  }
}

export async function applyFoundationMigrations(database: Database): Promise<void> {
  await database.schema
    .createTable('ici_schema_migrations')
    .ifNotExists()
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('applied_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtext('ici_archivos.foundation_migrations'))`.execute(transaction);
    const applied = await transaction.selectFrom('ici_schema_migrations').select('id').execute();
    const appliedIds = new Set(applied.map((row) => row.id));
    const migrations = ['001_foundation', '002_foundation_hardening', '003_persistence_foundation', '004_step4b_review_hardening', '005_matter_workflow', '006_oidc_identity_lookup', '007_document_parent_version_guard', '008_oidc_auth_hardening'] as const;
    for (const migrationId of migrations) {
      if (appliedIds.has(migrationId)) continue;
      const migration = await readFile(new URL(`../migrations/${migrationId}.sql`, import.meta.url), 'utf8');
      await sql.raw(migration).execute(transaction);
      await transaction.insertInto('ici_schema_migrations').values({ id: migrationId, applied_at: new Date() }).execute();
    }
  });
}

export async function setInstitutionContext(executor: DatabaseTransaction, institution: InstitutionId | string): Promise<void> {
  await sql`select set_config('app.institution_id', ${institution}, true)`.execute(executor);
}

export interface ExternalIdentityResolution {
  readonly institutionId: string;
  readonly institutionStatus: string;
  readonly userId: string;
  readonly userStatus: string;
}

export async function resolveExternalIdentity(database: Database, issuer: string, subject: string): Promise<ExternalIdentityResolution | undefined> {
  const result = await sql<{ institution_id: string; institution_status: string; user_id: string; user_status: string }>`select * from public.ici_resolve_external_identity(${issuer}, ${subject})`.execute(database);
  const row = result.rows[0];
  return row === undefined ? undefined : { institutionId: row.institution_id, institutionStatus: row.institution_status, userId: row.user_id, userStatus: row.user_status };
}

/** Context is transaction-local, so a released pool connection never retains it. */
export interface TenantTransactionContext {
  readonly institutionId: InstitutionId | string;
  readonly actorUserId?: string | undefined;
  readonly correlationId?: string | undefined;
}

export async function setTenantTransactionContext(executor: DatabaseTransaction, context: TenantTransactionContext): Promise<void> {
  await setInstitutionContext(executor, context.institutionId);
  if (context.actorUserId !== undefined) await sql`select set_config('app.actor_user_id', ${context.actorUserId}, true)`.execute(executor);
  if (context.correlationId !== undefined) await sql`select set_config('app.correlation_id', ${context.correlationId}, true)`.execute(executor);
}

export async function clearInstitutionContext(executor: DatabaseTransaction): Promise<void> {
  await sql`select set_config('app.institution_id', '', true)`.execute(executor);
}

export async function withTenantTransaction<T>(database: Database, institution: InstitutionId | string, callback: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
  return withTenantContextTransaction(database, { institutionId: institution }, callback);
}

export async function withTenantContextTransaction<T>(database: Database, context: TenantTransactionContext, callback: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
  return database.transaction().execute(async (transaction) => {
    await setTenantTransactionContext(transaction, context);
    return callback(transaction);
  });
}

export interface AuditMutationInput {
  readonly institutionId: InstitutionId | string;
  readonly actorUserId?: string | undefined;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly beforeData?: JsonObject | undefined;
  readonly afterData?: JsonObject | undefined;
  readonly eventData?: JsonObject | undefined;
}

export async function appendAuditEvent(executor: DatabaseExecutor, input: AuditMutationInput): Promise<void> {
  await executor.insertInto('audit_events').values({
    institution_id: input.institutionId,
    ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }),
    event_type: input.eventType,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    correlation_id: input.correlationId,
    ...(input.beforeData === undefined ? {} : { before_data: input.beforeData }),
    ...(input.afterData === undefined ? {} : { after_data: input.afterData }),
    event_data: input.eventData ?? {},
  }).execute();
}

export async function withAuditedTenantTransaction<T>(database: Database, input: AuditMutationInput, callback: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const result = await callback(transaction);
    await appendAuditEvent(transaction, input);
    return result;
  });
}

export interface FolioAllocationInput {
  readonly institutionId: InstitutionId | string;
  readonly folioKind: 'MATTER' | 'EXPEDIENTE';
  readonly folioYear: number;
}

export interface AllocatedFolio {
  readonly sequenceNumber: number;
  readonly folio: string;
}

export async function allocateFolio(executor: DatabaseTransaction, input: FolioAllocationInput): Promise<AllocatedFolio> {
  if (!Number.isInteger(input.folioYear) || input.folioYear < 2000 || input.folioYear > 9999) throw new Error('Folio year must be a four-digit year');
  const result = await sql<{ sequence_number: string }>`
    INSERT INTO folio_counters (institution_id, folio_kind, folio_year, next_value)
    VALUES (${input.institutionId}, ${input.folioKind}, ${input.folioYear}, 2)
    ON CONFLICT (institution_id, folio_kind, folio_year)
    DO UPDATE SET next_value = folio_counters.next_value + 1
    WHERE folio_counters.next_value <= 999999
    RETURNING (next_value - 1)::text AS sequence_number
  `.execute(executor);
  const rawSequence = result.rows[0]?.sequence_number;
  if (rawSequence === undefined) throw new Error('Folio allocation did not return a sequence number');
  const sequenceNumber = Number(rawSequence);
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1 || sequenceNumber > 999_999) throw new Error('Folio sequence exceeds the six-digit MVP format');
  const prefix = input.folioKind === 'MATTER' ? 'OP' : 'EXP';
  return { sequenceNumber, folio: `${prefix}-${input.folioYear}-${String(sequenceNumber).padStart(6, '0')}` };
}

export async function assertApplicationRoleIsRlsSafe(database: DatabaseExecutor, roleName: string): Promise<void> {
  const result = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
    SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ${roleName}
  `.execute(database);
  const role = result.rows[0];
  if (role === undefined) throw new Error(`Application role ${roleName} does not exist`);
  if (role.rolbypassrls || role.rolsuper) throw new Error(`Application role ${roleName} must not bypass RLS or be superuser`);
  const privilegedMembership = await sql<{ can_assume_privileged_role: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_roles AS privileged
      WHERE (privileged.rolsuper OR privileged.rolbypassrls)
        AND pg_has_role(${roleName}, privileged.rolname, 'MEMBER')
    ) AS can_assume_privileged_role
  `.execute(database);
  if (privilegedMembership.rows[0]?.can_assume_privileged_role === true) throw new Error(`Application role ${roleName} must not be able to assume a role that bypasses RLS`);
  const ownership = await sql<{ owns_tenant_table: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname <> 'ici_schema_migrations'
        AND pg_has_role(${roleName}, c.relowner, 'MEMBER')
    ) AS owns_tenant_table
  `.execute(database);
  if (ownership.rows[0]?.owns_tenant_table === true) throw new Error(`Application role ${roleName} must not own tenant tables`);
}

export async function assertTenantTablesUseForcedRls(database: DatabaseExecutor): Promise<void> {
  const expectedTenantTables = [
    'organizational_units', 'users', 'external_identities', 'user_role_assignments',
    'folio_counters', 'matters', 'matter_assignments', 'matter_state_events', 'matter_notes',
    'expediente_types', 'expediente_type_versions', 'expedientes', 'expediente_state_events',
    'access_classifications', 'documents', 'document_versions', 'malware_scans',
    'archival_classification_nodes', 'atom_mappings', 'archive_transfers', 'transfer_manifests',
    'archival_corrections', 'audit_events', 'integration_jobs',
  ] as const;
  const result = await sql<{ table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
    SELECT columns.table_name, class.relrowsecurity, class.relforcerowsecurity
    FROM information_schema.columns AS columns
    JOIN pg_namespace AS namespace ON namespace.nspname = columns.table_schema
    JOIN pg_class AS class ON class.relnamespace = namespace.oid AND class.relname = columns.table_name
    WHERE columns.table_schema = 'public'
      AND columns.column_name = 'institution_id'
      AND class.relkind = 'r'
  `.execute(database);
  const present = new Set(result.rows.map((row) => row.table_name));
  const missing = expectedTenantTables.filter((table) => !present.has(table));
  if (missing.length > 0) throw new Error(`Tenant tables missing institution_id: ${missing.join(', ')}`);
  const unsafe = result.rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity);
  if (unsafe.length > 0) throw new Error(`Tenant tables without forced RLS: ${unsafe.map((row) => row.table_name).join(', ')}`);
}

export async function insertIntegrationJob(executor: DatabaseTransaction, input: {
  readonly id?: string;
  readonly institutionId: InstitutionId | string;
  readonly jobType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly payload: JsonObject;
}): Promise<void> {
  await executor.insertInto('integration_jobs').values({
    ...(input.id === undefined ? {} : { id: input.id }),
    institution_id: input.institutionId,
    job_type: input.jobType,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    status: 'PENDING',
    idempotency_key: input.idempotencyKey,
    correlation_id: input.correlationId,
    attempt_count: 0,
    payload: input.payload,
  }).onConflict((conflict) => conflict.columns(['institution_id', 'idempotency_key']).doNothing()).execute();
}

export type { DatabaseSchema } from './schema.js';
export * from './services.js';
export * from './repositories.js';
export * from './permissions.js';
export * from './json-schema-validator.js';
export * from './seeds.js';
