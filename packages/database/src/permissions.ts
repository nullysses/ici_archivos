import type { DatabaseTransaction } from './index.js';

export const capabilities = [
  'matter.register', 'matter.assign', 'matter.void', 'matter.start', 'matter.resolve', 'matter.reopen', 'matter.close',
  'expediente.create', 'expediente.edit_open', 'document.version_open', 'expediente.close', 'expediente.reopen',
  'archive_transfer.prepare', 'archive_transfer.approve', 'archive_transfer.retry', 'archival_description.correct', 'atom_description.publish',
  'identity.manage', 'institution.configure', 'expediente_type.manage_draft', 'expediente_type.publish', 'records.read',
] as const;
export type Capability = (typeof capabilities)[number];

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
