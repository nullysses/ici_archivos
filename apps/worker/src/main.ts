import { readWorkerConfig } from '@ici/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { integrationQueueName, processIntegrationJob } from './jobs.js';

const config = readWorkerConfig();
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const worker = new Worker(integrationQueueName, processIntegrationJob, { connection });

worker.on('completed', (job) => {
  console.info(JSON.stringify({ event: 'job.completed', jobId: job.id, jobName: job.name }));
});
worker.on('failed', (job, error) => {
  console.error(JSON.stringify({ event: 'job.failed', jobId: job?.id, message: error.message }));
});

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ event: 'worker.shutdown', signal }));
  await worker.close();
  connection.disconnect();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
