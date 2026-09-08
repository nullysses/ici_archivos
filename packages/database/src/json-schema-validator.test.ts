import { describe, expect, it } from 'vitest';
import { createExpedienteSchemaValidator } from './json-schema-validator.js';

describe('Expediente JSON Schema validation adapter', () => {
  it('rejects an invalid schema and validates metadata through the domain port', () => {
    const validator = createExpedienteSchemaValidator();
    expect(() => validator.validateDefinition({ type: 17 })).toThrow('schema');
    const schema = { type: 'object', required: ['subject'], properties: { subject: { type: 'string', minLength: 1 } }, additionalProperties: false } as const;
    validator.validateDefinition(schema);
    expect(validator.validateMetadata(schema, { subject: 'record' })).toBe(true);
    expect(validator.validateMetadata(schema, {})).toBe(false);
  });
});
