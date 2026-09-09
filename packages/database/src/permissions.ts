import type { DatabaseTransaction } from './index.js';

export const capabilities = [
  'matter.register', 'matter.assign', 'matter.void', 'matter.start', 'matter.resolve', 'matter.reopen', 'matter.close',
  'expediente.create', 'expediente.edit_open', 'document.version_open', 'expediente.close', 'expediente.reopen',
  'archive_transfer.prepare', 'archive_transfer.approve', 'archive_transfer.retry', 'archival_description.correct', 'atom_description.publish',
  'identity.manage', 'institution.configure', 'expediente_type.manage_draft', 'expediente_type.publish', 'records.read',
] as const;
export type Capability = (typeof capabilities)[number];

const knownCapabilities = new Set<string>(capabilities);

/** Framework-independent authorization evidence resolved from ICI persistence. */
export interface AuthorizationContext {
  readonly userId: string;
  readonly institutionId: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly authorizedUnitIds: ReadonlySet<string>;
}

export async function resolveEffectivePermissions(transaction: DatabaseTransaction, institutionId: string, userId: string, at: Date = new Date()): Promise<ReadonlySet<string>> {
  const rows = await transaction.selectFrom('user_role_assignments as ura')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'ura.role_id')
    .innerJoin('permissions as p', 'p.id', 'rp.permission_id')
    .select('p.code')
    .where('ura.institution_id', '=', institutionId)
    .where('ura.user_id', '=', userId)
    .where('ura.effective_from', '<=', at)
    .where((eb) => eb.or([eb('ura.effective_until', 'is', null), eb('ura.effective_until', '>', at)]))
    .execute();
  return new Set(rows.map((row) => row.code));
}

export async function hasEffectivePermission(transaction: DatabaseTransaction, institutionId: string, userId: string, capability: Capability, at?: Date): Promise<boolean> {
  return (await resolveEffectivePermissions(transaction, institutionId, userId, at)).has(capability);
}

export async function resolveAuthorizedUnitIds(transaction: DatabaseTransaction, institutionId: string, userId: string, at: Date = new Date()): Promise<ReadonlySet<string>> {
  const rows = await transaction.selectFrom('user_role_assignments')
    .select('unit_id')
    .where('institution_id', '=', institutionId)
    .where('user_id', '=', userId)
    .where('effective_from', '<=', at)
    .where((eb) => eb.or([eb('effective_until', 'is', null), eb('effective_until', '>', at)]))
    .where('unit_id', 'is not', null)
    .execute();
  return new Set(rows.flatMap((row) => row.unit_id === null ? [] : [row.unit_id]));
}

export async function resolveAuthorizationContext(transaction: DatabaseTransaction, institutionId: string, userId: string, at: Date = new Date()): Promise<AuthorizationContext> {
  const [permissions, authorizedUnitIds] = await Promise.all([
    resolveEffectivePermissions(transaction, institutionId, userId, at),
    resolveAuthorizedUnitIds(transaction, institutionId, userId, at),
  ]);
  const resolvedCapabilities = new Set<Capability>();
  for (const permission of permissions) if (knownCapabilities.has(permission)) resolvedCapabilities.add(permission as Capability);
  return { userId, institutionId, capabilities: resolvedCapabilities, authorizedUnitIds };
}
