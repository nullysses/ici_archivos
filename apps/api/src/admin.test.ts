import { describe, expect, it } from 'vitest';
import { AdminHttpError, mapAdminError } from './admin.js';

describe('administrative error boundary', () => {
  it('maps known domain conflicts without exposing internals as request errors', () => {
    const result = mapAdminError(Object.assign(new Error('unit hierarchy conflict'), { code: 'UNIT_HIERARCHY_INVALID' }));
    expect(result).toBeInstanceOf(AdminHttpError);
    expect(result.statusCode).toBe(409);
    expect(result.code).toBe('CONFLICT');
  });

  it('returns a safe 500 for unexpected infrastructure failures', () => {
    const result = mapAdminError(new Error('duplicate key value reveals internal index name'));
    expect(result.statusCode).toBe(500);
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.message).not.toContain('duplicate key');
  });

  it('maps PostgreSQL unique violations to a safe conflict message', () => {
    const result = mapAdminError(Object.assign(new Error('duplicate key value violates unique constraint users_secret_index'), { code: '23505' }));
    expect(result.statusCode).toBe(409);
    expect(result.code).toBe('CONFLICT');
    expect(result.message).not.toContain('users_secret_index');
  });

  it('maps PostgreSQL foreign-key violations to a safe conflict message', () => {
    const result = mapAdminError(Object.assign(new Error('insert or update violates foreign key constraint organizational_units_parent_id_fkey'), { code: '23503' }));
    expect(result.statusCode).toBe(409);
    expect(result.code).toBe('CONFLICT');
    expect(result.message).not.toContain('organizational_units_parent_id_fkey');
  });
});
