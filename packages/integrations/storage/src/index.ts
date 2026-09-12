import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { fileTypeFromBuffer } from 'file-type';

export type DocumentStorageZone = 'QUARANTINE' | 'CLEAN';

export interface StoredObjectHead {
  readonly sizeBytes: bigint;
  /** Hex-encoded SHA-256 when the storage adapter can verify it. */
  readonly sha256?: string;
}

export interface DocumentStoragePort {
  put(input: { readonly zone: 'QUARANTINE'; readonly key: string; readonly body: ReadableStream<Uint8Array>; readonly sha256?: string }): Promise<void>;
  open(input: { readonly zone: DocumentStorageZone; readonly key: string }): Promise<ReadableStream<Uint8Array>>;
  head(input: { readonly zone: DocumentStorageZone; readonly key: string }): Promise<StoredObjectHead | undefined>;
  copy(input: { readonly from: DocumentStorageZone; readonly to: DocumentStorageZone; readonly key: string }): Promise<void>;
  remove(input: { readonly zone: DocumentStorageZone; readonly key: string }): Promise<void>;
}

export interface S3DocumentStorageOptions {
  readonly client: S3Client;
  readonly quarantineBucket: string;
  readonly cleanBucket: string;
}

function bucketFor(options: S3DocumentStorageOptions, zone: DocumentStorageZone): string {
  return zone === 'QUARANTINE' ? options.quarantineBucket : options.cleanBucket;
}

function isNotFound(error: unknown): boolean {
  return error instanceof NotFound || (error instanceof Error && ['NotFound', 'NoSuchKey', 'NotFoundError'].includes(error.name));
}

/** S3-compatible storage adapter. It never writes directly to the CLEAN zone. */
export class S3DocumentStorage implements DocumentStoragePort {
  public constructor(private readonly options: S3DocumentStorageOptions) {}

  public async put(input: { readonly zone: 'QUARANTINE'; readonly key: string; readonly body: ReadableStream<Uint8Array>; readonly sha256?: string }): Promise<void> {
    await new Upload({
      client: this.options.client,
      params: {
        Bucket: bucketFor(this.options, input.zone),
        Key: input.key,
        Body: Readable.fromWeb(input.body),
        ...(input.sha256 === undefined ? {} : { Metadata: { sha256: input.sha256 } }),
      },
    }).done();
  }

  public async open(input: { readonly zone: DocumentStorageZone; readonly key: string }): Promise<ReadableStream<Uint8Array>> {
    const result = await this.options.client.send(new GetObjectCommand({ Bucket: bucketFor(this.options, input.zone), Key: input.key }));
    if (result.Body === undefined) throw new Error('Stored object has no body');
    return result.Body.transformToWebStream();
  }

  public async head(input: { readonly zone: DocumentStorageZone; readonly key: string }): Promise<StoredObjectHead | undefined> {
    try {
      const result = await this.options.client.send(new HeadObjectCommand({ Bucket: bucketFor(this.options, input.zone), Key: input.key }));
      if (result.ContentLength === undefined) return undefined;
      const metadataSha256 = result.Metadata?.sha256 ?? result.Metadata?.['x-amz-meta-sha256'];
      const checksumSha256 = result.ChecksumSHA256 === undefined
        ? undefined
        : Buffer.from(result.ChecksumSHA256, 'base64').toString('hex');
      const sha256 = metadataSha256 ?? checksumSha256;
      return sha256 === undefined
        ? { sizeBytes: BigInt(result.ContentLength) }
        : { sizeBytes: BigInt(result.ContentLength), sha256 };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  public async copy(input: { readonly from: DocumentStorageZone; readonly to: DocumentStorageZone; readonly key: string }): Promise<void> {
    if (input.from === input.to) throw new Error('Storage copy requires distinct zones');
    const sourceBucket = bucketFor(this.options, input.from);
    const targetBucket = bucketFor(this.options, input.to);
    const source = await this.head({ zone: input.from, key: input.key });
    if (source === undefined) throw new Error('Source object was not found');
    const existing = await this.head({ zone: input.to, key: input.key });
    if (existing !== undefined) {
      assertStoredObjectMatches(source, existing);
      return;
    }
    await this.options.client.send(new CopyObjectCommand({ Bucket: targetBucket, Key: input.key, CopySource: encodeURIComponent(`${sourceBucket}/${input.key}`) }));
  }

  public async remove(input: { readonly zone: DocumentStorageZone; readonly key: string }): Promise<void> {
    await this.options.client.send(new DeleteObjectCommand({ Bucket: bucketFor(this.options, input.zone), Key: input.key }));
  }
}

/**
 * Existing promotion targets are accepted only when their strong identity is
 * verifiably the same as the quarantine source. Size alone is not sufficient:
 * distinct evidence can have identical lengths.
 */
export function assertStoredObjectMatches(source: StoredObjectHead, existing: StoredObjectHead): void {
  if (existing.sizeBytes !== source.sizeBytes) throw new Error('Existing destination object has an unexpected size');
  if (source.sha256 === undefined || existing.sha256 === undefined) {
    throw new Error('Existing destination object cannot be integrity-verified');
  }
  if (existing.sha256.toLowerCase() !== source.sha256.toLowerCase()) {
    throw new Error('Existing destination object has an unexpected checksum');
  }
}

export function documentStorageKey(institutionId: string, documentVersionId: string): string {
  if (institutionId.trim() === '' || documentVersionId.trim() === '') throw new Error('Storage key components are required');
  return `v1/${institutionId}/${documentVersionId}`;
}

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'text/plain', 'text/csv', 'text/xml', 'application/xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation',
  'message/rfc822',
] as const;

export type AllowedDocumentMimeType = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

export function isAllowedDocumentMimeType(mimeType: string): mimeType is AllowedDocumentMimeType {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

export class UnsupportedDocumentMimeError extends Error {
  public constructor(readonly detectedMimeType?: string) { super('Document MIME type is not allowed'); this.name = 'UnsupportedDocumentMimeError'; }
}

export class DocumentSizeLimitError extends Error {
  public constructor(readonly limitBytes: bigint) { super('Document exceeds the configured size limit'); this.name = 'DocumentSizeLimitError'; }
}

export interface DocumentMimeDetector { detect(bytes: Uint8Array): Promise<string | undefined>; }

function isReasonableUtf8(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      if (code !== 9 && code !== 10 && code !== 13 && (code < 0x20 || code === 0x7f)) return false;
    }
    return true;
  } catch { return false; }
}

