import { capabilities, type AuthorizationContext, type Capability } from '@ici/domain';
import type { DatabaseTransaction } from './index.js';

export { capabilities, canPerform } from '@ici/domain';
export type { AuthorizationContext, Capability } from '@ici/domain';

const knownCapabilities = new Set<string>(capabilities);

/** Institution-only grants. Unit-scoped grants are intentionally excluded. */
export async function resolveEffectivePermissions(transaction: DatabaseTransaction, institutionId: string, userId: string, at: Date = new Date()): Promise<ReadonlySet<Capability>> {
  return (await resolveAuthorizationContext(transaction, institutionId, userId, at)).institutionCapabilities;
}

export async function hasEffectivePermission(transaction: DatabaseTransaction, institutionId: string, userId: string, capability: Capability, at?: Date): Promise<boolean> {
  return (await resolveEffectivePermissions(transaction, institutionId, userId, at)).has(capability);
}

export async function resolveAuthorizationContext(transaction: DatabaseTransaction, institutionId: string, userId: string, at: Date = new Date()): Promise<AuthorizationContext> {
  const rows = await transaction.selectFrom('user_role_assignments as ura')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'ura.role_id')
    .innerJoin('permissions as p', 'p.id', 'rp.permission_id')
    .select(['p.code', 'ura.unit_id'])
    .where('ura.institution_id', '=', institutionId)
    .where('ura.user_id', '=', userId)
    .where('ura.effective_from', '<=', at)
    .where((eb) => eb.or([eb('ura.effective_until', 'is', null), eb('ura.effective_until', '>', at)]))
    .execute();
  const institutionCapabilities = new Set<Capability>();
  const mutableUnitCapabilities = new Map<string, Set<Capability>>();
  for (const row of rows) {
    if (!knownCapabilities.has(row.code)) continue;
    const capability = row.code as Capability;
    if (row.unit_id === null) {
      institutionCapabilities.add(capability);
      continue;
    }
    const unitGrants = mutableUnitCapabilities.get(row.unit_id) ?? new Set<Capability>();
    unitGrants.add(capability);
    mutableUnitCapabilities.set(row.unit_id, unitGrants);
  }
  return { userId, institutionId, institutionCapabilities, unitCapabilities: mutableUnitCapabilities };
}
