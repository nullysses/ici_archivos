import {
  type AuditEvent,
  type EntityId,
  type FolioCounter,
  type FolioKind,
  type Institution,
  type InstitutionId,
  type IntegrationJob,
  type IntegrationJobId,
  type JsonObject,
  type OrganizationalUnit,
  type OrganizationalUnitId,
  type Permission,
  type PermissionId,
  type Role,
  type RoleId,
  type User,
  type UserId,
  DomainInvariantError,
  requireNonBlank,
} from './types.js';

export function createInstitution(input: { readonly id: InstitutionId; readonly code: string; readonly name: string }): Institution {
  return { ...input, code: requireNonBlank(input.code, 'Institution code'), name: requireNonBlank(input.name, 'Institution name'), status: 'ACTIVE' };
}

export function createOrganizationalUnit(input: { readonly id: OrganizationalUnitId; readonly institutionId: InstitutionId; readonly parentId?: OrganizationalUnitId | undefined; readonly code: string; readonly name: string }): OrganizationalUnit {
  return { ...input, code: requireNonBlank(input.code, 'Organizational unit code'), name: requireNonBlank(input.name, 'Organizational unit name'), status: 'ACTIVE' };
}

export function createUser(input: { readonly id: UserId; readonly institutionId: InstitutionId; readonly displayName: string }): User {
  return { ...input, displayName: requireNonBlank(input.displayName, 'User display name'), status: 'ACTIVE' };
}

export function createRole(input: { readonly id: RoleId; readonly code: string; readonly name: string }): Role {
  return { ...input, code: requireNonBlank(input.code, 'Role code'), name: requireNonBlank(input.name, 'Role name') };
}

export function createPermission(input: { readonly id: PermissionId; readonly code: string; readonly name: string }): Permission {
  return { ...input, code: requireNonBlank(input.code, 'Permission code'), name: requireNonBlank(input.name, 'Permission name') };
}

export function createFolioCounter(input: { readonly institutionId: InstitutionId; readonly folioKind: FolioKind; readonly folioYear: number; readonly nextValue?: number }): FolioCounter {
  if (!Number.isInteger(input.folioYear) || input.folioYear < 2000 || input.folioYear > 9999) throw new DomainInvariantError('INVALID_FOLIO_YEAR', 'Folio year must be a four-digit year');
  const nextValue = input.nextValue ?? 1;
  if (!Number.isInteger(nextValue) || nextValue < 1) throw new DomainInvariantError('INVALID_FOLIO_COUNTER', 'Folio counter must start at one or greater');
  return { institutionId: input.institutionId, folioKind: input.folioKind, folioYear: input.folioYear, nextValue };
}

export function createIntegrationJob(input: { readonly id: IntegrationJobId; readonly institutionId: InstitutionId; readonly jobType: string; readonly aggregateType: string; readonly aggregateId: EntityId; readonly idempotencyKey: string; readonly correlationId: string; readonly payload: JsonObject; }): IntegrationJob {
  return { ...input, jobType: requireNonBlank(input.jobType, 'Job type'), aggregateType: requireNonBlank(input.aggregateType, 'Aggregate type'), idempotencyKey: requireNonBlank(input.idempotencyKey, 'Idempotency key'), correlationId: requireNonBlank(input.correlationId, 'Correlation ID'), status: 'PENDING', attemptCount: 0 };
}

export function createAuditEvent(input: { readonly id: EntityId; readonly institutionId: InstitutionId; readonly actorUserId?: UserId | undefined; readonly eventType: string; readonly aggregateType: string; readonly aggregateId: EntityId; readonly correlationId: string; readonly occurredAt: Date; readonly before?: JsonObject | undefined; readonly after?: JsonObject | undefined; readonly data?: JsonObject | undefined }): AuditEvent {
  return { ...input, eventType: requireNonBlank(input.eventType, 'Audit event type'), aggregateType: requireNonBlank(input.aggregateType, 'Audit aggregate type'), correlationId: requireNonBlank(input.correlationId, 'Correlation ID') };
}
