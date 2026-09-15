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

function client(fetch: AtomFetch): AtomClient { return new AtomClient({ baseUrl: 'https://atom.example.test///', apiKey: 'secret-key', culture: 'es', timeoutMs: 100, fetch }); }

describe('AtoM 2.10 adapter', () => {
  it('creates a File below the mapped parent without publishing it', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const atom = client((url, init) => {
      requests.push({ url: String(url), init });
      if (init?.method === 'GET' && String(url).includes('/series-77?')) return Promise.resolve(response(200, { id: 77, slug: 'series-77' }));
      if (init?.method === 'GET' && String(url).includes('/api/informationobjects?')) return Promise.resolve(response(200, { total: 0, results: [] }));
      return Promise.resolve(response(201, { id: 123, slug: 'exp-2026-000001', parent_id: 77, identifier: input.expedienteFolio, level_of_description: 'File' }));
    });
    const store = storeWithParent();
    const result = await ensureExpedienteFileDescription(atom, store, { ...input, title: ' expediente title ' });
    expect(result.created).toBe(true);
    expect(result.mapping.atomInformationObjectId).toBe('123');
    expect(requests).toHaveLength(3);
    expect(requests[0]?.init?.headers).toMatchObject({ 'REST-API-Key': 'secret-key' });
    const rawBody = requests[2]?.init?.body;
    if (typeof rawBody !== 'string') throw new Error('Expected JSON request body');
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).toMatchObject({ identifier: input.expedienteFolio, title: 'expediente title', level_of_description: 'File', parent_id: 77, parent_slug: 'series-77' });
    expect(body).not.toHaveProperty('published');
  });

  it('uses a synced mapping and performs no POST', async () => {
    const store = storeWithParent();
    store.values.set(`${institutionId}:${ATOM_OBJECT_TYPES.expediente}:${expedienteId}`, { institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: expedienteId, atomInformationObjectId: '123', atomSlug: 'exp-2026-000001', syncStatus: 'SYNCED' });
    let calls = 0;
    const atom = client((url) => { calls += 1; return Promise.resolve(String(url).includes('/series-77?') ? response(200, { id: 77, slug: 'series-77' }) : response(200, { id: 123, slug: 'exp-2026-000001', parent_id: 77, identifier: input.expedienteFolio, level_of_description: 'File' })); });
    const result = await ensureExpedienteFileDescription(atom, store, input);
    expect(result.created).toBe(false);
    expect(calls).toBe(2);
  });

  it('recovers a remote description after the local mapping was lost', async () => {
    const atom = client((url) => String(url).includes('/api/informationobjects?')
      ? Promise.resolve(response(200, { total: 1, results: [{ id: 123, slug: 'exp-2026-000001' }] }))
      : Promise.resolve(String(url).includes('/series-77?') ? response(200, { id: 77, slug: 'series-77' }) : response(200, { id: 123, slug: 'exp-2026-000001', parent_id: 77, identifier: input.expedienteFolio, level_of_description: 'File' })));
    const result = await ensureExpedienteFileDescription(atom, storeWithParent(), input);
    expect(result.created).toBe(false);
    expect(result.mapping.atomSlug).toBe('exp-2026-000001');
  });

  it('converges concurrent ensures when AtoM rejects the losing create', async () => {
    let creates = 0;
    const atom = client((url, init) => {
      if (init?.method === 'POST') {
        creates += 1;
        return Promise.resolve(creates === 1
          ? response(201, { id: 123, slug: 'exp-2026-000001', parent_id: 77, identifier: input.expedienteFolio, level_of_description: 'File' })
          : response(409, {}));
      }
      if (String(url).includes('/api/informationobjects?')) return Promise.resolve(response(200, { total: creates > 1 ? 1 : 0, results: creates > 1 ? [{ slug: 'exp-2026-000001' }] : [] }));
      if (String(url).includes('/series-77?')) return Promise.resolve(response(200, { id: 77, slug: 'series-77' }));
      return Promise.resolve(response(200, { id: 123, slug: 'exp-2026-000001', parent_id: 77, identifier: input.expedienteFolio, level_of_description: 'File' }));
    });
    const store = storeWithParent();
    const results = await Promise.all([ensureExpedienteFileDescription(atom, store, input), ensureExpedienteFileDescription(atom, store, input)]);
    expect(results.map((result) => result.mapping.atomInformationObjectId)).toEqual(['123', '123']);
    expect(creates).toBe(2);
  });

  it('fails closed for a wrong parent or missing parent mapping', async () => {
    const atom = client((url) => String(url).includes('/api/informationobjects?')
      ? Promise.resolve(response(200, { total: 1, results: [{ id: 123, slug: 'wrong-parent' }] }))
      : Promise.resolve(String(url).includes('/series-77?') ? response(200, { id: 77, slug: 'series-77' }) : response(200, { id: 123, slug: 'wrong-parent', parent_id: 999, identifier: input.expedienteFolio, level_of_description: 'File' })));
    await expect(ensureExpedienteFileDescription(atom, storeWithParent(), input)).rejects.toMatchObject({ kind: 'CONFLICT' });
    await expect(ensureExpedienteFileDescription(atom, new MemoryMappings(), input)).rejects.toMatchObject({ kind: 'MAPPING' });
  });

  it('maps authentication, remote, malformed response and timeout failures', async () => {
    await expect(client(() => Promise.resolve(response(401, {}))).getInformationObject('file')).rejects.toMatchObject({ kind: 'AUTHENTICATION', retryable: false });
    await expect(client(() => Promise.resolve(response(503, {}))).getInformationObject('file')).rejects.toMatchObject({ kind: 'REMOTE', retryable: true });
    await expect(client(() => Promise.resolve(response(200, { id: 'not-a-number', slug: 'file' }))).getInformationObject('file')).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    await expect(new AtomClient({ baseUrl: 'https://atom.example.test', apiKey: 'key', timeoutMs: 1, fetch: ((_, init) => new Promise<AtomHttpResponse>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) }).getInformationObject('file')).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });
});
