export type Capability =
  | 'matter.register' | 'matter.assign' | 'matter.void' | 'matter.start' | 'matter.resolve' | 'matter.reopen' | 'matter.close'
  | 'expediente.create' | 'expediente.edit_open' | 'document.version_open' | 'expediente.close' | 'expediente.reopen'
  | 'archive_transfer.prepare' | 'archive_transfer.approve' | 'archive_transfer.retry'
  | 'archival_description.correct' | 'atom_description.publish' | 'identity.manage' | 'institution.configure'
  | 'expediente_type.manage_draft' | 'expediente_type.publish' | 'records.read';

export interface Session {
  readonly userId: string;
  readonly institutionId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly institutionCapabilities: readonly Capability[];
  readonly unitCapabilities: Readonly<Record<string, readonly Capability[]>>;
}

export class ApiError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | undefined;

/** The OIDC integration owns token acquisition. Keeping the token in module
 * memory avoids introducing a second persistent browser credential store. */
export function setAccessToken(token: string | undefined): void {
  accessToken = token;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (accessToken !== undefined) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => undefined)) as { readonly error?: { readonly message?: string } } | T | undefined;
  if (!response.ok) throw new ApiError(response.status, typeof body === 'object' && body !== null && 'error' in body && body.error?.message !== undefined ? body.error.message : 'No se pudo completar la solicitud');
  return body as T;
}

