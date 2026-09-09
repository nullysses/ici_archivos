import type { JsonObject } from '@ici/domain';
import { DomainInvariantError } from '@ici/domain';
import type { DatabaseTransaction } from './index.js';

/** Narrow tenant-scoped persistence operations. Callers obtain this only inside
 * withTenantTransaction, which makes every query subject to PostgreSQL RLS. */
export class TenantRepositories {
  public constructor(private readonly transaction: DatabaseTransaction, private readonly institutionId: string) {}

  public readonly reference = {
    unitById: (id: string) => this.transaction.selectFrom('organizational_units').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    userById: (id: string) => this.transaction.selectFrom('users').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    identitiesForUser: (userId: string) => this.transaction.selectFrom('external_identities').selectAll().where('institution_id', '=', this.institutionId).where('user_id', '=', userId).execute(),
    roleAssignmentsForUser: (userId: string) => this.transaction.selectFrom('user_role_assignments').selectAll().where('institution_id', '=', this.institutionId).where('user_id', '=', userId).execute(),
    accessClassificationById: (id: string) => this.transaction.selectFrom('access_classifications').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    archivalNodeById: (id: string) => this.transaction.selectFrom('archival_classification_nodes').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
  };

  public readonly expedienteTypes = {
    byId: (id: string) => this.transaction.selectFrom('expediente_types').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    versionById: (id: string) => this.transaction.selectFrom('expediente_type_versions').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    versionsForType: (id: string) => this.transaction.selectFrom('expediente_type_versions').selectAll().where('institution_id', '=', this.institutionId).where('expediente_type_id', '=', id).orderBy('version_number', 'desc').execute(),
  };

  public readonly matters = {
    byId: (id: string) => this.transaction.selectFrom('matters').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    byFolio: (folio: string) => this.transaction.selectFrom('matters').selectAll().where('institution_id', '=', this.institutionId).where('folio', '=', folio).executeTakeFirst(),
    assignments: (matterId: string) => this.transaction.selectFrom('matter_assignments').selectAll().where('institution_id', '=', this.institutionId).where('matter_id', '=', matterId).orderBy('assigned_at', 'desc').orderBy('id', 'desc').execute(),
    states: (matterId: string) => this.transaction.selectFrom('matter_state_events').selectAll().where('institution_id', '=', this.institutionId).where('matter_id', '=', matterId).orderBy('occurred_at').orderBy('id').execute(),
  };

  public readonly expedientes = {
    byId: (id: string) => this.transaction.selectFrom('expedientes').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    byFolio: (folio: string) => this.transaction.selectFrom('expedientes').selectAll().where('institution_id', '=', this.institutionId).where('folio', '=', folio).executeTakeFirst(),
    linkedMatters: (id: string) => this.transaction.selectFrom('matters').selectAll().where('institution_id', '=', this.institutionId).where('linked_expediente_id', '=', id).execute(),
    states: (id: string) => this.transaction.selectFrom('expediente_state_events').selectAll().where('institution_id', '=', this.institutionId).where('expediente_id', '=', id).orderBy('occurred_at').orderBy('id').execute(),
    typeVersion: (id: string) => this.transaction.selectFrom('expedientes as e').innerJoin('expediente_type_versions as v', (join) => join.onRef('v.id', '=', 'e.expediente_type_version_id').onRef('v.institution_id', '=', 'e.institution_id')).selectAll('v').where('e.institution_id', '=', this.institutionId).where('e.id', '=', id).executeTakeFirst(),
  };

  public readonly documents = {
    byId: (id: string) => this.transaction.selectFrom('documents').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    forExpediente: (expedienteId: string) => this.transaction.selectFrom('documents').selectAll().where('institution_id', '=', this.institutionId).where('expediente_id', '=', expedienteId).orderBy('created_at').execute(),
    versions: (documentId: string) => this.transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', this.institutionId).where('document_id', '=', documentId).orderBy('version_number', 'desc').execute(),
    currentVersion: (documentId: string) => this.transaction.selectFrom('documents as d').innerJoin('document_versions as v', (join) => join.onRef('v.id', '=', 'd.current_version_id').onRef('v.institution_id', '=', 'd.institution_id')).selectAll('v').where('d.institution_id', '=', this.institutionId).where('d.id', '=', documentId).executeTakeFirst(),
  };

  public readonly transfers = {
    byId: (id: string) => this.transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    forExpediente: (expedienteId: string) => this.transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', this.institutionId).where('expediente_id', '=', expedienteId).orderBy('created_at', 'desc').execute(),
    approvedManifest: (transferId: string) => this.transaction.selectFrom('transfer_manifests').selectAll().where('institution_id', '=', this.institutionId).where('transfer_id', '=', transferId).where('status', '=', 'APPROVED').executeTakeFirst(),
    corrections: (transferId: string) => this.transaction.selectFrom('archival_corrections').selectAll().where('institution_id', '=', this.institutionId).where('transfer_id', '=', transferId).orderBy('created_at').execute(),
  };

