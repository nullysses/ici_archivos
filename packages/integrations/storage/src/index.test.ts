import { describe, expect, it } from 'vitest';
import {
  assertAllowedDetectedMimeType,
  documentStorageKey,
  DocumentSizeLimitError,
  FileTypeDocumentMimeDetector,
  inspectDocumentStream,
  isDeclaredMimeMismatch,
  isAllowedDocumentMimeType,
  UnsupportedDocumentMimeError,
} from './index.js';

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  });
}

describe('document storage and intake primitives', () => {
  it('generates opaque, stable storage keys without filenames', () => {
    expect(documentStorageKey('institution-id', 'version-id')).toBe('v1/institution-id/version-id');
    expect(documentStorageKey('institution-id', 'version-id')).not.toContain('original.pdf');
    expect(() => documentStorageKey('', 'version-id')).toThrow();
  });

  it('hashes and counts a stream incrementally at the exact size limit', async () => {
    const result = await inspectDocumentStream(streamOf(new TextEncoder().encode('hello '), new TextEncoder().encode('world')), { maxBytes: 11n });
    expect(result.sizeBytes).toBe(11n);
    expect(result.sha256).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('rejects a stream as soon as it exceeds the configured limit', async () => {
    await expect(inspectDocumentStream(streamOf(new Uint8Array(10), new Uint8Array([1])), { maxBytes: 10n })).rejects.toBeInstanceOf(DocumentSizeLimitError);
  });

  it('identifies allowed signatures and rejects generic ZIP containers', async () => {
    const detector = new FileTypeDocumentMimeDetector();
    expect(await detector.detect(new TextEncoder().encode('%PDF-1.7\n'))).toBe('application/pdf');
    expect(await detector.detect(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip');
    expect(isAllowedDocumentMimeType('application/pdf')).toBe(true);
    expect(isAllowedDocumentMimeType('application/zip')).toBe(false);
    expect(() => assertAllowedDetectedMimeType('application/zip')).toThrow(UnsupportedDocumentMimeError);
  });

  it('keeps a declared MIME mismatch informational while server detection stays authoritative', () => {
    expect(isDeclaredMimeMismatch('application/pdf', 'application/pdf')).toBe(false);
    expect(isDeclaredMimeMismatch('image/png', 'application/pdf')).toBe(true);
    expect(() => assertAllowedDetectedMimeType('application/pdf')).not.toThrow();
  });
});
