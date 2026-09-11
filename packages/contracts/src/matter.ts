import { Type, type Static } from '@sinclair/typebox';

const Uuid = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const NonBlank = (maxLength: number) => Type.String({ minLength: 1, maxLength });

export const MatterRegistrationRequestSchema = Type.Object({
  sender: NonBlank(500),
  destinationUnitId: Uuid,
  subject: NonBlank(500),
  description: NonBlank(10_000),
  priority: NonBlank(100),
  channel: NonBlank(100),
  receivedAt: DateTime,
  dueAt: Type.Optional(DateTime),
  accessClassificationId: Uuid,
  operationalVisibility: Type.Union([
    Type.Literal('INSTITUTION'),
    Type.Literal('UNIT'),
    Type.Literal('RESTRICTED_GROUP'),
  ]),
}, { additionalProperties: false, $id: 'MatterRegistrationRequest' });

export type MatterRegistrationRequest = Static<typeof MatterRegistrationRequestSchema>;

const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());

export const MatterResponseSchema = Type.Object({
  id: Uuid,
  folio: Type.String({ pattern: '^OP-[0-9]{4}-[0-9]{6}$' }),
  status: Type.Union([
    Type.Literal('RECEIVED'),
    Type.Literal('ASSIGNED'),
    Type.Literal('IN_PROGRESS'),
    Type.Literal('RESOLVED'),
    Type.Literal('CLOSED'),
    Type.Literal('VOIDED'),
  ]),
  receivedAt: DateTime,
  dueAt: Type.Optional(DateTime),
  sender: Type.String(),
  subject: Type.String(),
  description: Type.String(),
  priority: Type.String(),
  channel: Type.String(),
  destinationUnitId: Type.Union([Uuid, Type.Null()]),
  accessClassificationId: Type.Union([Uuid, Type.Null()]),
  operationalVisibility: Type.Union([
    Type.Literal('INSTITUTION'),
    Type.Literal('UNIT'),
    Type.Literal('RESTRICTED_GROUP'),
    Type.Null(),
  ]),
  resolutionMetadata: Type.Union([JsonObjectSchema, Type.Null()]),
  closureMetadata: Type.Union([JsonObjectSchema, Type.Null()]),
  linkedExpedienteId: Type.Union([Uuid, Type.Null()]),
  createdBy: Type.Union([Uuid, Type.Null()]),
  createdAt: DateTime,
  updatedAt: DateTime,
}, { additionalProperties: false, $id: 'MatterResponse' });

export type MatterResponse = Static<typeof MatterResponseSchema>;

export const MatterAssignmentRequestSchema = Type.Object({
  unitId: Uuid,
  userId: Type.Optional(Uuid),
  reason: Type.Optional(NonBlank(4000)),
}, { additionalProperties: false, $id: 'MatterAssignmentRequest' });
export type MatterAssignmentRequest = Static<typeof MatterAssignmentRequestSchema>;

export const MatterInboxItemSchema = Type.Intersect([
  MatterResponseSchema,
  Type.Object({
    assignmentUnitId: Uuid,
    assignmentUserId: Type.Union([Uuid, Type.Null()]),
    assignedAt: DateTime,
  }),
], { $id: 'MatterInboxItem' });
export type MatterInboxItem = Static<typeof MatterInboxItemSchema>;

export const MatterInboxResponseSchema = Type.Object({
  items: Type.Array(MatterInboxItemSchema),
}, { additionalProperties: false, $id: 'MatterInboxResponse' });
export type MatterInboxResponse = Static<typeof MatterInboxResponseSchema>;

export const MatterIdParamsSchema = Type.Object({ id: Uuid }, { additionalProperties: false, $id: 'MatterIdParams' });
export type MatterIdParams = Static<typeof MatterIdParamsSchema>;

export const MatterFolioParamsSchema = Type.Object({ folio: Type.String({ pattern: '^OP-[0-9]{4}-[0-9]{6}$' }) }, { additionalProperties: false, $id: 'MatterFolioParams' });
export type MatterFolioParams = Static<typeof MatterFolioParamsSchema>;

export const MatterErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
}, { additionalProperties: false, $id: 'MatterError' });
