export type EntityId = string & { readonly __brand: 'EntityId' };
type TypedEntityId<T extends string> = EntityId & { readonly __kind: T };
export type InstitutionId = TypedEntityId<'InstitutionId'>;
export type UserId = TypedEntityId<'UserId'>;
export type OrganizationalUnitId = TypedEntityId<'OrganizationalUnitId'>;
export type RoleId = TypedEntityId<'RoleId'>;
export type PermissionId = TypedEntityId<'PermissionId'>;
export type MatterId = TypedEntityId<'MatterId'>;
export type ExpedienteId = TypedEntityId<'ExpedienteId'>;
export type DocumentId = TypedEntityId<'DocumentId'>;
export type DocumentVersionId = TypedEntityId<'DocumentVersionId'>;
export type TransferId = TypedEntityId<'TransferId'>;
export type ManifestId = TypedEntityId<'ManifestId'>;
export type IntegrationJobId = TypedEntityId<'IntegrationJobId'>;
export type ExpedienteTypeId = TypedEntityId<'ExpedienteTypeId'>;
export type ExpedienteTypeVersionId = TypedEntityId<'ExpedienteTypeVersionId'>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asId<T extends string>(value: string, label: string): T {
  if (!uuidPattern.test(value)) throw new Error(`${label} must be a UUID`);
  return value as T;
}

export const entityId = (value: string): EntityId => asId<EntityId>(value, 'Entity ID');
export const institutionId = (value: string): InstitutionId => asId<InstitutionId>(value, 'Institution ID');
export const userId = (value: string): UserId => asId<UserId>(value, 'User ID');
export const organizationalUnitId = (value: string): OrganizationalUnitId => asId<OrganizationalUnitId>(value, 'Organizational unit ID');
export const roleId = (value: string): RoleId => asId<RoleId>(value, 'Role ID');
export const permissionId = (value: string): PermissionId => asId<PermissionId>(value, 'Permission ID');
export const matterId = (value: string): MatterId => asId<MatterId>(value, 'Matter ID');
export const expedienteId = (value: string): ExpedienteId => asId<ExpedienteId>(value, 'Expediente ID');
export const documentId = (value: string): DocumentId => asId<DocumentId>(value, 'Document ID');
export const documentVersionId = (value: string): DocumentVersionId => asId<DocumentVersionId>(value, 'Document version ID');
export const transferId = (value: string): TransferId => asId<TransferId>(value, 'Transfer ID');
export const manifestId = (value: string): ManifestId => asId<ManifestId>(value, 'Manifest ID');
export const integrationJobId = (value: string): IntegrationJobId => asId<IntegrationJobId>(value, 'Integration job ID');
export const expedienteTypeId = (value: string): ExpedienteTypeId => asId<ExpedienteTypeId>(value, 'Expediente type ID');
export const expedienteTypeVersionId = (value: string): ExpedienteTypeVersionId => asId<ExpedienteTypeVersionId>(value, 'Expediente type version ID');

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface DomainEvent<TPayload extends JsonObject = JsonObject> {
  readonly aggregateId: EntityId;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly payload: Readonly<TPayload>;
}

export type MatterState = 'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'VOIDED';
export type ExpedienteState = 'OPEN' | 'CLOSED' | 'TRANSFER_PENDING' | 'TRANSFERRED' | 'VOIDED';
export type ArchiveTransferState = 'DRAFT' | 'APPROVED' | 'SUBMITTED' | 'PRESERVING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type DefinitionVersionState = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type MalwareScanStatus = 'PENDING_SCAN' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED' | 'QUARANTINED';
export type IntegrationJobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type FolioKind = 'MATTER' | 'EXPEDIENTE';

export class DomainInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainInvariantError';
    this.code = code;
  }
}

export function requireNonBlank(value: string, field: string): string {
  if (value.trim().length === 0) throw new DomainInvariantError('INVALID_VALUE', `${field} must not be blank`);
  return value;
}

export function invalidTransition(aggregate: string, from: string, command: string): never {
  throw new DomainInvariantError('INVALID_TRANSITION', `${command} is not allowed from ${aggregate} state ${from}`);
}

export interface Institution {
  readonly id: InstitutionId;
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
}

export interface OrganizationalUnit {
  readonly id: OrganizationalUnitId;
  readonly institutionId: InstitutionId;
  readonly parentId?: OrganizationalUnitId | undefined;
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
}

export interface User {
  readonly id: UserId;
  readonly institutionId: InstitutionId;
  readonly displayName: string;
  readonly status: 'ACTIVE' | 'DISABLED';
}

