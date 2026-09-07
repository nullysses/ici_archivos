import { describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { processIntegrationJob, type IntegrationJobData } from './jobs.js';

function jobNamed(name: string): Job<IntegrationJobData> {
  return { name } as Job<IntegrationJobData>;
}

describe('processIntegrationJob', () => {
  it('accepts the internal health job', async () => {
    await expect(processIntegrationJob(jobNamed('system.health'))).resolves.toBeUndefined();
  });

  it('rejects unknown jobs', async () => {
    await expect(processIntegrationJob(jobNamed('unknown'))).rejects.toThrow('Unsupported integration job');
  });
});
