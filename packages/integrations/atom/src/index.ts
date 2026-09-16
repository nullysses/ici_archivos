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

export type AtomArchivalLevel = 'Fonds' | 'Section' | 'Series' | 'Subseries' | 'File';

export const ATOM_ARCHIVAL_LEVELS = {
  FONDS: 'Fonds',
  SECTION: 'Section',
  SERIES: 'Series',
  SUBSERIES: 'Subseries',
  FILE: 'File',
} as const satisfies Record<string, AtomArchivalLevel>;

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
  reserve(input: { readonly institutionId: string; readonly iciObjectType: AtomObjectType; readonly iciObjectId: string }): Promise<{ readonly record: AtomMappingRecord; readonly reserved: boolean }>;
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
  | 'MAPPING'
  | 'RECONCILIATION_REQUIRED';

export class AtomAdapterError extends Error {
  public readonly kind: AtomErrorKind;
  public readonly status: number | undefined;
  public readonly retryable: boolean;
  public readonly code: string;

  public constructor(kind: AtomErrorKind, message: string, options: { readonly status?: number; readonly retryable?: boolean; readonly code?: string } = {}) {
    super(message);
    this.name = 'AtomAdapterError';
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? (kind === 'TIMEOUT' || kind === 'NETWORK' || kind === 'REMOTE');
    this.code = options.code ?? kind;
  }
}

export interface AtomClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly culture?: string;
  readonly timeoutMs?: number;
  readonly fetch?: AtomFetch;
  /** The AtoM service account is configured without publication permission. */
  readonly draftPolicy: 'SERVICE_ACCOUNT_NO_PUBLISH';
}

export interface AtomCreateInformationObjectInput {
  readonly identifier: string;
  readonly title: string;
  readonly parent?: AtomInformationObjectReference | undefined;
  readonly levelOfDescription: AtomArchivalLevel;
}

export interface AtomInformationObjectDetails {
  readonly identifier?: string | undefined;
  readonly levelOfDescription?: string | undefined;
  readonly referenceCode?: string | undefined;
  readonly title?: string | undefined;
  readonly publicationStatus?: string | undefined;
  /** AtoM's documented read response includes this object after a digital
   * object has been linked to the description (for example by native DIP
   * upload). */
  readonly hasDigitalObject?: boolean | undefined;
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

function parseReadDetails(value: unknown): AtomInformationObjectDetails {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AtomAdapterError('INVALID_RESPONSE', 'AtoM response must be an object', { retryable: false });
  const object = value as Record<string, unknown>;
  const digitalObject = object.digital_object;
  return {
    ...(typeof object.identifier === 'string' ? { identifier: object.identifier } : {}),
    ...(typeof object.level_of_description === 'string' ? { levelOfDescription: object.level_of_description } : {}),
    ...(typeof object.reference_code === 'string' ? { referenceCode: object.reference_code } : {}),
    ...(typeof object.title === 'string' ? { title: object.title } : {}),
    ...(typeof object.publication_status === 'string' ? { publicationStatus: object.publication_status } : {}),
    ...(digitalObject !== undefined ? { hasDigitalObject: digitalObject !== null && typeof digitalObject === 'object' && !Array.isArray(digitalObject) } : {}),
  };
}

function parseCreatedReference(value: unknown): AtomInformationObjectReference & { readonly publicationStatus?: string; readonly published?: boolean } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AtomAdapterError('INVALID_RESPONSE', 'AtoM response must be an object', { retryable: false });
  const object = value as Record<string, unknown>;
  return {
    id: normalizeDecimalId(object.id),
    slug: requiredString(object.slug, 'slug'),
    ...(typeof object.publication_status === 'string' ? { publicationStatus: object.publication_status } : {}),
    ...(typeof object.published === 'boolean' ? { published: object.published } : {}),
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
    if (config.draftPolicy !== 'SERVICE_ACCOUNT_NO_PUBLISH') throw new AtomAdapterError('MAPPING', 'AtoM draft policy must be SERVICE_ACCOUNT_NO_PUBLISH', { retryable: false });
  }

