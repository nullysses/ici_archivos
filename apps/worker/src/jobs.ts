import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { claimMalwareScanJobs, findMalwareScanTarget, recordMalwareScanResultAtomically, type Database } from '@ici/database';
import type { DocumentStoragePort } from '@ici/integration-storage';
import type { MalwareScannerPort } from '@ici/integration-malware';

export const integrationQueueName = 'ici-integrations';

export interface IntegrationJobData {
  readonly correlationId: string;
  readonly institutionId: string;
}

export function processIntegrationJob(job: Job<IntegrationJobData>): Promise<void> {
  if (job.name !== 'system.health') {
    return Promise.reject(new Error(`Unsupported integration job: ${job.name}`));
  }

  return Promise.resolve();
}

export interface MalwareScanWorkerDependencies {
  readonly database: Database;
  readonly storage: DocumentStoragePort;
  readonly scanner: MalwareScannerPort;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Malware scan failed';
  return message.slice(0, 4000);
}

/** Processes one claimed PostgreSQL job. PostgreSQL remains the source of truth; BullMQ is not required. */
export async function processClaimedMalwareScanJob(dependencies: MalwareScanWorkerDependencies, job: { readonly id: string; readonly institution_id: string; readonly aggregate_id: string; readonly correlation_id: string }): Promise<void> {
  const target = await findMalwareScanTarget(dependencies.database, { institutionId: job.institution_id, jobId: job.id, versionId: job.aggregate_id });
  if (target === undefined || target.status !== 'PENDING_SCAN') return;
  let result;
  try {
    const body = await dependencies.storage.open({ zone: 'QUARANTINE', key: target.storageKey });
    result = await dependencies.scanner.scan(body);
  } catch (error) {
    await recordMalwareScanResultAtomically(dependencies.database, { institutionId: job.institution_id, jobId: job.id, versionId: job.aggregate_id, scanId: randomUUID(), result: 'SCAN_FAILED', engine: 'clamd', error: boundedError(error), correlationId: job.correlation_id });
    return;
  }
  if (result.verdict === 'CLEAN') {
    try { await dependencies.storage.copy({ from: 'QUARANTINE', to: 'CLEAN', key: target.storageKey }); }
    catch (error) {
      await recordMalwareScanResultAtomically(dependencies.database, { institutionId: job.institution_id, jobId: job.id, versionId: job.aggregate_id, scanId: randomUUID(), result: 'SCAN_FAILED', engine: result.engine, ...(result.engineVersion === undefined ? {} : { engineVersion: result.engineVersion }), ...(result.signatureVersion === undefined ? {} : { signatureVersion: result.signatureVersion }), error: boundedError(error), correlationId: job.correlation_id });
      return;
    }
  }
  await recordMalwareScanResultAtomically(dependencies.database, { institutionId: job.institution_id, jobId: job.id, versionId: job.aggregate_id, scanId: randomUUID(), result: result.verdict, engine: result.engine, ...(result.engineVersion === undefined ? {} : { engineVersion: result.engineVersion }), ...(result.signatureVersion === undefined ? {} : { signatureVersion: result.signatureVersion }), correlationId: job.correlation_id });
  if (result.verdict === 'CLEAN') {
    try { await dependencies.storage.remove({ zone: 'QUARANTINE', key: target.storageKey }); } catch { /* cleanup is best effort */ }
  }
}

export async function runMalwareScanOnce(dependencies: MalwareScanWorkerDependencies, limit = 10, now = new Date()): Promise<number> {
  const institutions = await dependencies.database.selectFrom('institutions').select('id').where('status', '=', 'ACTIVE').execute();
  let processed = 0;
  for (const institution of institutions) {
    const jobs = await claimMalwareScanJobs(dependencies.database, institution.id, limit, now);
    for (const job of jobs) {
      await processClaimedMalwareScanJob(dependencies, job);
      processed += 1;
    }
  }
  return processed;
}