/** Magic-byte detection with bounded text fallback; it never trusts filenames. */
export class FileTypeDocumentMimeDetector implements DocumentMimeDetector {
  public async detect(bytes: Uint8Array): Promise<string | undefined> {
    if (bytes.length === 0) return undefined;
    let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
    try { detected = await fileTypeFromBuffer(bytes); } catch { detected = undefined; }
    if (detected?.mime !== undefined) return detected.mime;
    if (isZipSignature(bytes)) return 'application/zip';
    if (!isReasonableUtf8(bytes)) return undefined;
    const text = new TextDecoder().decode(bytes).trimStart();
    if (text.startsWith('<?xml') || text.startsWith('<')) return 'application/xml';
    if (/^(from|date|subject|to):\s+/im.test(text)) return 'message/rfc822';
    if (text.includes(',') && text.includes('\n')) return 'text/csv';
    return 'text/plain';
  }
}

function isZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export interface InspectedDocument { readonly sizeBytes: bigint; readonly sha256: string; readonly detectedMimeType: string | undefined; }

export async function inspectDocumentStream(
  body: ReadableStream<Uint8Array>,
  options: { readonly maxBytes: bigint; readonly detector?: DocumentMimeDetector; readonly sniffBytes?: number } = { maxBytes: 2_147_483_648n },
): Promise<InspectedDocument> {
  const reader = body.getReader();
  const hash = createHash('sha256');
  const sniffLimit = options.sniffBytes ?? 4100;
  const sniffParts: Uint8Array[] = [];
  let sniffed = 0;
  let sizeBytes = 0n;
  if (options.maxBytes < 0n) throw new Error('Document size limit must not be negative');
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sizeBytes += BigInt(chunk.value.byteLength);
      if (sizeBytes > options.maxBytes) throw new DocumentSizeLimitError(options.maxBytes);
      hash.update(chunk.value);
      if (sniffed < sniffLimit) {
        const part = chunk.value.slice(0, Math.min(chunk.value.byteLength, sniffLimit - sniffed));
        sniffParts.push(part);
        sniffed += part.byteLength;
      }
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally { reader.releaseLock(); }
  const sniff = new Uint8Array(sniffed);
  let offset = 0;
  for (const part of sniffParts) { sniff.set(part, offset); offset += part.byteLength; }
  const detectedMimeType = options.detector === undefined ? undefined : await options.detector.detect(sniff);
  return { sizeBytes, sha256: hash.digest('hex'), detectedMimeType };
}

export function assertAllowedDetectedMimeType(mimeType: string | undefined): asserts mimeType is AllowedDocumentMimeType {
  if (mimeType === undefined || !isAllowedDocumentMimeType(mimeType)) throw new UnsupportedDocumentMimeError(mimeType);
}

/** The declaration is retained as metadata; server detection remains authoritative. */
export function isDeclaredMimeMismatch(declaredMimeType: string | undefined, detectedMimeType: string): boolean {
  return declaredMimeType !== undefined && declaredMimeType !== '' && declaredMimeType !== detectedMimeType;
}
