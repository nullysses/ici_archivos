import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalManifestJson, isValidArchivalMapping } from './services.js';

describe('manifest canonicalization and archival mapping contract', () => {
  it('produces the same bytes and SHA-256 regardless of object insertion order', () => {
    const first = { documents: [{ zeta: 2, alpha: 1 }], expedienteId: 'exp-1', transferId: 'transfer-1' };
    const second = { transferId: 'transfer-1', expedienteId: 'exp-1', documents: [{ alpha: 1, zeta: 2 }] };
    const firstCanonical = canonicalManifestJson(first);
    const secondCanonical = canonicalManifestJson(second);
    expect(firstCanonical).toBe(secondCanonical);
    expect(createHash('sha256').update(firstCanonical, 'utf8').digest('hex')).toBe(createHash('sha256').update(secondCanonical, 'utf8').digest('hex'));
  });

  it('uses locale-independent ordering for nested and numeric-looking keys', () => {
    expect(canonicalManifestJson({ '10': 'ten', '2': 'two', Z: true, a: false, 'ä': null })).toBe('{"10":"ten","2":"two","Z":true,"a":false,"ä":null}');
  });

  it('accepts only the currently supported ICI-to-AtoM File mapping shape', () => {
    expect(isValidArchivalMapping({ levelOfDescription: 'File' })).toBe(true);
  });

  it.each([
    {},
    { levelOfDescription: 'Series' },
    { levelOfDescription: 'File', extra: 'ignored is not allowed' },
    { levelOfDescription: 7 },
  ])('rejects an invalid archival mapping: %j', (mapping) => {
    expect(isValidArchivalMapping(mapping)).toBe(false);
  });
});
