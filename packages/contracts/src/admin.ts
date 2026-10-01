import { Type, type Static } from '@sinclair/typebox';

const Uuid = Type.String({ format: 'uuid' });
const JsonObject = Type.Record(Type.String(), Type.Unknown());

export const AdminInstitutionSchema = Type.Object({ id: Uuid, code: Type.String(), name: Type.String(), status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('SUSPENDED')]) }, { additionalProperties: false });
export type AdminInstitution = Static<typeof AdminInstitutionSchema>;
export const AdminInstitutionResponseSchema = Type.Object({ institution: AdminInstitutionSchema }, { additionalProperties: false });
export type AdminInstitutionResponse = Static<typeof AdminInstitutionResponseSchema>;
export const AdminInstitutionUpdateSchema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export type AdminInstitutionUpdate = Static<typeof AdminInstitutionUpdateSchema>;

export const AdminUnitSchema = Type.Object({ id: Uuid, code: Type.String(), name: Type.String(), parentId: Type.Union([Uuid, Type.Null()]), status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')]) }, { additionalProperties: false });
export type AdminUnit = Static<typeof AdminUnitSchema>;
export const AdminUnitsResponseSchema = Type.Object({ items: Type.Array(AdminUnitSchema) }, { additionalProperties: false });
export type AdminUnitsResponse = Static<typeof AdminUnitsResponseSchema>;
export const AdminUnitCreateSchema = Type.Object({ code: Type.String({ minLength: 1, maxLength: 80 }), name: Type.String({ minLength: 1, maxLength: 200 }), parentId: Type.Optional(Type.Union([Uuid, Type.Null()])) }, { additionalProperties: false });
export type AdminUnitCreate = Static<typeof AdminUnitCreateSchema>;
export const AdminUnitUpdateSchema = Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), parentId: Type.Optional(Type.Union([Uuid, Type.Null()])), status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')])) }, { additionalProperties: false, minProperties: 1 });
export type AdminUnitUpdate = Static<typeof AdminUnitUpdateSchema>;
export const AdminUnitParamsSchema = Type.Object({ unitId: Uuid }, { additionalProperties: false });

export const AdminCapabilitySchema = Type.Object({ code: Type.String(), name: Type.String() }, { additionalProperties: false });
export const AdminAssignmentSchema = Type.Object({ id: Uuid, userId: Uuid, roleId: Uuid, roleCode: Type.String(), roleName: Type.String(), unitId: Type.Union([Uuid, Type.Null()]), unitName: Type.Union([Type.String(), Type.Null()]), capabilities: Type.Array(Type.String()), effectiveFrom: Type.String({ format: 'date-time' }), effectiveUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]) }, { additionalProperties: false });
export type AdminAssignment = Static<typeof AdminAssignmentSchema>;
export const AdminUserSchema = Type.Object({ id: Uuid, displayName: Type.String(), status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('DISABLED')]), assignments: Type.Array(AdminAssignmentSchema) }, { additionalProperties: false });
export type AdminUser = Static<typeof AdminUserSchema>;
export const AdminUsersResponseSchema = Type.Object({ items: Type.Array(AdminUserSchema) }, { additionalProperties: false });
export type AdminUsersResponse = Static<typeof AdminUsersResponseSchema>;
export const AdminCapabilitiesResponseSchema = Type.Object({ items: Type.Array(AdminCapabilitySchema) }, { additionalProperties: false });
export type AdminCapabilitiesResponse = Static<typeof AdminCapabilitiesResponseSchema>;
export const AdminAssignmentCreateSchema = Type.Object({ roleId: Uuid, unitId: Type.Optional(Type.Union([Uuid, Type.Null()])) }, { additionalProperties: false });
export type AdminAssignmentCreate = Static<typeof AdminAssignmentCreateSchema>;
export const AdminRoleSchema = Type.Object({ id: Uuid, code: Type.String(), name: Type.String() }, { additionalProperties: false });
export const AdminRolesResponseSchema = Type.Object({ items: Type.Array(AdminRoleSchema) }, { additionalProperties: false });
export const AdminUserParamsSchema = Type.Object({ userId: Uuid }, { additionalProperties: false });
export const AdminAssignmentParamsSchema = Type.Object({ assignmentId: Uuid }, { additionalProperties: false });

export const AdminTypeVersionSchema = Type.Object({ id: Uuid, versionNumber: Type.Integer(), status: Type.Union([Type.Literal('DRAFT'), Type.Literal('PUBLISHED'), Type.Literal('RETIRED')]), schema: JsonObject, archivalMapping: JsonObject, createdAt: Type.String({ format: 'date-time' }), publishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]) }, { additionalProperties: false });
export const AdminExpedienteTypeSchema = Type.Object({ id: Uuid, code: Type.String(), name: Type.String(), status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('RETIRED')]), versions: Type.Array(AdminTypeVersionSchema) }, { additionalProperties: false });
export type AdminExpedienteType = Static<typeof AdminExpedienteTypeSchema>;
export const AdminExpedienteTypesResponseSchema = Type.Object({ items: Type.Array(AdminExpedienteTypeSchema) }, { additionalProperties: false });
export type AdminExpedienteTypesResponse = Static<typeof AdminExpedienteTypesResponseSchema>;
export const AdminExpedienteTypeCreateSchema = Type.Object({ code: Type.String({ minLength: 1, maxLength: 80 }), name: Type.String({ minLength: 1, maxLength: 200 }), schema: JsonObject }, { additionalProperties: false });
export type AdminExpedienteTypeCreate = Static<typeof AdminExpedienteTypeCreateSchema>;
export const AdminExpedienteTypeUpdateSchema = Type.Object({ schema: JsonObject }, { additionalProperties: false });
export type AdminExpedienteTypeUpdate = Static<typeof AdminExpedienteTypeUpdateSchema>;
export const AdminVersionParamsSchema = Type.Object({ versionId: Uuid }, { additionalProperties: false });

export const AdminClassificationNodeSchema = Type.Object({ id: Uuid, parentId: Type.Union([Uuid, Type.Null()]), nodeType: Type.Union([Type.Literal('FONDS'), Type.Literal('SECTION'), Type.Literal('SERIES'), Type.Literal('SUBSERIES')]), code: Type.String(), name: Type.String(), metadata: JsonObject }, { additionalProperties: false });
export type AdminClassificationNode = Static<typeof AdminClassificationNodeSchema>;
export const AdminClassificationResponseSchema = Type.Object({ items: Type.Array(AdminClassificationNodeSchema), readOnly: Type.Literal(true), reason: Type.String() }, { additionalProperties: false });
export type AdminClassificationResponse = Static<typeof AdminClassificationResponseSchema>;
