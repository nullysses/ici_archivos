import type { Job } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
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

export interface MalwareScanPollController {
  trigger(): void;
  stop(): Promise<void>;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Malware scan failed';
  return message.slice(0, 4000);
}

/** Processes one claimed PostgreSQL job. PostgreSQL remains the source of truth; BullMQ is not required. */
export async function processClaimedMalwareScanJob(dependencies: MalwareScanWorkerDependencies, job: { readonly id: string; readonly institution_id: string; readonly aggregate_id: string; readonly correlation_id: string; readonly claim_token: string | null }): Promise<void> {
  if (job.claim_token === null) return;
  const target = await findMalwareScanTarget(dependencies.database, { institutionId: job.institution_id, jobId: job.id, claimToken: job.claim_token, versionId: job.aggregate_id });
  if (target === undefined || target.status !== 'PENDING_SCAN') return;
  let checkedStream: ReturnType<typeof integrityCheckedStream> | undefined;
  let result;
  try {
    const body = await dependencies.storage.open({ zone: 'QUARANTINE', key: target.storageKey });
    checkedStream = integrityCheckedStream(body, target.sizeBytes, target.sha256);
    result = await dependencies.scanner.scan(checkedStream.stream);
    await checkedStream.completion;
  } catch (error) {
    await checkedStream?.cancel(error);
    await checkedStream?.completion.catch(() => undefined);
    await recordMalwareScanResultAtomically(dependencies.database, { institutionId: job.institution_id, jobId: job.id, claimToken: job.claim_token, versionId: job.aggregate_id, scanId: randomUUID(), result: 'SCAN_FAILED', engine: 'clamd', error: boundedError(error), correlationId: job.correlation_id });
    return;
  }
  if (result.verdict === 'CLEAN') {
    try { await dependencies.storage.copy({ from: 'QUARANTINE', to: 'CLEAN', key: target.storageKey }); }
    catch (error) {
      await recordMalwareScanResultAtomically(dependencies.database, { institutionId: job.institution_id, jobId: job.id, claimToken: job.claim_token, versionId: job.aggregate_id, scanId: randomUUID(), result: 'SCAN_FAILED', engine: result.engine, ...(result.engineVersion === undefined ? {} : { engineVersion: result.engineVersion }), ...(result.signatureVersion === undefined ? {} : { signatureVersion: result.signatureVersion }), error: boundedError(error), correlationId: job.correlation_id });
      return;
    }
  }
  await recordMalwareScanResultAtomically(dependencies.database, { institutionId: job.institution_id, jobId: job.id, claimToken: job.claim_token, versionId: job.aggregate_id, scanId: randomUUID(), result: result.verdict, engine: result.engine, ...(result.engineVersion === undefined ? {} : { engineVersion: result.engineVersion }), ...(result.signatureVersion === undefined ? {} : { signatureVersion: result.signatureVersion }), correlationId: job.correlation_id });
  if (result.verdict === 'CLEAN') {
    try { await dependencies.storage.remove({ zone: 'QUARANTINE', key: target.storageKey }); } catch { /* cleanup is best effort */ }
  }
}

export async function runMalwareScanOnce(dependencies: MalwareScanWorkerDependencies, limit = 10, now = new Date(), leaseSeconds = 300): Promise<number> {
  const institutions = await dependencies.database.selectFrom('institutions').select('id').where('status', '=', 'ACTIVE').execute();
  let processed = 0;
  for (const institution of institutions) {
    const jobs = await claimMalwareScanJobs(dependencies.database, institution.id, limit, now, leaseSeconds);
    for (const job of jobs) {
      await processClaimedMalwareScanJob(dependencies, job);
      processed += 1;
    }
  }
  return processed;
}

class IntegrityMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IntegrityMismatchError';
  }
}

function integrityCheckedStream(body: ReadableStream<Uint8Array>, expectedSizeBytes: string, expectedSha256: string): { readonly stream: ReadableStream<Uint8Array>; readonly completion: Promise<void>; readonly cancel: (reason: unknown) => Promise<void> } {
  const hash = createHash('sha256');
  let size = 0n;
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: unknown) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += BigInt(chunk.byteLength);
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      const actualSize = size;
      const actualSha256 = hash.digest('hex');
      if (actualSize !== BigInt(expectedSizeBytes)) {
        const error = new IntegrityMismatchError(`Scanned object size ${actualSize.toString()} does not match expected size ${expectedSizeBytes}`);
        rejectCompletion?.(error);
        throw error;
      }
      if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        const error = new IntegrityMismatchError('Scanned object SHA-256 does not match the authoritative document version');
        rejectCompletion?.(error);
        throw error;
      }
      resolveCompletion?.();
    },
  }));
  return {
    stream,
    completion,
    async cancel(reason: unknown): Promise<void> {
      rejectCompletion?.(reason);
      try { await stream.cancel(reason); } catch { /* stream may already be errored or locked by the scanner */ }
    },
  };
}

export function createMalwareScanPollController(run: () => Promise<unknown>, intervalMs: number): MalwareScanPollController {
  let stopped = false;
  let active: Promise<unknown> | undefined;
  const trigger = (): void => {
    if (stopped || active !== undefined) return;
    const current = run().finally(() => { if (active === current) active = undefined; });
    active = current;
  };
  const timer: ReturnType<typeof setInterval> = setInterval(trigger, intervalMs);
  return {
    trigger,
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      await active;
    },
  };
}
