import type { Job } from 'bullmq';

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
