import { describe, expect, it } from 'vitest';
import {
  ArchivematicaAdapterError,
  ArchivematicaDashboardClient,
  ArchivematicaPreservationService,
  ArchivematicaStorageServiceClient,
  createInMemoryArchivematicaStore,
  type ArchivematicaConfig,
  type ArchivematicaFetch,
  type ArchivematicaFetchResponse,
} from './index.js';

const transferUuid = '11111111-1111-4111-8111-111111111111';
const sipUuid = '22222222-2222-4222-8222-222222222222';
const aipUuid = '33333333-3333-4333-8333-333333333333';
const dipUuid = '66666666-6666-4666-8666-666666666666';
const pipelineUuid = '44444444-4444-4444-8444-444444444444';
const locationUuid = '55555555-5555-4555-8555-555555555555';
const config: ArchivematicaConfig = { baseUrl: 'https://dashboard.example///', username: 'ici', apiKey: 'secret', storageBaseUrl: 'https://storage.example', storageUsername: 'ici-ss', storageApiKey: 'storage-secret', pipelineUuid, transferSourceLocationUuid: locationUuid, processingConfiguration: 'automated', requestTimeoutMs: 100, storageRequestTimeoutMs: 100 };

function response(status: number, body: unknown, contentType = 'application/json'): ArchivematicaFetchResponse { const text = typeof body === 'string' ? body : JSON.stringify(body); return { status, headers: new Headers({ 'content-type': contentType }), json: () => Promise.resolve(body), text: () => Promise.resolve(text) }; }
function validFetch(overrides: (url: string, init: RequestInit | undefined) => ArchivematicaFetchResponse | undefined = () => undefined): ArchivematicaFetch {
  return (url, init) => Promise.resolve(overrides(String(url), init) ?? (String(url).includes('/api/v2/pipeline/') ? response(200, { uuid: pipelineUuid }) : String(url).includes('/api/v2/location/') ? response(200, { uuid: locationUuid, purpose: 'TS', enabled: true, pipeline: [`/api/v2/pipeline/${pipelineUuid}/`] }) : String(url).includes('/api/processing-configuration/') ? response(200, '<processingMCP/>', 'text/xml') : String(url).includes('/api/v2beta/package') ? response(202, { id: transferUuid }) : response(200, { uuid: transferUuid, status: 'PROCESSING' })));
}

