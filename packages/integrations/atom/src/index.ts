/** Vendor-neutral reference returned by AtoM. IDs are decimal strings so the
 * adapter never loses precision at the JavaScript/PostgreSQL boundary. */
export interface AtomInformationObjectReference {
  readonly id: string;
  readonly slug: string;
}

export type AtomObjectType = 'ARCHIVAL_CLASSIFICATION_NODE' | 'EXPEDIENTE';

export const ATOM_SUPPORTED_VERSION = '2.10.2' as const;

export const ATOM_OBJECT_TYPES = {
  archivalClassificationNode: 'ARCHIVAL_CLASSIFICATION_NODE',
  expediente: 'EXPEDIENTE',
} as const satisfies Record<string, AtomObjectType>;

export interface AtomMappingRecord {
  readonly institutionId: string;
  readonly iciObjectType: AtomObjectType;
  readonly iciObjectId: string;
  readonly atomInformationObjectId: string | null;
  readonly atomSlug: string | null;
  readonly syncStatus: 'PENDING' | 'SYNCED' | 'FAILED';
}

export interface AtomMappingStore {
  find(input: { readonly institutionId: string; readonly iciObjectType: AtomObjectType; readonly iciObjectId: string }): Promise<AtomMappingRecord | undefined>;
  save(input: {
    readonly institutionId: string;
    readonly iciObjectType: AtomObjectType;
    readonly iciObjectId: string;
    readonly atomInformationObjectId: string;
    readonly atomSlug: string;
    readonly syncStatus: 'SYNCED' | 'FAILED';
  }): Promise<AtomMappingRecord>;
  markFailed?(input: { readonly institutionId: string; readonly iciObjectType: AtomObjectType; readonly iciObjectId: string }): Promise<AtomMappingRecord>;
}

export interface AtomHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type AtomFetch = (input: string | URL, init?: RequestInit) => Promise<AtomHttpResponse>;

export type AtomErrorKind =
  | 'AUTHENTICATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'REMOTE'
  | 'INVALID_RESPONSE'
  | 'MAPPING';

export class AtomAdapterError extends Error {
  public readonly kind: AtomErrorKind;
  public readonly status: number | undefined;
  public readonly retryable: boolean;

  public constructor(kind: AtomErrorKind, message: string, options: { readonly status?: number; readonly retryable?: boolean } = {}) {
    super(message);
    this.name = 'AtomAdapterError';
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? (kind === 'TIMEOUT' || kind === 'NETWORK' || kind === 'REMOTE');
  }
}

export interface AtomClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly culture?: string;
  readonly timeoutMs?: number;
  readonly fetch?: AtomFetch;
}

export interface AtomCreateInformationObjectInput {
  readonly identifier: string;
  readonly title: string;
  readonly parent: AtomInformationObjectReference;
  readonly levelOfDescription: 'File';
}

export interface AtomInformationObjectDetails extends AtomInformationObjectReference {
  readonly id: string;
  readonly slug: string;
  readonly parentId?: string | undefined;
  readonly parentSlug?: string | undefined;
  readonly identifier?: string | undefined;
  readonly levelOfDescription?: string | undefined;
}

export interface AtomBrowseInformationObject {
  readonly slug: string;
  readonly identifier?: string | undefined;
}

interface AtomBrowseResult {
  readonly total: number;
  readonly results: readonly AtomBrowseInformationObject[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new AtomAdapterError('MAPPING', 'AtoM base URL is required', { retryable: false });
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new AtomAdapterError('MAPPING', 'AtoM base URL is invalid', { retryable: false }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AtomAdapterError('MAPPING', 'AtoM base URL must use HTTP or HTTPS', { retryable: false });
  return `${url.toString().replace(/\/+$/, '')}/`;
}

function normalizeDecimalId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value.replace(/^0+(?=\d)/, '');
  throw new AtomAdapterError('INVALID_RESPONSE', 'AtoM returned an invalid information-object id', { retryable: false });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new AtomAdapterError('INVALID_RESPONSE', `AtoM response is missing ${field}`, { retryable: false });
  return value;
}

function parseReference(value: unknown): AtomInformationObjectDetails {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AtomAdapterError('INVALID_RESPONSE', 'AtoM response must be an object', { retryable: false });
  const object = value as Record<string, unknown>;
  const parentId = object.parent_id;
  const parentSlug = object.parent_slug;
  return {
    id: normalizeDecimalId(object.id),
    slug: requiredString(object.slug, 'slug'),
    ...(parentId === undefined || parentId === null ? {} : { parentId: normalizeDecimalId(parentId) }),
    ...(parentSlug === undefined || parentSlug === null ? {} : { parentSlug: requiredString(parentSlug, 'parent_slug') }),
    ...(typeof object.identifier === 'string' ? { identifier: object.identifier } : {}),
    ...(typeof object.level_of_description === 'string' ? { levelOfDescription: object.level_of_description } : {}),
  };
}

function parseBrowse(value: unknown): AtomBrowseResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AtomAdapterError('INVALID_RESPONSE', 'AtoM browse response must be an object', { retryable: false });
  const object = value as Record<string, unknown>;
  if (typeof object.total !== 'number' || !Number.isInteger(object.total) || !Array.isArray(object.results)) throw new AtomAdapterError('INVALID_RESPONSE', 'AtoM browse response has an invalid shape', { retryable: false });
  const results = object.results.map((entry): AtomBrowseInformationObject => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new AtomAdapterError('INVALID_RESPONSE', 'AtoM browse result must be an object', { retryable: false });
    const result = entry as Record<string, unknown>;
    return { slug: requiredString(result.slug, 'slug'), ...(typeof result.identifier === 'string' ? { identifier: result.identifier } : {}) };
  });
  return { total: object.total, results };
}

