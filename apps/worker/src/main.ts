import { readWorkerConfig } from '@ici/config';
import { createArchivematicaTransferStore, createDatabase } from '@ici/database';
import { S3Client } from '@aws-sdk/client-s3';
import { S3DocumentStorage } from '@ici/integration-storage';
import { ClamdMalwareScanner } from '@ici/integration-malware';
import { AtomClient } from '@ici/integration-atom';
import { createArchivematicaService } from '@ici/integration-archivematica';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createArchiveTransferPollController, createMalwareScanPollController, integrationQueueName, processIntegrationJob, runArchiveTransferPreservationOnce, runMalwareScanOnce, type ArchiveTransferWorkerDependencies, type MalwareScanWorkerDependencies } from './jobs.js';
import { FilesystemPreservationTransferStager, PreservationInterventionRequired, ProductionPreservationExecution } from './preservation.js';

const config = readWorkerConfig();
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const worker = new Worker(integrationQueueName, processIntegrationJob, { connection });
const malwareDependencies: MalwareScanWorkerDependencies | undefined = config.databaseUrl !== undefined && config.clamavHost !== undefined && config.s3Endpoint !== undefined && config.s3AccessKeyId !== undefined && config.s3SecretAccessKey !== undefined && config.s3QuarantineBucket !== undefined && config.s3CleanBucket !== undefined
  ? { database: createDatabase(config.databaseUrl), storage: new S3DocumentStorage({ client: new S3Client({ endpoint: config.s3Endpoint, region: config.s3Region ?? 'us-east-1', forcePathStyle: config.s3ForcePathStyle ?? false, credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey } }), quarantineBucket: config.s3QuarantineBucket, cleanBucket: config.s3CleanBucket }), scanner: new ClamdMalwareScanner({ host: config.clamavHost, port: config.clamavPort ?? 3310, ...(config.clamavConnectTimeoutMs === undefined ? {} : { connectTimeoutMs: config.clamavConnectTimeoutMs }), ...(config.clamavReadTimeoutMs === undefined ? {} : { readTimeoutMs: config.clamavReadTimeoutMs }) }) }
  : undefined;
const preservationDependencies: ArchiveTransferWorkerDependencies | undefined = malwareDependencies !== undefined && config.atomBaseUrl !== undefined && config.atomApiKey !== undefined && config.atomDraftPolicy !== undefined && config.archivematica?.transferSourceRoot !== undefined
  ? (() => {
      const atom = new AtomClient({ baseUrl: config.atomBaseUrl, apiKey: config.atomApiKey, ...(config.atomCulture === undefined ? {} : { culture: config.atomCulture }), ...(config.atomRequestTimeoutMs === undefined ? {} : { timeoutMs: config.atomRequestTimeoutMs }), draftPolicy: config.atomDraftPolicy });
      const archivematica = createArchivematicaService(config.archivematica, createArchivematicaTransferStore(malwareDependencies.database));
      const stager = new FilesystemPreservationTransferStager(config.archivematica.transferSourceRoot, config.archivematica.transferSourceLocationUuid, malwareDependencies.storage);
      const preservation = new ProductionPreservationExecution({ database: malwareDependencies.database, cleanStorage: malwareDependencies.storage, atom, archivematica, stager, transferSourceLocationUuid: config.archivematica.transferSourceLocationUuid, verifyArchivalIntegration: ({ dipUuid }) => {
        // Archivematica's native AtoM DIP delivery is asynchronous. The
        // pinned public APIs do not expose a reliable correlation from this
        // DIP UUID to the child Item descriptions created below the target
        // File. Fail closed until that evidence is independently observable.
        return Promise.reject(new PreservationInterventionRequired(`Archivematica DIP ${dipUuid} was generated, but native AtoM delivery cannot be independently proven through the documented APIs`));
      } });
      return { database: malwareDependencies.database, preservation };
    })()
  : undefined;
const poller = malwareDependencies === undefined ? undefined : createMalwareScanPollController(
  () => runMalwareScanOnce(malwareDependencies, 10, new Date(), config.malwareLeaseSeconds ?? 300)
    .catch((error: unknown) => { console.error(JSON.stringify({ event: 'malware.poll_failed', message: error instanceof Error ? error.message : 'poll failed' })); }),
  config.malwarePollIntervalMs ?? 1000,
);
const preservationPoller = preservationDependencies === undefined ? undefined : createArchiveTransferPollController(
  () => runArchiveTransferPreservationOnce(preservationDependencies, 10, new Date(), config.malwareLeaseSeconds ?? 300)
    .catch((error: unknown) => { console.error(JSON.stringify({ event: 'archive_transfer.poll_failed', message: error instanceof Error ? error.message : 'poll failed' })); }),
  config.malwarePollIntervalMs ?? 1000,
);

worker.on('completed', (job) => {
  console.info(JSON.stringify({ event: 'job.completed', jobId: job.id, jobName: job.name }));
});
worker.on('failed', (job, error) => {
  console.error(JSON.stringify({ event: 'job.failed', jobId: job?.id, message: error.message }));
});

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ event: 'worker.shutdown', signal }));
  await preservationPoller?.stop();
  await poller?.stop();
  await worker.close();
  connection.disconnect();
  await malwareDependencies?.database.destroy();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
