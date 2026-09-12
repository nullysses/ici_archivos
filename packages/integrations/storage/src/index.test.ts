import { describe, expect, it } from 'vitest';
import {
  assertAllowedDetectedMimeType,
  assertStoredObjectMatches,
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

function zipEntry(name: string, contents: string): Uint8Array {
  const filename = new TextEncoder().encode(name);
  const data = new TextEncoder().encode(contents);
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint32(18, data.byteLength, true);
  view.setUint32(22, data.byteLength, true);
  view.setUint16(26, filename.byteLength, true);
  const result = new Uint8Array(header.byteLength + filename.byteLength + data.byteLength);
  result.set(header);
  result.set(filename, header.byteLength);
  result.set(data, header.byteLength + filename.byteLength);
  return result;
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
    expect(await detector.detect(zipEntry('[Content_Types].xml', '<Types ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"></Types>')))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(await detector.detect(zipEntry('mimetype', 'application/vnd.oasis.opendocument.text')))
      .toBe('application/vnd.oasis.opendocument.text');
    expect(isAllowedDocumentMimeType('application/pdf')).toBe(true);
    expect(isAllowedDocumentMimeType('application/zip')).toBe(false);
    expect(() => assertAllowedDetectedMimeType('application/zip')).toThrow(UnsupportedDocumentMimeError);
  });

  it('does not accept a same-size CLEAN object without a matching checksum', () => {
    expect(() => assertStoredObjectMatches(
      { sizeBytes: 4n, sha256: 'aaaa' },
      { sizeBytes: 4n, sha256: 'bbbb' },
    )).toThrow(/checksum/i);
    expect(() => assertStoredObjectMatches(
      { sizeBytes: 4n, sha256: 'aaaa' },
      { sizeBytes: 4n },
    )).toThrow(/integrity/i);
    expect(() => assertStoredObjectMatches(
      { sizeBytes: 4n, sha256: 'AABB' },
      { sizeBytes: 4n, sha256: 'aabb' },
    )).not.toThrow();
  });

  it('keeps a declared MIME mismatch informational while server detection stays authoritative', () => {
    expect(isDeclaredMimeMismatch('application/pdf', 'application/pdf')).toBe(false);
    expect(isDeclaredMimeMismatch('image/png', 'application/pdf')).toBe(true);
    expect(() => assertAllowedDetectedMimeType('application/pdf')).not.toThrow();
  });
});