export class AtomClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly culture: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: AtomFetch;

  public constructor(config: AtomClientConfig) {
    if (config.apiKey.trim().length === 0) throw new AtomAdapterError('MAPPING', 'AtoM API key is required', { retryable: false });
    if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1)) throw new AtomAdapterError('MAPPING', 'AtoM timeout must be a positive integer', { retryable: false });
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey;
    this.culture = config.culture?.trim() || undefined;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? fetch;
  }

  public async getInformationObject(slug: string): Promise<AtomInformationObjectDetails> {
    return parseReference(await this.request('GET', `api/informationobjects/${encodeURIComponent(slug)}`));
  }

  public async browseInformationObjectsByIdentifier(identifier: string): Promise<readonly AtomBrowseInformationObject[]> {
    const params = new URLSearchParams({ sq0: identifier, sf0: 'identifier', topLod: '0', limit: '100' });
    if (this.culture !== undefined) params.set('sf_culture', this.culture);
    const response = parseBrowse(await this.request('GET', `api/informationobjects?${params.toString()}`));
    // Browse responses in 2.10 deployments may omit the identifier field;
    // return those candidates for authoritative per-slug validation below.
    return response.results.filter((candidate) => candidate.identifier === undefined || candidate.identifier === identifier);
  }

  public async createInformationObject(input: AtomCreateInformationObjectInput): Promise<AtomInformationObjectReference> {
    const parentIdNumber = Number(input.parent.id);
    const result = parseReference(await this.request('POST', 'api/informationobjects', {
      identifier: input.identifier,
      title: input.title,
      level_of_description: input.levelOfDescription,
      parent_id: Number.isSafeInteger(parentIdNumber) ? parentIdNumber : input.parent.id,
      parent_slug: input.parent.slug,
    }));
    return { id: result.id, slug: result.slug };
  }

  private async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(path, this.baseUrl);
      if (this.culture !== undefined && !url.searchParams.has('sf_culture')) url.searchParams.set('sf_culture', this.culture);
      let response: AtomHttpResponse;
      try {
        response = await this.fetchImpl(url, {
          method,
          signal: controller.signal,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'REST-API-Key': this.apiKey },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (controller.signal.aborted) throw new AtomAdapterError('TIMEOUT', 'AtoM request timed out');
        throw new AtomAdapterError('NETWORK', error instanceof Error ? error.message.slice(0, 500) : 'AtoM request failed');
      }
      if (response.status === 401 || response.status === 403) throw new AtomAdapterError('AUTHENTICATION', 'AtoM rejected the configured credentials', { status: response.status, retryable: false });
      if (response.status === 404) throw new AtomAdapterError('NOT_FOUND', 'AtoM information object was not found', { status: 404, retryable: false });
      if (response.status === 409) throw new AtomAdapterError('CONFLICT', 'AtoM reported a conflict', { status: 409, retryable: false });
      if (response.status >= 500) throw new AtomAdapterError('REMOTE', `AtoM returned HTTP ${response.status}`, { status: response.status });
      if (response.status < 200 || response.status >= 300) throw new AtomAdapterError('REMOTE', `AtoM returned HTTP ${response.status}`, { status: response.status, retryable: false });
      try { return await response.json(); } catch { throw new AtomAdapterError('INVALID_RESPONSE', 'AtoM returned invalid JSON', { status: response.status, retryable: false }); }
    } finally { clearTimeout(timer); }
  }
}

export interface ExpedienteFileSyncInput {
  readonly institutionId: string;
  readonly expedienteId: string;
  readonly expedienteFolio: string;
  readonly archivalParentNodeId: string;
  readonly title?: string | undefined;
}

export interface ExpedienteFileSyncResult {
  readonly mapping: AtomMappingRecord;
  readonly created: boolean;
}

export interface ApprovedExpedienteAtomSyncContext {
  readonly institutionId: string;
  readonly transferId: string;
  readonly expedienteId: string;
  readonly expedienteFolio: string;
  readonly archivalParentNodeId: string;
  readonly canonicalManifestJson: string;
  readonly manifestSha256: string;
}

export interface ApprovedExpedienteAtomSyncContextLoader {
  load(input: { readonly institutionId: string; readonly transferId: string }): Promise<ApprovedExpedienteAtomSyncContext>;
}