export async function fetchSession(): Promise<Session | null> {
  try {
    return await apiRequest<Session>('/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly service: string;
  readonly version: string;
  readonly timestamp: string;
  readonly dependencies: { readonly database: 'up' | 'down' };
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
  const body = (await response.json().catch(() => undefined)) as HealthResponse | { readonly error?: { readonly message?: string } } | undefined;
  if (!response.ok && response.status !== 503) throw new ApiError(response.status, typeof body === 'object' && body !== null && 'error' in body && body.error?.message !== undefined ? body.error.message : 'No se pudo consultar el estado del sistema');
  return body as HealthResponse;
}

export function canInstitution(session: Session | null | undefined, capability: Capability): boolean {
  return session?.institutionCapabilities.includes(capability) ?? false;
}

export function canInUnit(session: Session | null | undefined, capability: Capability, unitId: string): boolean {
  return canInstitution(session, capability) || session?.unitCapabilities[unitId]?.includes(capability) === true;
}

export function canAnywhere(session: Session | null | undefined, capability: Capability): boolean {
  return canInstitution(session, capability) || Object.values(session?.unitCapabilities ?? {}).some((capabilities) => capabilities.includes(capability));
}

export const can = canInstitution;

export interface Matter {
  readonly id: string; readonly folio: string; readonly status: string; readonly receivedAt: string; readonly dueAt?: string;
  readonly sender: string; readonly subject: string; readonly description: string; readonly priority: string; readonly channel: string;
  readonly destinationUnitId: string | null; readonly accessClassificationId: string | null; readonly operationalVisibility: string | null;
  readonly resolutionMetadata: Record<string, unknown> | null; readonly closureMetadata: Record<string, unknown> | null;
  readonly linkedExpedienteId: string | null; readonly createdBy: string | null; readonly createdAt: string; readonly updatedAt: string;
  readonly assignmentUnitId?: string; readonly assignmentUserId?: string | null; readonly assignedAt?: string;
}
export interface MatterNote { readonly id: string; readonly matterId: string; readonly authorUserId: string; readonly noteType: 'NOTE' | 'RESPONSE'; readonly content: string; readonly createdAt: string; }
export interface MatterActivity { readonly id: string; readonly kind: 'state' | 'audit'; readonly eventType: string; readonly command?: string; readonly fromStatus: string | null; readonly toStatus: string | null; readonly actorUserId: string | null; readonly reason: string | null; readonly eventData: Record<string, unknown>; readonly occurredAt: string; }
export interface Expediente { readonly id: string; readonly folio: string; readonly status: string; readonly expedienteTypeVersionId: string; readonly metadata: Record<string, unknown>; readonly openedAt: string; readonly closedAt: string | null; }
export interface PublishedExpedienteType { readonly id: string; readonly expedienteTypeId: string; readonly code: string; readonly name: string; readonly versionNumber: number; readonly schema: Record<string, unknown>; }
export interface OrganizationalUnit { readonly id: string; readonly code: string; readonly name: string; }
export interface AssignmentUser { readonly id: string; readonly displayName: string; }
export interface AccessClassification { readonly id: string; readonly legalClassification: string; readonly operationalVisibility: string; }
export interface DocumentVersion { readonly id: string; readonly documentId: string; readonly versionNumber: number; readonly originalFilename: string; readonly detectedMimeType: string; readonly declaredMimeType: string | null; readonly sizeBytes: string; readonly sha256: string; readonly malwareScanStatus: 'PENDING_SCAN' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED' | 'QUARANTINED'; readonly createdBy: string; readonly createdAt: string; readonly replacementReason: string | null; }
export interface Document { readonly id: string; readonly matterId: string | null; readonly expedienteId: string | null; readonly documentType: string; readonly title: string; readonly currentVersionId: string | null; readonly accessClassificationId: string | null; readonly createdAt: string; readonly updatedAt: string; readonly versions: readonly DocumentVersion[]; }
export interface ArchivalPathNode { readonly id: string; readonly nodeType: 'FONDS' | 'SECTION' | 'SERIES' | 'SUBSERIES'; readonly code: string; readonly name: string; }
export interface TransferIntervention { readonly kind: 'USER_INPUT' | 'RECONCILIATION' | 'PRESERVATION_INTERVENTION' | 'FAILURE'; readonly message: string; }
export interface TransferEvidence { readonly submissionStatus: 'PENDING' | 'SUBMITTED' | 'RECONCILIATION_REQUIRED' | 'FAILED'; readonly archivematicaTransferUuid: string | null; readonly sipUuid: string | null; readonly aipUuid: string | null; readonly dipUuid: string | null; readonly lastRemoteStatus: string | null; readonly lastIngestStatus: string | null; readonly lastCheckedAt: string | null; }
export interface TransferStaging { readonly status: 'IN_PROGRESS' | 'STAGED' | 'RECONCILIATION_REQUIRED'; readonly locationUuid: string; readonly relativePath: string; readonly manifestSha256: string; }
export interface TransferQueueItem { readonly transferId: string; readonly expedienteId: string; readonly expedienteFolio: string; readonly transferStatus: string; readonly manifestStatus: string; readonly updatedAt: string; readonly createdAt: string; readonly category: 'POR_APROBAR' | 'EN_PRESERVACION' | 'REQUIEREN_ATENCION' | 'COMPLETADOS' | 'OTROS'; readonly archivalPath: readonly ArchivalPathNode[]; readonly intervention: TransferIntervention | null; }
export interface ArchiveQueue { readonly readyForPreparation: readonly { readonly expedienteId: string; readonly expedienteFolio: string; readonly status: 'CLOSED'; readonly archivalPath: readonly ArchivalPathNode[] }[]; readonly transfers: readonly TransferQueueItem[]; }
export interface TransferActivity { readonly id: string; readonly eventType: string; readonly occurredAt: string; readonly actorUserId: string | null; }
export interface ArchiveTransferWorkspace { readonly transfer: { readonly id: string; readonly expedienteId: string; readonly status: string; readonly createdAt: string; readonly updatedAt: string; readonly manifest: TransferManifest }; readonly expediente: { readonly id: string; readonly folio: string; readonly status: string }; readonly archivalPath: readonly ArchivalPathNode[]; readonly atom: { readonly parent: { readonly id: string; readonly slug: string } | null; readonly file: { readonly id: string; readonly slug: string } | null }; readonly evidence: TransferEvidence | null; readonly staging: TransferStaging | null; readonly intervention: TransferIntervention | null; readonly job: { readonly status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; readonly attemptCount: number; readonly lastError: string | null } | null; readonly activity: readonly TransferActivity[]; }
export interface TransferManifest { readonly id: string; readonly transferId: string; readonly status: 'DRAFT' | 'APPROVED'; readonly canonicalJson: string; readonly sha256: string | null; readonly approvedBy: string | null; readonly approvedAt: string | null; readonly documents: readonly { readonly documentId: string; readonly versionId: string; readonly versionNumber: number; readonly filename: string; readonly sha256: string; readonly sizeBytes: string; readonly mimeType: string; readonly current: boolean }[]; }

export function fetchMatterInbox(): Promise<{ readonly items: readonly Matter[] }> { return apiRequest('/matters/inbox'); }
export function fetchMatter(id: string): Promise<Matter> { return apiRequest(`/matters/${id}`); }
export function fetchMatterNotes(id: string): Promise<{ readonly items: readonly MatterNote[] }> { return apiRequest(`/matters/${id}/notes`); }
export function fetchMatterActivity(id: string): Promise<{ readonly items: readonly MatterActivity[] }> { return apiRequest(`/matters/${id}/activity`); }
export function fetchExpedientes(): Promise<{ readonly items: readonly Expediente[] }> { return apiRequest('/expedientes'); }
export function fetchExpediente(id: string): Promise<Expediente> { return apiRequest(`/expedientes/${id}`); }
export function fetchExpedienteDocuments(id: string): Promise<{ readonly items: readonly Document[] }> { return apiRequest(`/expedientes/${id}/documents`); }
export function fetchPublishedExpedienteTypes(): Promise<{ readonly items: readonly PublishedExpedienteType[] }> { return apiRequest('/expediente-types/published'); }
export function fetchUnits(purpose: 'assign' | 'register' | 'read' = 'assign'): Promise<{ readonly items: readonly OrganizationalUnit[] }> { return apiRequest(`/lookups/organizational-units?purpose=${purpose}`); }
export function fetchUnitUsers(unitId: string): Promise<{ readonly items: readonly AssignmentUser[] }> { return apiRequest(`/lookups/organizational-units/${unitId}/users`); }
export function fetchAccessClassifications(purpose: 'matter' | 'document' = 'matter'): Promise<{ readonly items: readonly AccessClassification[] }> { return apiRequest(`/lookups/access-classifications?purpose=${purpose}`); }
export function fetchArchiveQueue(): Promise<ArchiveQueue> { return apiRequest('/archive/queue'); }
export function fetchArchiveTransferWorkspace(id: string): Promise<ArchiveTransferWorkspace> { return apiRequest(`/archive-transfers/${id}/workspace`); }

export async function apiMutation<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  return apiRequest<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function uploadDocument(path: string, fields: Record<string, string>, file: File): Promise<{ readonly document: Document; readonly version: DocumentVersion }> {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  form.append('file', file);
  const headers = new Headers({ Accept: 'application/json' });
  if (accessToken !== undefined) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(`/api${path}`, { method: 'POST', headers, body: form });
  const body = (await response.json().catch(() => undefined)) as { readonly error?: { readonly message?: string } } | { readonly document: Document; readonly version: DocumentVersion } | undefined;
  if (!response.ok) throw new ApiError(response.status, typeof body === 'object' && body !== null && 'error' in body && body.error?.message !== undefined ? body.error.message : 'No se pudo cargar el documento');
  return body as { readonly document: Document; readonly version: DocumentVersion };
}
