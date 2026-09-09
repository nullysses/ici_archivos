export const capabilities = [
  'matter.register', 'matter.assign', 'matter.void', 'matter.start', 'matter.resolve', 'matter.reopen', 'matter.close',
  'expediente.create', 'expediente.edit_open', 'document.version_open', 'expediente.close', 'expediente.reopen',
  'archive_transfer.prepare', 'archive_transfer.approve', 'archive_transfer.retry', 'archival_description.correct', 'atom_description.publish',
  'identity.manage', 'institution.configure', 'expediente_type.manage_draft', 'expediente_type.publish', 'records.read',
] as const;

export type Capability = (typeof capabilities)[number];

/** Authorization facts retain the scope of the role assignment that granted them. */
export interface AuthorizationContext {
  readonly userId: string;
  readonly institutionId: string;
  readonly institutionCapabilities: ReadonlySet<Capability>;
  readonly unitCapabilities: ReadonlyMap<string, ReadonlySet<Capability>>;
}

export function canPerform(authorization: AuthorizationContext, capability: Capability, unitId?: string): boolean {
  if (authorization.institutionCapabilities.has(capability)) return true;
  if (unitId === undefined) return false;
  return authorization.unitCapabilities.get(unitId)?.has(capability) === true;
}
