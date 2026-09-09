import type { ColumnType, Generated } from 'kysely';
import type { JsonObject } from '@ici/domain';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type JsonColumn = ColumnType<JsonObject, JsonObject | string, JsonObject>;
type DefaultJsonColumn = ColumnType<JsonObject, JsonObject | string | undefined, JsonObject>;
type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;
type BigIntColumn = ColumnType<string, string | number, string>;

export interface InstitutionsTable {
  id: Generated<string>;
  code: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrganizationalUnitsTable {
  id: Generated<string>;
  institution_id: string;
  parent_id: Nullable<string>;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UsersTable {
  id: Generated<string>;
  institution_id: string;
  display_name: string;
  status: 'ACTIVE' | 'DISABLED';
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ExternalIdentitiesTable {
  id: Generated<string>;
  institution_id: string;
  user_id: string;
  issuer: string;
  subject: string;
  email_snapshot: Nullable<string>;
  last_seen_at: Nullable<Date>;
  created_at: Timestamp;
}

export interface RolesTable {
  id: Generated<string>;
  code: string;
  name: string;
  created_at: Timestamp;
}

export interface PermissionsTable {
  id: Generated<string>;
  code: string;
  name: string;
  created_at: Timestamp;
}

export interface RolePermissionsTable {
  role_id: string;
  permission_id: string;
  created_at: Timestamp;
}

export interface UserRoleAssignmentsTable {
  id: Generated<string>;
  institution_id: string;
  user_id: string;
  role_id: string;
  unit_id: Nullable<string>;
  effective_from: Timestamp;
  effective_until: Nullable<Date>;
  created_at: Timestamp;
}

export interface FolioCountersTable {
  institution_id: string;
  folio_kind: 'MATTER' | 'EXPEDIENTE';
  folio_year: number;
  next_value: BigIntColumn;
}

export interface MattersTable {
  id: Generated<string>;
  institution_id: string;
  folio: string;
  folio_year: number;
  sequence_number: BigIntColumn;
  status: 'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'VOIDED';
  received_at: Timestamp;
  intake_metadata: JsonColumn;
  linked_expediente_id: Nullable<string>;
  resolution_metadata: Nullable<JsonObject>;
  closure_metadata: Nullable<JsonObject>;
  created_by: Nullable<string>;
  destination_unit_id: Nullable<string>;
  access_classification_id: Nullable<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MatterAssignmentsTable {
  id: Generated<string>;
  institution_id: string;
  matter_id: string;
  unit_id: string;
  user_id: Nullable<string>;
  reason: Nullable<string>;
  assigned_at: Timestamp;
}

export interface MatterStateEventsTable {
  id: Generated<string>;
  institution_id: string;
  matter_id: string;
  from_status: Nullable<'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'VOIDED'>;
  to_status: 'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'VOIDED';
  command: string;
  actor_user_id: Nullable<string>;
  reason: Nullable<string>;
  event_data: JsonColumn;
  occurred_at: Timestamp;
}

export interface MatterNotesTable {
  id: Generated<string>;
  institution_id: string;
  matter_id: string;
  author_user_id: string;
  note_type: 'NOTE' | 'RESPONSE';
  content: string;
  created_at: Timestamp;
}

export interface ExpedienteTypesTable {
  id: Generated<string>;
  institution_id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'RETIRED';
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ExpedienteTypeVersionsTable {
  id: Generated<string>;
  institution_id: string;
  expediente_type_id: string;
  version_number: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  schema_json: JsonColumn;
  archival_mapping_json: JsonColumn;
  created_at: Timestamp;
  published_at: Nullable<Date>;
}

export interface ExpedientesTable {
  id: Generated<string>;
  institution_id: string;
  folio: string;
  folio_year: number;
  sequence_number: BigIntColumn;
  status: 'OPEN' | 'CLOSED' | 'TRANSFER_PENDING' | 'TRANSFERRED' | 'VOIDED';
  expediente_type_version_id: string;
  metadata: JsonColumn;
  opened_at: Timestamp;
  closed_at: Nullable<Date>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ExpedienteStateEventsTable {
  id: Generated<string>;
  institution_id: string;
  expediente_id: Nullable<string>;
  from_status: Nullable<'OPEN' | 'CLOSED' | 'TRANSFER_PENDING' | 'TRANSFERRED' | 'VOIDED'>;
  to_status: 'OPEN' | 'CLOSED' | 'TRANSFER_PENDING' | 'TRANSFERRED' | 'VOIDED';
  command: string;
  actor_user_id: Nullable<string>;
  reason: Nullable<string>;
  event_data: JsonColumn;
  occurred_at: Timestamp;
}

export interface AccessClassificationsTable {
  id: Generated<string>;
  institution_id: string;
  legal_classification: 'PUBLIC' | 'RESERVED' | 'CONFIDENTIAL';
  operational_visibility: 'INSTITUTION' | 'UNIT' | 'RESTRICTED_GROUP';
  legal_basis: Nullable<string>;
  reason: Nullable<string>;
  classification_authority: Nullable<string>;
  classified_at: Nullable<Date>;
  review_expires_at: Nullable<Date>;
  created_at: Timestamp;
}

export interface DocumentsTable {
  id: Generated<string>;
  institution_id: string;
  expediente_id: Nullable<string>;
  matter_id: Nullable<string>;
  document_type: string;
  title: string;
  current_version_id: Nullable<string>;
  access_classification_id: Nullable<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DocumentVersionsTable {
  id: Generated<string>;
  institution_id: string;
  document_id: string;
  version_number: number;
  original_filename: string;
  detected_mime_type: string;
  declared_mime_type: Nullable<string>;
  size_bytes: BigIntColumn;
  sha256: string;
  storage_key: string;
  access_classification_snapshot: DefaultJsonColumn;
  malware_scan_status: 'PENDING_SCAN' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED' | 'QUARANTINED';
  created_by: string;
  created_at: Timestamp;
  replacement_reason: Nullable<string>;
}

export interface MalwareScansTable {
  id: Generated<string>;
  institution_id: string;
  document_version_id: string;
  engine: string;
  engine_version: Nullable<string>;
  signature_version: Nullable<string>;
  result: 'PENDING_SCAN' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED' | 'QUARANTINED';
  scanned_at: Nullable<Date>;
  created_at: Timestamp;
}

export interface ArchivalClassificationNodesTable {
  id: Generated<string>;
  institution_id: string;
  parent_id: Nullable<string>;
  node_type: 'FONDS' | 'SECTION' | 'SERIES' | 'SUBSERIES';
  code: string;
  name: string;
  metadata: JsonColumn;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AtomMappingsTable {
  id: Generated<string>;
  institution_id: string;
  ici_object_type: string;
  ici_object_id: string;
  atom_information_object_id: Nullable<string>;
  atom_slug: Nullable<string>;
  last_synced_at: Nullable<Date>;
  sync_status: 'PENDING' | 'SYNCED' | 'FAILED';
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ArchiveTransfersTable {
  id: Generated<string>;
  institution_id: string;
  expediente_id: string;
  status: 'DRAFT' | 'APPROVED' | 'SUBMITTED' | 'PRESERVING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  supplements_transfer_id: Nullable<string>;
  correction_reason: Nullable<string>;
  created_by: Nullable<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TransferManifestsTable {
  id: Generated<string>;
  institution_id: string;
  transfer_id: string;
  status: 'DRAFT' | 'APPROVED';
  canonical_json: string;
  sha256: Nullable<string>;
  approved_by: Nullable<string>;
  approved_at: Nullable<Date>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ArchivalCorrectionsTable {
  id: Generated<string>;
  institution_id: string;
  transfer_id: string;
  reason: string;
  actor_user_id: string;
  old_value: JsonColumn;
  new_value: JsonColumn;
  legal_basis: Nullable<string>;
  created_at: Timestamp;
}

export interface AuditEventsTable {
  id: Generated<string>;
  institution_id: string;
  actor_user_id: Nullable<string>;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id: string;
  before_data: Nullable<JsonObject>;
  after_data: Nullable<JsonObject>;
  event_data: JsonColumn;
  occurred_at: Timestamp;
}

export interface IntegrationJobsTable {
  id: Generated<string>;
  institution_id: string;
  job_type: string;
  aggregate_type: string;
  aggregate_id: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  idempotency_key: string;
  correlation_id: string;
  attempt_count: number;
  next_attempt_at: Nullable<Date>;
  last_error: Nullable<string>;
  payload: JsonColumn;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface IciSchemaMigrationsTable {
  id: string;
  applied_at: Timestamp;
}

export interface DatabaseSchema {
  ici_schema_migrations: IciSchemaMigrationsTable;
  institutions: InstitutionsTable;
  organizational_units: OrganizationalUnitsTable;
  users: UsersTable;
  external_identities: ExternalIdentitiesTable;
  roles: RolesTable;
  permissions: PermissionsTable;
  role_permissions: RolePermissionsTable;
  user_role_assignments: UserRoleAssignmentsTable;
  folio_counters: FolioCountersTable;
  matters: MattersTable;
  matter_assignments: MatterAssignmentsTable;
  matter_state_events: MatterStateEventsTable;
  matter_notes: MatterNotesTable;
  expediente_types: ExpedienteTypesTable;
  expediente_type_versions: ExpedienteTypeVersionsTable;
  expedientes: ExpedientesTable;
  expediente_state_events: ExpedienteStateEventsTable;
  access_classifications: AccessClassificationsTable;
  documents: DocumentsTable;
  document_versions: DocumentVersionsTable;
  malware_scans: MalwareScansTable;
  archival_classification_nodes: ArchivalClassificationNodesTable;
  atom_mappings: AtomMappingsTable;
  archive_transfers: ArchiveTransfersTable;
  transfer_manifests: TransferManifestsTable;
  archival_corrections: ArchivalCorrectionsTable;
  audit_events: AuditEventsTable;
  integration_jobs: IntegrationJobsTable;
}
