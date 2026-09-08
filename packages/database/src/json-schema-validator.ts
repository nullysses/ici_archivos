import { Ajv, type AnySchema } from 'ajv';
import type { ExpedienteMetadataValidator, JsonObject } from '@ici/domain';
import { DomainInvariantError } from '@ici/domain';

/** Infrastructure adapter: the domain continues to depend only on its port. */
export interface ExpedienteSchemaValidationPort {
  readonly validateMetadata: ExpedienteMetadataValidator;
  validateDefinition(schema: JsonObject): void;
}

export function createExpedienteSchemaValidator(): ExpedienteSchemaValidationPort {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const compile = (schema: JsonObject) => ajv.compile(schema as unknown as AnySchema);
  return {
    validateDefinition(schema): void {
      try { compile(schema); } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Invalid JSON Schema';
        throw new DomainInvariantError('INVALID_SCHEMA', message);
      }
    },
    validateMetadata(schema, metadata): boolean {
      try {
        const result = compile(schema)(metadata);
        return typeof result === 'boolean' ? result : false;
      } catch { return false; }
    },
  };
}