  public async getInformationObject(slug: string): Promise<AtomInformationObjectDetails> {
    return parseReadDetails(await this.request('GET', `api/informationobjects/${encodeURIComponent(slug)}`));
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
    const parentIdNumber = input.parent === undefined ? undefined : Number(input.parent.id);
    const result = parseCreatedReference(await this.request('POST', 'api/informationobjects', {
      identifier: input.identifier,
      title: input.title,
      level_of_description: input.levelOfDescription,
      ...(input.parent === undefined ? {} : {
        parent_id: Number.isSafeInteger(parentIdNumber) ? parentIdNumber : input.parent.id,
        parent_slug: input.parent.slug,
      }),
    }));
    if (result.published === true || result.publicationStatus?.toLowerCase() === 'published') {
      throw new AtomAdapterError('CONFLICT', 'AtoM created a published description despite the draft-only deployment policy', { retryable: false });
    }
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

export type IciArchivalNodeType = 'FONDS' | 'SECTION' | 'SERIES' | 'SUBSERIES';

export interface ArchivalClassificationNodeRecord {
  readonly id: string;
  readonly institutionId: string;
  readonly parentId: string | null;
  readonly nodeType: IciArchivalNodeType;
  readonly code: string;
  readonly name: string;
}

export interface ArchivalClassificationPathLoader {
  load(input: { readonly institutionId: string; readonly targetNodeId: string }): Promise<readonly ArchivalClassificationNodeRecord[]>;
}

export interface ClassificationHierarchySyncInput {
  readonly institutionId: string;
  readonly targetNodeId: string;
}

export interface ClassificationHierarchySyncResult {
  readonly target: AtomMappingRecord;
  readonly mappings: readonly AtomMappingRecord[];
}

export function atomLevelForClassificationNodeType(nodeType: IciArchivalNodeType): Exclude<AtomArchivalLevel, 'File'> {
  switch (nodeType) {
    case 'FONDS': return ATOM_ARCHIVAL_LEVELS.FONDS;
    case 'SECTION': return ATOM_ARCHIVAL_LEVELS.SECTION;
    case 'SERIES': return ATOM_ARCHIVAL_LEVELS.SERIES;
    case 'SUBSERIES': return ATOM_ARCHIVAL_LEVELS.SUBSERIES;
  }
}

function validateClassificationPath(path: readonly ArchivalClassificationNodeRecord[], institutionId: string, targetNodeId: string): void {
  if (path.length === 0 || path[path.length - 1]?.id !== targetNodeId) throw new AtomAdapterError('MAPPING', 'The archival classification path does not terminate at the requested node', { retryable: false });
  const expectedParent: Record<IciArchivalNodeType, IciArchivalNodeType | null> = { FONDS: null, SECTION: 'FONDS', SERIES: 'SECTION', SUBSERIES: 'SERIES' };
  const seen = new Set<string>();
  for (const [index, node] of path.entries()) {
    if (node.institutionId !== institutionId || seen.has(node.id)) throw new AtomAdapterError('MAPPING', 'The archival classification path is cross-tenant or cyclic', { retryable: false });
    seen.add(node.id);
    const parent = index === 0 ? undefined : path[index - 1];
    if (expectedParent[node.nodeType] === null) {
      if (node.parentId !== null || index !== 0) throw new AtomAdapterError('MAPPING', 'A Fonds node must be the root of the archival classification path', { retryable: false });
    } else if (parent === undefined || node.parentId !== parent.id || parent.nodeType !== expectedParent[node.nodeType]) {
      throw new AtomAdapterError('MAPPING', `${node.nodeType} has an invalid parent in the archival classification path`, { retryable: false });
    }
  }
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

function assertCompatible(reference: AtomInformationObjectDetails): void {
  if (reference.levelOfDescription === undefined || reference.levelOfDescription.toLowerCase() !== 'file') throw new AtomAdapterError('CONFLICT', 'AtoM description is not a File', { retryable: false });
}

function assertCompatibleClassification(reference: AtomInformationObjectDetails, expectedLevel: Exclude<AtomArchivalLevel, 'File'>): void {
  if (reference.levelOfDescription === undefined || reference.levelOfDescription.toLowerCase() !== expectedLevel.toLowerCase()) throw new AtomAdapterError('CONFLICT', `AtoM description is not a ${expectedLevel}`, { retryable: false });
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
  assertCompatibleParent(remoteParent);
  const existing = await store.find({ institutionId: input.institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: input.expedienteId });
  if (existing?.syncStatus === 'SYNCED' && existing.atomInformationObjectId !== null && existing.atomSlug !== null) {
    try {
      const remote = await client.getInformationObject(existing.atomSlug);
      assertCompatible(remote);
      const mapping = await store.save({ institutionId: input.institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: input.expedienteId, atomInformationObjectId: existing.atomInformationObjectId, atomSlug: existing.atomSlug, syncStatus: 'SYNCED' });
      return { mapping, created: false };
    } catch (error) {
      await markFailed(store, input);
      throw error;
    }
  }
  const reservation = await store.reserve({ institutionId: input.institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: input.expedienteId });
  if (!reservation.reserved) throw new AtomAdapterError('RECONCILIATION_REQUIRED', 'AtoM synchronization has an incomplete local reservation; reconcile the remote description before retrying', { retryable: false, code: 'ATOM_RECONCILIATION_REQUIRED' });
  let remote: AtomInformationObjectReference;
  try {
    remote = await client.createInformationObject({ identifier: input.expedienteFolio, title: input.title?.trim() || input.expedienteFolio, parent, levelOfDescription: 'File' });
  } catch (error) {
    await markFailed(store, input);
    if (error instanceof AtomAdapterError && error.kind === 'CONFLICT') throw new AtomAdapterError('RECONCILIATION_REQUIRED', 'AtoM creation conflicted; reconcile the remote description before retrying', { retryable: false, code: 'ATOM_RECONCILIATION_REQUIRED' });
    throw error;
  }
  const created = true;
  const mapping = await store.save({ institutionId: input.institutionId, iciObjectType: ATOM_OBJECT_TYPES.expediente, iciObjectId: input.expedienteId, atomInformationObjectId: remote.id, atomSlug: remote.slug, syncStatus: 'SYNCED' });
  return { mapping, created };
}

function assertCompatibleParent(reference: AtomInformationObjectDetails): void {
  // The documented read endpoint does not guarantee id/parent fields. The
  // local mapping remains authoritative for identity; validate the documented
  // level so a mapped object cannot silently point at a non-parent description.
  const level = reference.levelOfDescription?.toLowerCase();
  if (level !== 'series' && level !== 'subseries') throw new AtomAdapterError('CONFLICT', 'The mapped AtoM archival parent is not a Series or Subseries', { retryable: false });
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

async function ensureClassificationNode(client: AtomClient, store: AtomMappingStore, node: ArchivalClassificationNodeRecord, parent: AtomMappingRecord | undefined): Promise<AtomMappingRecord> {
  const expectedLevel = atomLevelForClassificationNodeType(node.nodeType);
  const existing = await store.find({ institutionId: node.institutionId, iciObjectType: ATOM_OBJECT_TYPES.archivalClassificationNode, iciObjectId: node.id });
  if (existing?.syncStatus === 'SYNCED' && existing.atomInformationObjectId !== null && existing.atomSlug !== null) {
    const remote = await client.getInformationObject(existing.atomSlug);
    assertCompatibleClassification(remote, expectedLevel);
    return existing;
  }
  if (existing !== undefined) throw new AtomAdapterError('RECONCILIATION_REQUIRED', 'Classification synchronization has an incomplete local reservation; reconcile the remote description before retrying', { retryable: false, code: 'ATOM_RECONCILIATION_REQUIRED' });
  if (node.nodeType !== 'FONDS' && (parent === undefined || parent.syncStatus !== 'SYNCED' || parent.atomInformationObjectId === null || parent.atomSlug === null)) throw new AtomAdapterError('MAPPING', 'An authoritative synchronized parent is required before creating a classification child', { retryable: false });
  const reservation = await store.reserve({ institutionId: node.institutionId, iciObjectType: ATOM_OBJECT_TYPES.archivalClassificationNode, iciObjectId: node.id });
  if (!reservation.reserved) throw new AtomAdapterError('RECONCILIATION_REQUIRED', 'Classification synchronization was reserved by another attempt; reconcile before retrying', { retryable: false, code: 'ATOM_RECONCILIATION_REQUIRED' });
  let remote: AtomInformationObjectReference;
  try {
    remote = await client.createInformationObject({
      identifier: node.code,
      title: node.name,
      levelOfDescription: expectedLevel,
      ...(node.nodeType === 'FONDS' ? {} : { parent: { id: parent!.atomInformationObjectId!, slug: parent!.atomSlug! } }),
    });
  } catch (error) {
    await markClassificationFailed(store, node);
    if (error instanceof AtomAdapterError && error.kind === 'CONFLICT') throw new AtomAdapterError('RECONCILIATION_REQUIRED', 'AtoM classification creation conflicted; reconcile before retrying', { retryable: false, code: 'ATOM_RECONCILIATION_REQUIRED' });
    throw error;
  }
  return store.save({ institutionId: node.institutionId, iciObjectType: ATOM_OBJECT_TYPES.archivalClassificationNode, iciObjectId: node.id, atomInformationObjectId: remote.id, atomSlug: remote.slug, syncStatus: 'SYNCED' });
}

async function markClassificationFailed(store: AtomMappingStore, node: ArchivalClassificationNodeRecord): Promise<void> {
  if (store.markFailed === undefined) return;
  await store.markFailed({ institutionId: node.institutionId, iciObjectType: ATOM_OBJECT_TYPES.archivalClassificationNode, iciObjectId: node.id }).catch(() => undefined);
}

/** Ensures an authoritative ICI classification path from Fonds to the target,
 * performing one short reservation/network/save cycle per node. */
export async function ensureAtomClassificationHierarchy(client: AtomClient, store: AtomMappingStore, loader: ArchivalClassificationPathLoader, input: ClassificationHierarchySyncInput): Promise<ClassificationHierarchySyncResult> {
  const path = await loader.load(input);
  validateClassificationPath(path, input.institutionId, input.targetNodeId);
  const mappings: AtomMappingRecord[] = [];
  for (const [index, node] of path.entries()) {
    if (node.institutionId !== input.institutionId) throw new AtomAdapterError('MAPPING', 'The archival classification path crosses institutions', { retryable: false });
    const parent = index === 0 ? undefined : mappings[index - 1];
    mappings.push(await ensureClassificationNode(client, store, node, parent));
  }
  const target = mappings[mappings.length - 1];
  if (target === undefined) throw new AtomAdapterError('MAPPING', 'The synchronized classification target is missing', { retryable: false });
  return { target, mappings };
}
