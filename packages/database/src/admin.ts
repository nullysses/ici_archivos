import { randomUUID } from 'node:crypto';
import type { AuthorizationContext, Capability, InstitutionId, JsonObject } from '@ici/domain';
import { canPerform, DomainInvariantError, capabilities } from '@ici/domain';
import type { Database, DatabaseTransaction } from './index.js';
import { withAuditedTenantTransaction, withTenantTransaction } from './index.js';
import { createExpedienteSchemaValidator } from './json-schema-validator.js';
import { publishExpedienteTypeVersionAtomically } from './services.js';

function requireCapability(input: { readonly institutionId: InstitutionId | string; readonly authorizationContext: AuthorizationContext; readonly capability: Capability }): void {
  if (input.authorizationContext.institutionId !== String(input.institutionId) || !canPerform(input.authorizationContext, input.capability)) throw new DomainInvariantError('NOT_AUTHORIZED', `Administrative operation requires ${input.capability}`);
}

function now(): Date { return new Date(); }

export interface AdminInstitutionRecord { readonly id: string; readonly code: string; readonly name: string; readonly status: 'ACTIVE' | 'SUSPENDED'; }
export async function findAdminInstitution(database: Database, input: { readonly institutionId: string; readonly authorizationContext: AuthorizationContext }): Promise<AdminInstitutionRecord> {
  requireCapability({ ...input, capability: 'institution.configure' });
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const row = await transaction.selectFrom('institutions').select(['id', 'code', 'name', 'status']).where('id', '=', input.institutionId).executeTakeFirst();
    if (row === undefined) throw new DomainInvariantError('INSTITUTION_NOT_FOUND', 'Institution not found');
    return row;
  });
}

export async function updateAdminInstitution(database: Database, input: { readonly institutionId: string; readonly actorUserId: string; readonly name: string; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<AdminInstitutionRecord> {
  requireCapability({ ...input, capability: 'institution.configure' });
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) throw new DomainInvariantError('INVALID_INSTITUTION_NAME', 'Institution name must contain between 1 and 200 characters');
  return withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'institution.updated', aggregateType: 'institution', aggregateId: input.institutionId, correlationId: input.correlationId, afterData: { name } }, async (transaction) => {
    const before = await transaction.selectFrom('institutions').select(['id', 'code', 'name', 'status']).where('id', '=', input.institutionId).forUpdate().executeTakeFirst();
    if (before === undefined) throw new DomainInvariantError('INSTITUTION_NOT_FOUND', 'Institution not found');
    await transaction.updateTable('institutions').set({ name, updated_at: now() }).where('id', '=', input.institutionId).execute();
    return { ...before, name };
  });
}

