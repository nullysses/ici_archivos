import { describe, expect, it } from 'vitest';
import { parseBearerAuthorization } from './auth-plugin.js';

describe('Bearer authorization parsing', () => {
  it.each([
    undefined,
    'Basic token',
    'Bearer',
    'Bearer   ',
    'Bearer one two',
    ['Bearer one', 'Bearer two'],
  ])('rejects malformed authorization value %#', (value) => {
    expect(() => parseBearerAuthorization(value)).toThrow('Authentication required');
  });

  it('accepts exactly one nonblank Bearer token', () => {
    expect(parseBearerAuthorization('Bearer eyJ.test.token')).toBe('eyJ.test.token');
  });
});