export interface ExternalIdentity {
  readonly id: EntityId;
  readonly institutionId: InstitutionId;
  readonly userId: UserId;
  readonly issuer: string;
  readonly subject: string;
  readonly emailSnapshot?: string | undefined;
}

export interface Role {
  readonly id: RoleId;
  readonly code: string;
  readonly name: string;
}

export interface Permission {
  readonly id: PermissionId;
  readonly code: string;
  readonly name: string;
}

export interface MatterAssignment {
  readonly id: EntityId;
  readonly institutionId: InstitutionId;
  readonly matterId: MatterId;
  readonly unitId: OrganizationalUnitId;
  readonly userId?: UserId | undefined;
  readonly reason?: string | undefined;
  readonly assignedAt: Date;
}

export interface Matter {
  readonly id: MatterId;
  readonly institutionId: InstitutionId;
  readonly folio: string;
  readonly state: MatterState;
  readonly receivedAt: Date;
  readonly intake: JsonObject;
  readonly currentAssignment?: MatterAssignment | undefined;
  readonly linkedExpedienteId?: ExpedienteId | undefined;
  readonly resolutionMetadata?: JsonObject | undefined;
  readonly closureMetadata?: JsonObject | undefined;
}

export interface ExpedienteType {
  readonly id: ExpedienteTypeId;
  readonly institutionId: InstitutionId;
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'RETIRED';
}

export interface ExpedienteTypeVersion {
  readonly id: ExpedienteTypeVersionId;
  readonly institutionId: InstitutionId;
  readonly expedienteTypeId: ExpedienteTypeId;
  readonly versionNumber: number;
  readonly state: DefinitionVersionState;
  readonly schemaJson: JsonObject;
  readonly archivalMappingJson: JsonObject;
  readonly createdAt: Date;
  readonly publishedAt?: Date | undefined;
}

export interface Expediente {
  readonly id: ExpedienteId;
  readonly institutionId: InstitutionId;
  readonly folio: string;
  readonly state: ExpedienteState;
  readonly expedienteTypeVersionId: ExpedienteTypeVersionId;
  readonly metadata: JsonObject;
  readonly openedAt: Date;
  readonly closedAt?: Date | undefined;
}

export interface DocumentVersion {
  readonly id: DocumentVersionId;
  readonly institutionId: InstitutionId;
  readonly documentId: DocumentId;
  readonly versionNumber: number;
  readonly originalFilename: string;
  readonly detectedMimeType: string;
  readonly declaredMimeType?: string | undefined;
  readonly sizeBytes: bigint;
  readonly sha256: string;
  readonly storageKey: string;
  readonly accessClassificationSnapshot: JsonObject;
  readonly malwareScanStatus: MalwareScanStatus;
  readonly createdBy: UserId;
  readonly createdAt: Date;
  readonly replacementReason?: string | undefined;
}

export interface Document {
  readonly id: DocumentId;
  readonly institutionId: InstitutionId;
  readonly expedienteId?: ExpedienteId | undefined;
  readonly matterId?: MatterId | undefined;
  readonly documentType: string;
  readonly title: string;
  readonly currentVersionId?: DocumentVersionId | undefined;
  readonly latestVersionNumber: number;
  readonly createdAt: Date;
}

export interface ArchiveTransfer {
  readonly id: TransferId;
  readonly institutionId: InstitutionId;
  readonly expedienteId: ExpedienteId;
  readonly state: ArchiveTransferState;
  readonly supplementsTransferId?: TransferId | undefined;
  readonly correctionReason?: string | undefined;
  readonly createdAt: Date;
}

export interface TransferManifest {
  readonly id: ManifestId;
  readonly institutionId: InstitutionId;
  readonly transferId: TransferId;
  readonly state: 'DRAFT' | 'APPROVED';
  readonly canonicalJson: string;
  readonly sha256?: string | undefined;
  readonly approvedBy?: UserId | undefined;
  readonly approvedAt?: Date | undefined;
}

export interface AuditEvent {
  readonly id: EntityId;
  readonly institutionId: InstitutionId;
  readonly actorUserId?: UserId | undefined;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: EntityId;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly before?: JsonObject | undefined;
  readonly after?: JsonObject | undefined;
  readonly data?: JsonObject | undefined;
}

export interface IntegrationJob {
  readonly id: IntegrationJobId;
  readonly institutionId: InstitutionId;
  readonly jobType: string;
  readonly aggregateType: string;
  readonly aggregateId: EntityId;
  readonly status: IntegrationJobStatus;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly attemptCount: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly lastError?: string | undefined;
  readonly payload: JsonObject;
}

export interface FolioCounter {
  readonly institutionId: InstitutionId;
  readonly folioKind: FolioKind;
  readonly folioYear: number;
  readonly nextValue: number;
}