export interface AdminUnitRecord { readonly id: string; readonly code: string; readonly name: string; readonly parent_id: string | null; readonly status: 'ACTIVE' | 'INACTIVE'; }
export async function findAdminUnits(database: Database, input: { readonly institutionId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly AdminUnitRecord[]> {
  requireCapability({ ...input, capability: 'identity.manage' });
  return withTenantTransaction(database, input.institutionId, (transaction) => transaction.selectFrom('organizational_units').select(['id', 'code', 'name', 'parent_id', 'status']).where('institution_id', '=', input.institutionId).orderBy('name').execute());
}

async function assertUnitParent(transaction: DatabaseTransaction, institutionId: string, unitId: string | undefined, parentId: string | null | undefined): Promise<void> {
  if (parentId === undefined || parentId === null) return;
  if (unitId !== undefined && parentId === unitId) throw new DomainInvariantError('UNIT_HIERARCHY_INVALID', 'An organizational unit cannot be its own parent');
  const parent = await transaction.selectFrom('organizational_units').select('id').where('institution_id', '=', institutionId).where('id', '=', parentId).executeTakeFirst();
  if (parent === undefined) throw new DomainInvariantError('UNIT_PARENT_NOT_FOUND', 'Organizational unit parent was not found in this institution');
  const visited = new Set<string>(unitId === undefined ? [] : [unitId]);
  let cursor: string | null = parentId;
  while (cursor !== null) {
    if (visited.has(cursor)) throw new DomainInvariantError('UNIT_HIERARCHY_INVALID', 'Organizational unit hierarchy contains a cycle');
    visited.add(cursor);
    const row = await transaction.selectFrom('organizational_units').select('parent_id').where('institution_id', '=', institutionId).where('id', '=', cursor).executeTakeFirst();
    cursor = row?.parent_id ?? null;
  }
}

export async function createAdminUnit(database: Database, input: { readonly institutionId: string; readonly actorUserId: string; readonly code: string; readonly name: string; readonly parentId?: string | null; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<AdminUnitRecord> {
  requireCapability({ ...input, capability: 'identity.manage' });
  const code = input.code.trim(); const name = input.name.trim();
  if (code.length === 0 || name.length === 0) throw new DomainInvariantError('INVALID_UNIT', 'Unit code and name are required');
  const id = randomUUID();
  return withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'organizational_unit.created', aggregateType: 'organizational_unit', aggregateId: id, correlationId: input.correlationId, afterData: { code, name, parentId: input.parentId ?? null } }, async (transaction) => {
    await assertUnitParent(transaction, input.institutionId, undefined, input.parentId);
    await transaction.insertInto('organizational_units').values({ id, institution_id: input.institutionId, code, name, parent_id: input.parentId ?? null, status: 'ACTIVE' }).execute();
    return { id, code, name, parent_id: input.parentId ?? null, status: 'ACTIVE' };
  });
}

export async function updateAdminUnit(database: Database, input: { readonly institutionId: string; readonly actorUserId: string; readonly unitId: string; readonly name?: string; readonly parentId?: string | null; readonly status?: 'ACTIVE' | 'INACTIVE'; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<AdminUnitRecord> {
  requireCapability({ ...input, capability: 'identity.manage' });
  return withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'organizational_unit.updated', aggregateType: 'organizational_unit', aggregateId: input.unitId, correlationId: input.correlationId, afterData: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.parentId === undefined ? {} : { parentId: input.parentId }), ...(input.status === undefined ? {} : { status: input.status }) } }, async (transaction) => {
    const current = await transaction.selectFrom('organizational_units').select(['id', 'code', 'name', 'parent_id', 'status']).where('institution_id', '=', input.institutionId).where('id', '=', input.unitId).forUpdate().executeTakeFirst();
    if (current === undefined) throw new DomainInvariantError('UNIT_NOT_FOUND', 'Organizational unit not found');
    const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
    await assertUnitParent(transaction, input.institutionId, input.unitId, parentId);
    const name = input.name === undefined ? current.name : input.name.trim();
    if (name.length === 0) throw new DomainInvariantError('INVALID_UNIT', 'Unit name is required');
    await transaction.updateTable('organizational_units').set({ name, parent_id: parentId, ...(input.status === undefined ? {} : { status: input.status }), updated_at: now() }).where('institution_id', '=', input.institutionId).where('id', '=', input.unitId).execute();
    return { ...current, name, parent_id: parentId, status: input.status ?? current.status };
  });
}

export interface AdminAssignmentRecord { readonly id: string; readonly user_id: string; readonly role_id: string; readonly role_code: string; readonly role_name: string; readonly unit_id: string | null; readonly unit_name: string | null; readonly capabilities: readonly string[]; readonly effective_from: Date; readonly effective_until: Date | null; }
export interface AdminUserRecord { readonly id: string; readonly display_name: string; readonly status: 'ACTIVE' | 'DISABLED'; readonly assignments: readonly AdminAssignmentRecord[]; }
export async function findAdminUsers(database: Database, input: { readonly institutionId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly AdminUserRecord[]> {
  requireCapability({ ...input, capability: 'identity.manage' });
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const users = await transaction.selectFrom('users').select(['id', 'display_name', 'status']).where('institution_id', '=', input.institutionId).orderBy('display_name').execute();
    const assignments = await transaction.selectFrom('user_role_assignments as a').innerJoin('roles as r', 'r.id', 'a.role_id').leftJoin('organizational_units as u', (join) => join.onRef('u.id', '=', 'a.unit_id').onRef('u.institution_id', '=', 'a.institution_id')).select(['a.id', 'a.user_id', 'a.role_id', 'r.code as role_code', 'r.name as role_name', 'a.unit_id', 'u.name as unit_name', 'a.effective_from', 'a.effective_until']).where('a.institution_id', '=', input.institutionId).orderBy('a.created_at').execute();
    const permissionRows = assignments.length === 0 ? [] : await transaction.selectFrom('role_permissions as rp').innerJoin('permissions as p', 'p.id', 'rp.permission_id').select(['rp.role_id', 'p.code']).where('rp.role_id', 'in', [...new Set(assignments.map((row) => row.role_id))]).execute();
    const permissions = new Map<string, string[]>(); for (const row of permissionRows) permissions.set(row.role_id, [...(permissions.get(row.role_id) ?? []), row.code]);
    return users.map((user) => ({ ...user, assignments: assignments.filter((assignment) => assignment.user_id === user.id).map((assignment) => ({ ...assignment, capabilities: permissions.get(assignment.role_id) ?? [] })) }));
  });
}