  public readonly audit = {
    forAggregate: (aggregateType: string, aggregateId: string) => this.transaction.selectFrom('audit_events').selectAll().where('institution_id', '=', this.institutionId).where('aggregate_type', '=', aggregateType).where('aggregate_id', '=', aggregateId).orderBy('occurred_at').execute(),
    forActor: (actorUserId: string) => this.transaction.selectFrom('audit_events').selectAll().where('institution_id', '=', this.institutionId).where('actor_user_id', '=', actorUserId).orderBy('occurred_at', 'desc').execute(),
    forCorrelation: (correlationId: string) => this.transaction.selectFrom('audit_events').selectAll().where('institution_id', '=', this.institutionId).where('correlation_id', '=', correlationId).orderBy('occurred_at').execute(),
    between: (from: Date, to: Date) => this.transaction.selectFrom('audit_events').selectAll().where('institution_id', '=', this.institutionId).where('occurred_at', '>=', from).where('occurred_at', '<=', to).orderBy('occurred_at').execute(),
  };

  public readonly jobs = {
    byId: (id: string) => this.transaction.selectFrom('integration_jobs').selectAll().where('institution_id', '=', this.institutionId).where('id', '=', id).executeTakeFirst(),
    byIdempotencyKey: (key: string) => this.transaction.selectFrom('integration_jobs').selectAll().where('institution_id', '=', this.institutionId).where('idempotency_key', '=', key).executeTakeFirst(),
    retryable: (now: Date = new Date()) => this.transaction.selectFrom('integration_jobs').selectAll().where('institution_id', '=', this.institutionId).where('status', '=', 'PENDING').where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)])).orderBy('created_at').execute(),
  };

  public async createIntegrationJob(input: { id?: string; jobType: string; aggregateType: string; aggregateId: string; idempotencyKey: string; correlationId: string; payload: JsonObject }): Promise<unknown> {
    await this.transaction.insertInto('integration_jobs').values({ ...(input.id === undefined ? {} : { id: input.id }), institution_id: this.institutionId, job_type: input.jobType, aggregate_type: input.aggregateType, aggregate_id: input.aggregateId, status: 'PENDING', idempotency_key: input.idempotencyKey, correlation_id: input.correlationId, attempt_count: 0, payload: input.payload }).onConflict((oc) => oc.columns(['institution_id', 'idempotency_key']).doNothing()).execute();
    return this.jobs.byIdempotencyKey(input.idempotencyKey);
  }
  public async markJobAttempt(id: string, now: Date = new Date()): Promise<void> { this.requireAffected(await this.transaction.updateTable('integration_jobs').set(({ eb }) => ({ status: 'RUNNING', attempt_count: eb('attempt_count', '+', 1), next_attempt_at: null, updated_at: now })).where('institution_id', '=', this.institutionId).where('id', '=', id).where('status', '=', 'PENDING').where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)])).executeTakeFirst()); }
  public async markJobSucceeded(id: string): Promise<void> { this.requireAffected(await this.transaction.updateTable('integration_jobs').set({ status: 'SUCCEEDED', updated_at: new Date() }).where('institution_id', '=', this.institutionId).where('id', '=', id).where('status', '=', 'RUNNING').executeTakeFirst()); }
  public async markJobFailed(id: string, error: string): Promise<void> { if (error.length > 4000) throw new DomainInvariantError('INVALID_JOB_ERROR', 'Integration job errors are limited to 4000 characters'); this.requireAffected(await this.transaction.updateTable('integration_jobs').set({ status: 'FAILED', last_error: error, updated_at: new Date() }).where('institution_id', '=', this.institutionId).where('id', '=', id).where('status', '=', 'RUNNING').executeTakeFirst()); }
  public async scheduleJobRetry(id: string, nextAttemptAt: Date): Promise<void> { this.requireAffected(await this.transaction.updateTable('integration_jobs').set({ status: 'PENDING', next_attempt_at: nextAttemptAt, updated_at: new Date() }).where('institution_id', '=', this.institutionId).where('id', '=', id).where('status', '=', 'FAILED').executeTakeFirst()); }
  private requireAffected(result: { readonly numUpdatedRows?: bigint | undefined }): void { if (result.numUpdatedRows === undefined || result.numUpdatedRows === 0n) throw new DomainInvariantError('INVALID_JOB_STATE', 'Integration job was not in the expected state'); }
}

export function tenantRepositories(transaction: DatabaseTransaction, institutionId: string): TenantRepositories { return new TenantRepositories(transaction, institutionId); }
