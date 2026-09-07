import { describe, expect, it } from 'vitest';
import { readApiConfig } from './index.js';

describe('readApiConfig', () => {
  it('parses an explicit API port', () => {
    expect(readApiConfig({ API_PORT: '4100' }).port).toBe(4100);
  });

  it('rejects an invalid API port', () => {
    expect(() => readApiConfig({ API_PORT: '70000' })).toThrow('Invalid TCP port');
  });
});

