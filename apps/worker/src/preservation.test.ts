import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesystemPreservationTransferStager } from './preservation.js';
import type { DocumentStoragePort } from '@ici/integration-storage';

function storageFor(value: Uint8Array): DocumentStoragePort {
  return {
    put: () => Promise.resolve(undefined),
    open: () => Promise.resolve(new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } })),
    head: () => Promise.resolve({ sizeBytes: BigInt(value.byteLength) }),
    copy: () => Promise.resolve(undefined),
    remove: () => Promise.resolve(undefined),
  };
}

describe('preservation transfer staging', () => {
  it('writes the exact manifest and deterministic object layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ici-preservation-'));
    try {
      const bytes = new TextEncoder().encode('clean bytes');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const stager = new FilesystemPreservationTransferStager(root, '55555555-5555-4555-8555-555555555555', storageFor(bytes));
      const result = await stager.stage({ institutionId: 'institution-a', transferId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64), canonicalManifestJson: '{"approved":true}', versions: [{ versionId: '22222222-2222-4222-8222-222222222222', versionNumber: 1, storageKey: 'v1/object', filename: 'source.pdf', sha256, sizeBytes: String(bytes.byteLength), mimeType: 'application/pdf' }] });
      expect(result.relativePath).toBe(`ici/11111111-1111-4111-8111-111111111111/${'a'.repeat(64)}`);
      expect(await readFile(join(root, result.relativePath, 'metadata', 'manifest.json'), 'utf8')).toBe('{"approved":true}');
      expect(await readFile(join(root, result.relativePath, 'objects/22222222-2222-4222-8222-222222222222/source.pdf'), 'utf8')).toBe('clean bytes');
      await expect(stager.stage({ institutionId: 'institution-a', transferId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64), canonicalManifestJson: '{"approved":false}', versions: [] })).rejects.toThrow('different approved manifest');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects clean objects whose bytes diverge from the approved manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ici-preservation-'));
    try {
      const expected = new TextEncoder().encode('expected');
      const actual = new TextEncoder().encode('different');
      const stager = new FilesystemPreservationTransferStager(root, '55555555-5555-4555-8555-555555555555', storageFor(actual));
      await expect(stager.stage({ institutionId: 'institution-a', transferId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64), canonicalManifestJson: '{}', versions: [{ versionId: '22222222-2222-4222-8222-222222222222', versionNumber: 1, storageKey: 'v1/object', filename: 'source.pdf', sha256: createHash('sha256').update(expected).digest('hex'), sizeBytes: String(expected.byteLength), mimeType: 'application/pdf' }] })).rejects.toThrow('authoritative size or SHA-256');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
