import type { Database } from './index.js';
import { withTenantTransaction } from './index.js';
import { capabilities } from './permissions.js';

export const developmentSeedIds = {
  institution: '00000000-0000-4000-8000-000000000001',
  administrator: '00000000-0000-4000-8000-000000000002',
  officialia: '00000000-0000-4000-8000-000000000003',
  archive: '00000000-0000-4000-8000-000000000004',
  adminUser: '00000000-0000-4000-8000-000000000005',
} as const;

const roleCapabilities: Readonly<Record<string, readonly string[]>> = {
  ADMINISTRATOR: ['identity.manage', 'institution.configure', 'archive_transfer.retry', 'records.read'],
  OFICIALIA: ['matter.register', 'matter.assign', 'matter.void', 'records.read'],
  GESTOR: ['matter.start', 'matter.resolve', 'matter.reopen', 'matter.close', 'expediente.create', 'expediente.edit_open', 'document.version_open', 'expediente.close', 'expediente.reopen', 'records.read'],
  ARCHIVISTA: ['expediente.reopen', 'archive_transfer.prepare', 'archive_transfer.approve', 'archive_transfer.retry', 'archival_description.correct', 'atom_description.publish', 'expediente_type.manage_draft', 'expediente_type.publish', 'records.read'],
  CONSULTA: ['records.read'],
};

/** Deterministic non-authentication seed; it intentionally creates no password or external identity. */
export async function seedDevelopmentReferenceData(database: Database): Promise<void> {
  await database.insertInto('institutions').values({ id: developmentSeedIds.institution, code: 'TEST', name: 'Test Institution', status: 'ACTIVE' }).onConflict((oc) => oc.column('id').doNothing()).execute();
  const roles = Object.keys(roleCapabilities);
  for (const code of roles) await database.insertInto('roles').values({ id: `10000000-0000-4000-8000-${String(roles.indexOf(code) + 1).padStart(12, '0')}`, code, name: code }).onConflict((oc) => oc.column('code').doNothing()).execute();
  for (const code of capabilities) await database.insertInto('permissions').values({ id: `20000000-0000-4000-8000-${String(capabilities.indexOf(code) + 1).padStart(12, '0')}`, code, name: code }).onConflict((oc) => oc.column('code').doNothing()).execute();
  for (const [role, granted] of Object.entries(roleCapabilities)) for (const permission of granted) await database.insertInto('role_permissions').values({ role_id: `10000000-0000-4000-8000-${String(roles.indexOf(role) + 1).padStart(12, '0')}`, permission_id: `20000000-0000-4000-8000-${String(capabilities.indexOf(permission as (typeof capabilities)[number]) + 1).padStart(12, '0')}` }).onConflict((oc) => oc.doNothing()).execute();
  await withTenantTransaction(database, developmentSeedIds.institution, async (tx) => {
    for (const [id, code, name] of [[developmentSeedIds.officialia, 'OFI', 'Oficialía'], [developmentSeedIds.archive, 'ARC', 'Archivo']] as const) await tx.insertInto('organizational_units').values({ id, institution_id: developmentSeedIds.institution, code, name, status: 'ACTIVE' }).onConflict((oc) => oc.columns(['institution_id', 'id']).doNothing()).execute();
    await tx.insertInto('users').values({ id: developmentSeedIds.adminUser, institution_id: developmentSeedIds.institution, display_name: 'Seed Administrator', status: 'ACTIVE' }).onConflict((oc) => oc.columns(['institution_id', 'id']).doNothing()).execute();
    await tx.insertInto('user_role_assignments').values({ id: '30000000-0000-4000-8000-000000000001', institution_id: developmentSeedIds.institution, user_id: developmentSeedIds.adminUser, role_id: '10000000-0000-4000-8000-000000000001' }).onConflict((oc) => oc.columns(['institution_id', 'id']).doNothing()).execute();
    await tx.insertInto('access_classifications').values({ id: '40000000-0000-4000-8000-000000000001', institution_id: developmentSeedIds.institution, legal_classification: 'PUBLIC', operational_visibility: 'INSTITUTION' }).onConflict((oc) => oc.columns(['institution_id', 'id']).doNothing()).execute();
    await tx.insertInto('archival_classification_nodes').values({ id: '50000000-0000-4000-8000-000000000001', institution_id: developmentSeedIds.institution, node_type: 'FONDS', code: 'FONDS', name: 'Representative fonds', metadata: {} }).onConflict((oc) => oc.columns(['institution_id', 'id']).doNothing()).execute();
  });
}