function assertCompatible(reference: AtomInformationObjectDetails, input: ExpedienteFileSyncInput, parent: AtomInformationObjectReference): void {
  if (reference.identifier !== input.expedienteFolio) throw new AtomAdapterError('CONFLICT', 'AtoM description identifier does not match the expediente folio', { retryable: false });
  if (reference.levelOfDescription?.toLowerCase() !== 'file') throw new AtomAdapterError('CONFLICT', 'AtoM description is not a File', { retryable: false });
  if (reference.parentId !== parent.id) throw new AtomAdapterError('CONFLICT', 'AtoM description has the wrong archival parent', { retryable: false });
  if (reference.parentSlug !== undefined && reference.parentSlug !== parent.slug) throw new AtomAdapterError('CONFLICT', 'AtoM description has the wrong archival parent slug', { retryable: false });
}

async function resolveRemoteFile(client: AtomClient, input: ExpedienteFileSyncInput, parent: AtomInformationObjectReference): Promise<AtomInformationObjectReference | undefined> {
  const candidates = await client.browseInformationObjectsByIdentifier(input.expedienteFolio);
  const compatible: AtomInformationObjectReference[] = [];
  for (const candidate of candidates) {
    const full = await client.getInformationObject(candidate.slug);
    assertCompatible(full, input, parent);
    compatible.push({ id: full.id, slug: full.slug });
  }
  if (compatible.length > 1) throw new AtomAdapterError('CONFLICT', 'AtoM returned multiple matching descriptions', { retryable: false });
  return compatible[0];
}

async function markFailed(store: AtomMappingStore, input: ExpedienteFileSyncInput): Promise<void> {
  if (store.markFailed === undefined) return;
  await store.markFailed({ institutionId: input.institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: input.expedienteId }).catch(() => undefined);
}

/** Ensures an expediente File below its frozen, already-mapped parent. */
export async function ensureExpedienteFileDescription(client: AtomClient, store: AtomMappingStore, input: ExpedienteFileSyncInput): Promise<ExpedienteFileSyncResult> {
  const parentMapping = await store.find({ institutionId: input.institutionId, iciObjectType: ATOM_OBJECT_TYPES.archivalClassificationNode, iciObjectId: input.archivalParentNodeId });
  if (parentMapping?.syncStatus !== 'SYNCED' || parentMapping.atomInformationObjectId === null || parentMapping.atomSlug === null) throw new AtomAdapterError('MAPPING', 'The authoritative archival parent has no valid AtoM mapping', { retryable: false });
  const parent: AtomInformationObjectReference = { id: parentMapping.atomInformationObjectId, slug: parentMapping.atomSlug };
  const remoteParent = await client.getInformationObject(parent.slug);
  if (remoteParent.id !== parent.id) throw new AtomAdapterError('CONFLICT', 'The mapped AtoM archival parent identity does not match', { retryable: false });
  const existing = await store.find({ institutionId: input.institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: input.expedienteId });
  if (existing?.syncStatus === 'SYNCED' && existing.atomInformationObjectId !== null && existing.atomSlug !== null) {
    try {
      const remote = await client.getInformationObject(existing.atomSlug);
      assertCompatible(remote, input, parent);
      const mapping = await store.save({ institutionId: input.institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: input.expedienteId, atomInformationObjectId: remote.id, atomSlug: remote.slug, syncStatus: 'SYNCED' });
      return { mapping, created: false };
    } catch (error) {
      await markFailed(store, input);
      throw error;
    }
  }
  let remote: AtomInformationObjectReference | undefined;
  try { remote = await resolveRemoteFile(client, input, parent); } catch (error) { await markFailed(store, input); throw error; }
  let created = false;
  if (remote === undefined) {
    try {
      remote = await client.createInformationObject({ identifier: input.expedienteFolio, title: input.title?.trim() || input.expedienteFolio, parent, levelOfDescription: 'File' });
      created = true;
    } catch (error) {
      if (!(error instanceof AtomAdapterError) || error.kind !== 'CONFLICT') { await markFailed(store, input); throw error; }
      try { remote = await resolveRemoteFile(client, input, parent); } catch (resolveError) { await markFailed(store, input); throw resolveError; }
      if (remote === undefined) { await markFailed(store, input); throw new AtomAdapterError('CONFLICT', 'AtoM creation conflicted but the description could not be resolved', { retryable: true }); }
    }
  }
  const mapping = await store.save({ institutionId: input.institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: input.expedienteId, atomInformationObjectId: remote.id, atomSlug: remote.slug, syncStatus: 'SYNCED' });
  return { mapping, created };
}

/** Loads the approved transfer snapshot before any network I/O, then performs
 * the idempotent vendor operation. The loader owns tenant/RLS enforcement. */
export async function ensureApprovedExpedienteFileDescription(client: AtomClient, store: AtomMappingStore, loader: ApprovedExpedienteAtomSyncContextLoader, input: { readonly institutionId: string; readonly transferId: string }): Promise<ExpedienteFileSyncResult> {
  const context = await loader.load(input);
  return ensureExpedienteFileDescription(client, store, {
    institutionId: context.institutionId,
    expedienteId: context.expedienteId,
    expedienteFolio: context.expedienteFolio,
    archivalParentNodeId: context.archivalParentNodeId,
  });
}
