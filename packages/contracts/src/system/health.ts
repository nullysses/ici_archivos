import { Type, type Static } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object(
  {
    dependencies: Type.Object({ database: Type.Union([Type.Literal('up'), Type.Literal('down')]) }),
    service: Type.Literal('ici-api'),
    status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
    timestamp: Type.String({ format: 'date-time' }),
    version: Type.String(),
  },
  { $id: 'HealthResponse' },
);

export type HealthResponse = Static<typeof HealthResponseSchema>;