describe('Archivematica 1.18 / Storage Service 0.24 adapter', () => {
  it('uses API-key auth and beta package payload with encoded transfer source', async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const dashboard = new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch: validFetch((url, init) => { if (url.includes('/api/v2beta/package')) { request = { url, init }; return response(202, { id: transferUuid }); } return undefined; }) });
    const result = await dashboard.startTransfer({ name: 'ici-transfer', accession: 'archive-1', source: { locationUuid, relativePath: 'folder/file' }, processingConfiguration: 'automated' });
    expect(result.transferUuid).toBe(transferUuid);
    expect(request?.init?.headers).toMatchObject({ Authorization: 'ApiKey ici:secret', 'Content-Type': 'application/json' });
    const rawBody = request?.init?.body;
    if (typeof rawBody !== 'string') throw new Error('Expected JSON body');
    expect(JSON.parse(rawBody)).toMatchObject({ name: 'ici-transfer', accession: 'archive-1', processing_config: 'automated', path: Buffer.from(`${locationUuid}:folder/file`).toString('base64'), auto_approve: true });
  });

  it('validates transfer source and processing configuration before submission', async () => {
    const store = createInMemoryArchivematicaStore();
    const service = new ArchivematicaPreservationService(config, new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch: validFetch() }), new ArchivematicaStorageServiceClient({ baseUrl: config.storageBaseUrl, username: config.storageUsername, apiKey: config.storageApiKey, fetch: validFetch() }), store);
    await expect(service.submit({ institutionId: 'institution-a', archiveTransferId: 'archive-1', source: { locationUuid, relativePath: 'transfer' } })).resolves.toMatchObject({ submissionStatus: 'SUBMITTED', archivematicaTransferUuid: transferUuid });
    await expect(service.submit({ institutionId: 'institution-a', archiveTransferId: 'archive-1', source: { locationUuid, relativePath: 'transfer' } })).resolves.toMatchObject({ archivematicaTransferUuid: transferUuid });
    await expect(service.submit({ institutionId: 'institution-a', archiveTransferId: 'archive-2', source: { locationUuid: pipelineUuid, relativePath: 'transfer' } })).rejects.toMatchObject({ kind: 'CONFIGURATION' });
  });

  it('fails closed on unresolved submission and does not submit twice', async () => {
    let posts = 0;
    const fetch = validFetch((url) => { if (url.includes('/api/v2beta/package')) { posts += 1; return response(200, { id: transferUuid }); } return undefined; });
    const store = createInMemoryArchivematicaStore();
    const service = new ArchivematicaPreservationService(config, new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch }), new ArchivematicaStorageServiceClient({ baseUrl: config.storageBaseUrl, username: config.storageUsername, apiKey: config.storageApiKey, fetch }), store);
    const first = await service.submit({ institutionId: 'institution-a', archiveTransferId: 'archive-1', source: { locationUuid, relativePath: 'transfer' } });
    expect(first.archivematicaTransferUuid).toBe(transferUuid);
    await expect(service.submit({ institutionId: 'institution-a', archiveTransferId: 'archive-1', source: { locationUuid, relativePath: 'transfer' } })).resolves.toMatchObject({ archivematicaTransferUuid: transferUuid });
    expect(posts).toBe(1);
  });

  it('does not treat COMPLETE without SIP or ingest COMPLETE as stored', async () => {
    const store = createInMemoryArchivematicaStore();
    const fetch = validFetch((url) => url.includes('/api/transfer/status/') ? response(200, { uuid: transferUuid, status: 'COMPLETE' }) : undefined);
    const service = new ArchivematicaPreservationService(config, new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch }), new ArchivematicaStorageServiceClient({ baseUrl: config.storageBaseUrl, username: config.storageUsername, apiKey: config.storageApiKey, fetch }), store);
    await store.reserve({ institutionId: 'institution-a', archiveTransferId: 'archive-1', processingConfiguration: 'automated', transferSourceLocationUuid: locationUuid, transferSourceRelativePath: 'transfer' });
    await expect(service.observeTransfer({ institutionId: 'institution-a', archiveTransferId: 'archive-1', transferUuid })).resolves.toMatchObject({ state: 'transferring' });
  });

  it('requires authoritative AIP Storage Service evidence', async () => {
    const store = createInMemoryArchivematicaStore();
    const fetch = validFetch((url) => url.includes(`/api/v2/file/${sipUuid}/`)
      ? response(200, { uuid: sipUuid, package_type: 'AIP', status: 'UPLOADED' })
      : undefined);
    const service = new ArchivematicaPreservationService(config, new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch }), new ArchivematicaStorageServiceClient({ baseUrl: config.storageBaseUrl, username: config.storageUsername, apiKey: config.storageApiKey, fetch }), store);
    await store.reserve({ institutionId: 'institution-a', archiveTransferId: 'archive-1', processingConfiguration: 'automated', transferSourceLocationUuid: locationUuid, transferSourceRelativePath: 'transfer' });
    await store.saveObservation({ institutionId: 'institution-a', archiveTransferId: 'archive-1', sipUuid });
    await expect(service.verifyAip({ institutionId: 'institution-a', archiveTransferId: 'archive-1', transferUuid, sipUuid, aipUuid: sipUuid })).resolves.toMatchObject({ state: 'aip_stored', aipUuid: sipUuid });
    await expect(service.discoverDip({ institutionId: 'institution-a', archiveTransferId: 'archive-1', transferUuid, sipUuid, aipUuid: sipUuid })).rejects.toMatchObject({ code: 'DIP_NOT_PROVABLE' });
  });

  it('accepts VERIFIED AIP state and resolves DIP resource URI relations', async () => {
    const store = createInMemoryArchivematicaStore();
    const fetch = validFetch((url) => url.includes(`/api/v2/file/${sipUuid}/`)
      ? response(200, { uuid: sipUuid, package_type: 'AIP', status: 'VERIFIED', related_packages: [`/api/v2/file/${dipUuid}/`] })
      : url.includes(`/api/v2/file/${dipUuid}/`)
        ? response(200, { uuid: dipUuid, package_type: 'DIP', status: 'UPLOADED' })
        : undefined);
    const service = new ArchivematicaPreservationService(config, new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch }), new ArchivematicaStorageServiceClient({ baseUrl: config.storageBaseUrl, username: config.storageUsername, apiKey: config.storageApiKey, fetch }), store);
    await store.reserve({ institutionId: 'institution-a', archiveTransferId: 'archive-1', processingConfiguration: 'automated', transferSourceLocationUuid: locationUuid, transferSourceRelativePath: 'transfer' });
    await store.saveObservation({ institutionId: 'institution-a', archiveTransferId: 'archive-1', sipUuid });
    await expect(service.verifyAip({ institutionId: 'institution-a', archiveTransferId: 'archive-1', transferUuid, sipUuid, aipUuid: sipUuid })).resolves.toMatchObject({ state: 'aip_stored' });
    await expect(service.discoverDip({ institutionId: 'institution-a', archiveTransferId: 'archive-1', transferUuid, sipUuid, aipUuid: sipUuid })).resolves.toMatchObject({ state: 'dip_uploaded', dipUuid });
  });

  it('rejects an AIP identity that differs from the authoritative SIP', async () => {
    const store = createInMemoryArchivematicaStore();
    const service = new ArchivematicaPreservationService(config, new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch: validFetch() }), new ArchivematicaStorageServiceClient({ baseUrl: config.storageBaseUrl, username: config.storageUsername, apiKey: config.storageApiKey, fetch: validFetch() }), store);
    await store.reserve({ institutionId: 'institution-a', archiveTransferId: 'archive-1', processingConfiguration: 'automated', transferSourceLocationUuid: locationUuid, transferSourceRelativePath: 'transfer' });
    await store.saveObservation({ institutionId: 'institution-a', archiveTransferId: 'archive-1', sipUuid });
    await expect(service.verifyAip({ institutionId: 'institution-a', archiveTransferId: 'archive-1', transferUuid, sipUuid, aipUuid })).rejects.toMatchObject({ code: 'ARCHIVEMATICA_AIP_SIP_MISMATCH', kind: 'CONFLICT' });
  });

  it('rejects a caller SIP/AIP pair that differs from the persisted SIP', async () => {
    const store = createInMemoryArchivematicaStore();
    const service = new ArchivematicaPreservationService(config, new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch: validFetch() }), new ArchivematicaStorageServiceClient({ baseUrl: config.storageBaseUrl, username: config.storageUsername, apiKey: config.storageApiKey, fetch: validFetch() }), store);
    await store.reserve({ institutionId: 'institution-a', archiveTransferId: 'archive-1', processingConfiguration: 'automated', transferSourceLocationUuid: locationUuid, transferSourceRelativePath: 'transfer' });
    await store.saveObservation({ institutionId: 'institution-a', archiveTransferId: 'archive-1', sipUuid });
    await expect(service.verifyAip({ institutionId: 'institution-a', archiveTransferId: 'archive-1', transferUuid, sipUuid: aipUuid, aipUuid })).rejects.toMatchObject({ code: 'ARCHIVEMATICA_IDENTITY_CONFLICT', kind: 'CONFLICT' });
  });

  it('does not resubmit after remote success when local persistence fails', async () => {
    let posts = 0;
    const fetch = validFetch((url) => { if (url.includes('/api/v2beta/package')) { posts += 1; return response(202, { id: transferUuid }); } return undefined; });
    const base = createInMemoryArchivematicaStore();
    let failPersistence = true;
    const store = { ...base, saveSubmission: async (input: Parameters<typeof base.saveSubmission>[0]) => { if (failPersistence) { failPersistence = false; throw new Error('database unavailable'); } return base.saveSubmission(input); } };
    const service = new ArchivematicaPreservationService(config, new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch }), new ArchivematicaStorageServiceClient({ baseUrl: config.storageBaseUrl, username: config.storageUsername, apiKey: config.storageApiKey, fetch }), store);
    await expect(service.submit({ institutionId: 'institution-a', archiveTransferId: 'archive-1', source: { locationUuid, relativePath: 'transfer' } })).rejects.toThrow('database unavailable');
    await expect(service.submit({ institutionId: 'institution-a', archiveTransferId: 'archive-1', source: { locationUuid, relativePath: 'transfer' } })).rejects.toMatchObject({ code: 'ARCHIVEMATICA_RECONCILIATION_REQUIRED' });
    expect(posts).toBe(1);
  });

  it('maps authentication and malformed responses without exposing credentials', async () => {
    const dashboard = new ArchivematicaDashboardClient({ baseUrl: config.baseUrl, username: config.username, apiKey: config.apiKey, fetch: () => Promise.resolve(response(401, { detail: 'secret' })) });
    const error = await dashboard.getTransferStatus(transferUuid).catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: 'AUTHENTICATION', retryable: false });
    expect(String(error)).not.toContain('secret');
    const malformed = new ArchivematicaStorageServiceClient({ baseUrl: config.storageBaseUrl, username: config.storageUsername, apiKey: config.storageApiKey, fetch: () => Promise.resolve(response(200, { uuid: 'bad', package_type: 'AIP', status: 'UPLOADED' })) });
    await expect(malformed.getPackage(aipUuid)).rejects.toBeInstanceOf(ArchivematicaAdapterError);
  });
});
