import { Type, type Static } from '@sinclair/typebox';

const Uuid = Type.String({ format: 'uuid' });
const JsonObject = Type.Record(Type.String(), Type.Unknown());

export const ExpedienteCreateRequestSchema = Type.Object({
  expedienteTypeVersionId: Uuid,
  metadata: JsonObject,
}, { additionalProperties: false, $id: 'ExpedienteCreateRequest' });
export type ExpedienteCreateRequest = Static<typeof ExpedienteCreateRequestSchema>;

export const ExpedienteResponseSchema = Type.Object({
  id: Uuid,
  folio: Type.String({ pattern: '^EXP-[0-9]{4}-[0-9]{6}$' }),
  status: Type.Union([
    Type.Literal('OPEN'), Type.Literal('CLOSED'), Type.Literal('TRANSFER_PENDING'), Type.Literal('TRANSFERRED'), Type.Literal('VOIDED'),
  ]),
  expedienteTypeVersionId: Uuid,
  metadata: JsonObject,
  openedAt: Type.String({ format: 'date-time' }),
  closedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false, $id: 'ExpedienteResponse' });
export type ExpedienteResponse = Static<typeof ExpedienteResponseSchema>;

export const ExpedienteIdParamsSchema = Type.Object({ expedienteId: Uuid }, { additionalProperties: false, $id: 'ExpedienteIdParams' });
export type ExpedienteIdParams = Static<typeof ExpedienteIdParamsSchema>;

export const ExpedienteCloseRequestSchema = Type.Object({
  closureMetadata: JsonObject,
}, { additionalProperties: false, $id: 'ExpedienteCloseRequest' });
export type ExpedienteCloseRequest = Static<typeof ExpedienteCloseRequestSchema>;
export const ExpedienteReopenRequestSchema = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false, $id: 'ExpedienteReopenRequest' });
export type ExpedienteReopenRequest = Static<typeof ExpedienteReopenRequestSchema>;

export const ExpedienteListResponseSchema = Type.Object({ items: Type.Array(ExpedienteResponseSchema) }, { additionalProperties: false, $id: 'ExpedienteListResponse' });
export type ExpedienteListResponse = Static<typeof ExpedienteListResponseSchema>;
export const PublishedExpedienteTypeVersionSchema = Type.Object({ id: Uuid, expedienteTypeId: Uuid, code: Type.String(), name: Type.String(), versionNumber: Type.Integer({ minimum: 1 }), schema: JsonObject }, { additionalProperties: false, $id: 'PublishedExpedienteTypeVersion' });
export type PublishedExpedienteTypeVersion = Static<typeof PublishedExpedienteTypeVersionSchema>;
export const PublishedExpedienteTypeVersionsResponseSchema = Type.Object({ items: Type.Array(PublishedExpedienteTypeVersionSchema) }, { additionalProperties: false, $id: 'PublishedExpedienteTypeVersionsResponse' });
export type PublishedExpedienteTypeVersionsResponse = Static<typeof PublishedExpedienteTypeVersionsResponseSchema>;
