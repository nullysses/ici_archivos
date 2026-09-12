import { describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { createMalwareScanPollController, processIntegrationJob, type IntegrationJobData } from './jobs.js';

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

describe('malware polling shutdown', () => {
  it('waits for an active poll before stopping', async () => {
    let release: (() => void) | undefined;
    let started = false;
    const work = new Promise<void>((resolve) => { release = resolve; });
    const controller = createMalwareScanPollController(async () => { started = true; await work; }, 60_000);
    controller.trigger();
    expect(started).toBe(true);
    let stopped = false;
    const stopping = controller.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});