export async function findAdminCapabilities(database: Database, input: { readonly institutionId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly { readonly code: string; readonly name: string }[]> {
  requireCapability({ ...input, capability: 'identity.manage' });
  return withTenantTransaction(database, input.institutionId, (transaction) => transaction.selectFrom('permissions').select(['code', 'name']).where('code', 'in', [...capabilities]).orderBy('code').execute());
}

export async function findAdminRoles(database: Database, input: { readonly institutionId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly { readonly id: string; readonly code: string; readonly name: string }[]> {
  requireCapability({ ...input, capability: 'identity.manage' });
  return withTenantTransaction(database, input.institutionId, (transaction) => transaction.selectFrom('roles').select(['id', 'code', 'name']).orderBy('name').execute());
}

export async function createAdminAssignment(database: Database, input: { readonly institutionId: string; readonly actorUserId: string; readonly userId: string; readonly roleId: string; readonly unitId?: string | null; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<void> {
  requireCapability({ ...input, capability: 'identity.manage' });
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'identity.assignment.created', aggregateType: 'user', aggregateId: input.userId, correlationId: input.correlationId, eventData: { roleId: input.roleId, unitId: input.unitId ?? null } }, async (transaction) => {
    const user = await transaction.selectFrom('users').select('id').where('institution_id', '=', input.institutionId).where('id', '=', input.userId).executeTakeFirst();
    if (user === undefined) throw new DomainInvariantError('USER_NOT_FOUND', 'User not found in this institution');
    const role = await transaction.selectFrom('roles').select('id').where('id', '=', input.roleId).executeTakeFirst();
    if (role === undefined) throw new DomainInvariantError('ROLE_NOT_FOUND', 'Role not found');
    if (input.unitId !== undefined && input.unitId !== null && await transaction.selectFrom('organizational_units').select('id').where('institution_id', '=', input.institutionId).where('id', '=', input.unitId).where('status', '=', 'ACTIVE').executeTakeFirst() === undefined) throw new DomainInvariantError('UNIT_NOT_FOUND', 'Unit not found in this institution');
    await transaction.insertInto('user_role_assignments').values({ id: randomUUID(), institution_id: input.institutionId, user_id: input.userId, role_id: input.roleId, unit_id: input.unitId ?? null, effective_from: now() }).execute();
  });
}

export async function revokeAdminAssignment(database: Database, input: { readonly institutionId: string; readonly actorUserId: string; readonly assignmentId: string; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<void> {
  requireCapability({ ...input, capability: 'identity.manage' });
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'identity.assignment.revoked', aggregateType: 'user_role_assignment', aggregateId: input.assignmentId, correlationId: input.correlationId }, async (transaction) => {
    const assignment = await transaction.selectFrom('user_role_assignments').select(['id', 'effective_until']).where('institution_id', '=', input.institutionId).where('id', '=', input.assignmentId).forUpdate().executeTakeFirst();
    if (assignment === undefined) throw new DomainInvariantError('ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    if (assignment.effective_until === null) await transaction.updateTable('user_role_assignments').set({ effective_until: now() }).where('institution_id', '=', input.institutionId).where('id', '=', input.assignmentId).execute();
  });
}

export interface AdminTypeVersionRecord { readonly id: string; readonly version_number: number; readonly status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'; readonly schema_json: JsonObject; readonly archival_mapping_json: JsonObject; readonly created_at: Date; readonly published_at: Date | null; }
export interface AdminTypeRecord { readonly id: string; readonly code: string; readonly name: string; readonly status: 'ACTIVE' | 'RETIRED'; readonly versions: readonly AdminTypeVersionRecord[]; }
export async function findAdminExpedienteTypes(database: Database, input: { readonly institutionId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly AdminTypeRecord[]> {
  if (input.authorizationContext.institutionId !== String(input.institutionId) || (!canPerform(input.authorizationContext, 'expediente_type.manage_draft') && !canPerform(input.authorizationContext, 'expediente_type.publish'))) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente type administration is not authorized');
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const types = await transaction.selectFrom('expediente_types').select(['id', 'code', 'name', 'status']).where('institution_id', '=', input.institutionId).orderBy('name').execute();
    const versions = await transaction.selectFrom('expediente_type_versions').select(['id', 'expediente_type_id', 'version_number', 'status', 'schema_json', 'archival_mapping_json', 'created_at', 'published_at']).where('institution_id', '=', input.institutionId).orderBy('version_number', 'desc').execute();
    return types.map((type) => ({ ...type, versions: versions.filter((version) => version.expediente_type_id === type.id) }));
  });
}

export async function createAdminExpedienteType(database: Database, input: { readonly institutionId: string; readonly actorUserId: string; readonly code: string; readonly name: string; readonly schema: JsonObject; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<void> {
  requireCapability({ ...input, capability: 'expediente_type.manage_draft' });
  createExpedienteSchemaValidator().validateDefinition(input.schema);
  const typeId = randomUUID();
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'expediente_type.created', aggregateType: 'expediente_type', aggregateId: typeId, correlationId: input.correlationId, afterData: { code: input.code, name: input.name } }, async (transaction) => {
    await transaction.insertInto('expediente_types').values({ id: typeId, institution_id: input.institutionId, code: input.code.trim(), name: input.name.trim(), status: 'ACTIVE' }).execute();
    await transaction.insertInto('expediente_type_versions').values({ id: randomUUID(), institution_id: input.institutionId, expediente_type_id: typeId, version_number: 1, status: 'DRAFT', schema_json: input.schema, archival_mapping_json: { levelOfDescription: 'File' } }).execute();
  });
}

export async function updateAdminExpedienteDraft(database: Database, input: { readonly institutionId: string; readonly actorUserId: string; readonly versionId: string; readonly schema: JsonObject; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<void> {
  requireCapability({ ...input, capability: 'expediente_type.manage_draft' });
  createExpedienteSchemaValidator().validateDefinition(input.schema);
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'expediente_type_version.updated', aggregateType: 'expediente_type_version', aggregateId: input.versionId, correlationId: input.correlationId, afterData: { schemaUpdated: true } }, async (transaction) => {
    const draft = await transaction.selectFrom('expediente_type_versions').select('status').where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).forUpdate().executeTakeFirst();
    if (draft === undefined) throw new DomainInvariantError('VERSION_NOT_FOUND', 'Expediente type version not found');
    if (draft.status !== 'DRAFT') throw new DomainInvariantError('VERSION_IMMUTABLE', 'Published expediente type versions cannot be edited');
    await transaction.updateTable('expediente_type_versions').set({ schema_json: input.schema }).where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).execute();
  });
}

export async function publishAdminExpedienteDraft(database: Database, input: { readonly institutionId: string; readonly actorUserId: string; readonly versionId: string; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<void> {
  requireCapability({ ...input, capability: 'expediente_type.publish' });
  const validator = createExpedienteSchemaValidator();
  await publishExpedienteTypeVersionAtomically(database, { institutionId: input.institutionId, versionId: input.versionId, actorUserId: input.actorUserId, correlationId: input.correlationId, publishedAt: now() }, (schema) => validator.validateDefinition(schema));
}

export async function findAdminClassification(database: Database, input: { readonly institutionId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly { readonly id: string; readonly parent_id: string | null; readonly node_type: 'FONDS' | 'SECTION' | 'SERIES' | 'SUBSERIES'; readonly code: string; readonly name: string; readonly metadata: JsonObject }[]> {
  requireCapability({ ...input, capability: 'records.read' });
  return withTenantTransaction(database, input.institutionId, (transaction) => transaction.selectFrom('archival_classification_nodes').select(['id', 'parent_id', 'node_type', 'code', 'name', 'metadata']).where('institution_id', '=', input.institutionId).orderBy('node_type').orderBy('code').execute());
}
