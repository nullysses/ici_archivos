import { describe, expect, it } from 'vitest';
import {
  ATOM_OBJECT_TYPES,
  AtomClient,
  atomLevelForClassificationNodeType,
  ensureAtomClassificationHierarchy,
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
  it('maps ICI classification types to documented AtoM levels', () => {
    expect(atomLevelForClassificationNodeType('FONDS')).toBe('Fonds');
    expect(atomLevelForClassificationNodeType('SECTION')).toBe('Section');
    expect(atomLevelForClassificationNodeType('SERIES')).toBe('Series');
    expect(atomLevelForClassificationNodeType('SUBSERIES')).toBe('Subseries');
  });

  it('ensures a Fonds-to-Subseries path parent-first with no fabricated root parent', async () => {
    const fonds = { id: 'f', institutionId, parentId: null, nodeType: 'FONDS' as const, code: 'F', name: 'Fonds' };
    const section = { id: 's', institutionId, parentId: 'f', nodeType: 'SECTION' as const, code: 'S', name: 'Section' };
    const series = { id: 'r', institutionId, parentId: 's', nodeType: 'SERIES' as const, code: 'R', name: 'Series' };
    const subseries = { id: 'ss', institutionId, parentId: 'r', nodeType: 'SUBSERIES' as const, code: 'SS', name: 'Subseries' };
    const store = new MemoryMappings();
    const requests: Array<{ method: string | undefined; body: Record<string, unknown> | undefined }> = [];
    const atom = client((_, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ method: init?.method, body });
      return Promise.resolve(response(201, { id: requests.length, slug: `node-${requests.length}` }));
    });
    const result = await ensureAtomClassificationHierarchy(atom, store, { load: () => Promise.resolve([fonds, section, series, subseries]) }, { institutionId, targetNodeId: 'ss' });
    expect(requests.map((request) => request.body?.level_of_description)).toEqual(['Fonds', 'Section', 'Series', 'Subseries']);
    expect(requests[0]?.body).not.toHaveProperty('parent_id');
    expect(requests[1]?.body).toMatchObject({ parent_id: 1, parent_slug: 'node-1' });
    expect(requests[3]?.body).toMatchObject({ parent_id: 3, parent_slug: 'node-3' });
    expect(result.target.atomSlug).toBe('node-4');
    expect(result.mappings).toHaveLength(4);
  });

  it('stops before network I/O when a path has an invalid parent type', async () => {
    let calls = 0;
    const atom = client(() => { calls += 1; return Promise.resolve(response(201, { id: 1, slug: 'unexpected' })); });
    const invalid = [{ id: 'f', institutionId, parentId: null, nodeType: 'FONDS' as const, code: 'F', name: 'Fonds' }, { id: 'r', institutionId, parentId: 'f', nodeType: 'SERIES' as const, code: 'R', name: 'Series' }];
    await expect(ensureAtomClassificationHierarchy(atom, storeWithParent(), { load: () => Promise.resolve(invalid) }, { institutionId, targetNodeId: 'r' })).rejects.toMatchObject({ kind: 'MAPPING' });
    expect(calls).toBe(0);
    expect(invalid).toHaveLength(2);
  });

  it('reuses synced ancestors and rejects an incomplete reservation without POST', async () => {
    const fonds = { id: 'f2', institutionId, parentId: null, nodeType: 'FONDS' as const, code: 'F2', name: 'Fonds 2' };
    const section = { id: 's2', institutionId, parentId: 'f2', nodeType: 'SECTION' as const, code: 'S2', name: 'Section 2' };
    const series = { id: 'r2', institutionId, parentId: 's2', nodeType: 'SERIES' as const, code: 'R2', name: 'Series 2' };
    const store = new MemoryMappings();
    store.values.set(`${institutionId}:${ATOM_OBJECT_TYPES.archivalClassificationNode}:f2`, { institutionId, iciObjectType: ATOM_OBJECT_TYPES.archivalClassificationNode, iciObjectId: 'f2', atomInformationObjectId: '11', atomSlug: 'f2', syncStatus: 'SYNCED' });
    store.values.set(`${institutionId}:${ATOM_OBJECT_TYPES.archivalClassificationNode}:s2`, { institutionId, iciObjectType: ATOM_OBJECT_TYPES.archivalClassificationNode, iciObjectId: 's2', atomInformationObjectId: '12', atomSlug: 's2', syncStatus: 'SYNCED' });
    store.values.set(`${institutionId}:${ATOM_OBJECT_TYPES.archivalClassificationNode}:r2`, { institutionId, iciObjectType: ATOM_OBJECT_TYPES.archivalClassificationNode, iciObjectId: 'r2', atomInformationObjectId: null, atomSlug: null, syncStatus: 'PENDING' });
    let posts = 0;
    const atom = client((url, init) => { if (init?.method === 'POST') posts += 1; const path = String(url); return Promise.resolve(response(200, { level_of_description: path.includes('/f2') ? 'Fonds' : 'Section' })); });
    await expect(ensureAtomClassificationHierarchy(atom, store, { load: () => Promise.resolve([fonds, section, series]) }, { institutionId, targetNodeId: 'r2' })).rejects.toMatchObject({ code: 'ATOM_RECONCILIATION_REQUIRED' });
    expect(posts).toBe(0);
  });
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
