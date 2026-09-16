import { describe, expect, it } from 'vitest';
import {
  ATOM_OBJECT_TYPES,
  AtomClient,
  ensureExpedienteFileDescription,
  type AtomFetch,
  type AtomHttpResponse,
  type AtomMappingRecord,
  type AtomMappingStore,
} from './index.js';

const institutionId = '10000000-0000-4000-8000-000000000001';
const expedienteId = '20000000-0000-4000-8000-000000000001';
const parentId = '30000000-0000-4000-8000-000000000001';
const input = { institutionId, expedienteId, expedienteFolio: 'EXP-2026-000001', archivalParentNodeId: parentId };

function response(status: number, body: unknown): AtomHttpResponse {
  return { status, headers: new Headers({ 'content-type': 'application/json' }), json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

class MemoryMappings implements AtomMappingStore {
  public readonly values = new Map<string, AtomMappingRecord>();

  public find(key: { readonly institutionId: string; readonly iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE' | 'EXPEDIENTE'; readonly iciObjectId: string }): Promise<AtomMappingRecord | undefined> {
    return Promise.resolve(this.values.get(`${key.institutionId}:${key.iciObjectType}:${key.iciObjectId}`));
  }

  public reserve(key: { readonly institutionId: string; readonly iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE' | 'EXPEDIENTE'; readonly iciObjectId: string }): Promise<{ readonly record: AtomMappingRecord; readonly reserved: boolean }> {
    const mapKey = `${key.institutionId}:${key.iciObjectType}:${key.iciObjectId}`;
    const existing = this.values.get(mapKey);
    if (existing !== undefined) return Promise.resolve({ record: existing, reserved: false });
    const record: AtomMappingRecord = { ...key, atomInformationObjectId: null, atomSlug: null, syncStatus: 'PENDING' };
    this.values.set(mapKey, record);
    return Promise.resolve({ record, reserved: true });
  }

  public save(value: { readonly institutionId: string; readonly iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE' | 'EXPEDIENTE'; readonly iciObjectId: string; readonly atomInformationObjectId: string; readonly atomSlug: string; readonly syncStatus: 'SYNCED' | 'FAILED' }): Promise<AtomMappingRecord> {
    const result: AtomMappingRecord = { ...value };
    this.values.set(`${value.institutionId}:${value.iciObjectType}:${value.iciObjectId}`, result);
    return Promise.resolve(result);
  }
}

function storeWithParent(): MemoryMappings {
  const store = new MemoryMappings();
  store.values.set(`${institutionId}:${ATOM_OBJECT_TYPES.archivalClassificationNode}:${parentId}`, { institutionId, iciObjectType: ATOM_OBJECT_TYPES.archivalClassificationNode, iciObjectId: parentId, atomInformationObjectId: '77', atomSlug: 'series-77', syncStatus: 'SYNCED' });
  return store;
}

function client(fetch: AtomFetch): AtomClient { return new AtomClient({ baseUrl: 'https://atom.example.test///', apiKey: 'secret-key', culture: 'es', timeoutMs: 100, draftPolicy: 'SERVICE_ACCOUNT_NO_PUBLISH', fetch }); }

describe('AtoM 2.10 adapter', () => {
  it('creates a File below the mapped parent without publishing it', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const atom = client((url, init) => {
      requests.push({ url: String(url), init });
      if (init?.method === 'GET' && String(url).includes('/series-77?')) return Promise.resolve(response(200, { title: 'Series 77', level_of_description: 'Series' }));
      return Promise.resolve(response(201, { id: 123, slug: 'exp-2026-000001' }));
    });
    const store = storeWithParent();
    const result = await ensureExpedienteFileDescription(atom, store, { ...input, title: ' expediente title ' });
    expect(result.created).toBe(true);
    expect(result.mapping.atomInformationObjectId).toBe('123');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.init?.headers).toMatchObject({ 'REST-API-Key': 'secret-key' });
    const rawBody = requests[1]?.init?.body;
    if (typeof rawBody !== 'string') throw new Error('Expected JSON request body');
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).toMatchObject({ identifier: input.expedienteFolio, title: 'expediente title', level_of_description: 'File', parent_id: 77, parent_slug: 'series-77' });
    expect(body).not.toHaveProperty('published');
  });

  it('uses a synced mapping and performs no POST', async () => {
    const store = storeWithParent();
    store.values.set(`${institutionId}:${ATOM_OBJECT_TYPES.expediente}:${expedienteId}`, { institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: expedienteId, atomInformationObjectId: '123', atomSlug: 'exp-2026-000001', syncStatus: 'SYNCED' });
    let calls = 0;
    const atom = client((url) => { calls += 1; return Promise.resolve(String(url).includes('/series-77?') ? response(200, { title: 'Series 77', level_of_description: 'Series' }) : response(200, { title: 'File', level_of_description: 'File' })); });
    const result = await ensureExpedienteFileDescription(atom, store, input);
    expect(result.created).toBe(false);
    expect(calls).toBe(2);
  });

  it('fails closed when a previous remote create cannot be reconciled', async () => {
    const store = storeWithParent();
    store.values.set(`${institutionId}:${ATOM_OBJECT_TYPES.expediente}:${expedienteId}`, { institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: expedienteId, atomInformationObjectId: null, atomSlug: null, syncStatus: 'PENDING' });
    let posts = 0;
    const atom = client((_, init) => { if (init?.method === 'POST') posts += 1; return Promise.resolve(response(200, { title: 'Series 77', level_of_description: 'Series' })); });
    await expect(ensureExpedienteFileDescription(atom, store, input)).rejects.toMatchObject({ code: 'ATOM_RECONCILIATION_REQUIRED' });
    expect(posts).toBe(0);
  });

  it('allows only one local reservation for concurrent creates', async () => {
    let creates = 0;
    const atom = client((url, init) => { if (init?.method === 'POST') { creates += 1; return Promise.resolve(response(201, { id: 123, slug: 'exp-2026-000001' })); } return Promise.resolve(String(url).includes('/series-77?') ? response(200, { title: 'Series 77', level_of_description: 'Series' }) : response(200, { title: 'File', level_of_description: 'File' })); });
    const store = storeWithParent();
    const results = await Promise.allSettled([ensureExpedienteFileDescription(atom, store, input), ensureExpedienteFileDescription(atom, store, input)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'ATOM_RECONCILIATION_REQUIRED' } });
    expect(creates).toBe(1);
  });

  it('fails closed for a wrong parent or missing parent mapping', async () => {
    const store = storeWithParent();
    store.values.set(`${institutionId}:${ATOM_OBJECT_TYPES.expediente}:${expedienteId}`, { institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: expedienteId, atomInformationObjectId: '123', atomSlug: 'wrong-parent', syncStatus: 'SYNCED' });
    const atom = client((url) => String(url).includes('/series-77?') ? Promise.resolve(response(200, { title: 'Series 77', level_of_description: 'Series' })) : Promise.resolve(response(200, { title: 'Wrong', level_of_description: 'Series' })));
    await expect(ensureExpedienteFileDescription(atom, store, input)).rejects.toMatchObject({ kind: 'CONFLICT' });
    await expect(ensureExpedienteFileDescription(atom, new MemoryMappings(), input)).rejects.toMatchObject({ kind: 'MAPPING' });
  });

  it('maps authentication, remote, malformed response and timeout failures', async () => {
    await expect(client(() => Promise.resolve(response(401, {}))).getInformationObject('file')).rejects.toMatchObject({ kind: 'AUTHENTICATION', retryable: false });
    await expect(client(() => Promise.resolve(response(503, {}))).getInformationObject('file')).rejects.toMatchObject({ kind: 'REMOTE', retryable: true });
    await expect(client(() => Promise.resolve(response(200, null))).getInformationObject('file')).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    await expect(new AtomClient({ baseUrl: 'https://atom.example.test', apiKey: 'key', timeoutMs: 1, draftPolicy: 'SERVICE_ACCOUNT_NO_PUBLISH', fetch: ((_, init) => new Promise<AtomHttpResponse>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) }).getInformationObject('file')).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('fails closed if AtoM reports a published create despite the deployment policy', async () => {
    const atom = client((_, init) => init?.method === 'POST' ? Promise.resolve(response(201, { id: 123, slug: 'published-file', publication_status: 'published' })) : Promise.resolve(response(200, { level_of_description: 'Series' })));
    await expect(ensureExpedienteFileDescription(atom, storeWithParent(), input)).rejects.toMatchObject({ kind: 'RECONCILIATION_REQUIRED', code: 'ATOM_RECONCILIATION_REQUIRED' });
  });
});
