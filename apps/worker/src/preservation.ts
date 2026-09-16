import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { dirname, join, resolve, sep } from 'node:path';
import {
  createApprovedExpedienteAtomSyncContextLoader,
  createArchivalClassificationPathLoader,
  createAtomMappingStore,
  createPreservationStagingStore,
  loadApprovedPreservationPackageContext,
  type Database,
  type PreservationPackageVersionRecord,
} from '@ici/database';
import { ensureApprovedExpedienteFileDescription, ensureAtomClassificationHierarchy } from '@ici/integration-atom';
import type { AtomClient } from '@ici/integration-atom';
import type { ArchivematicaPreservationService, PreservationObservation } from '@ici/integration-archivematica';
import type { DocumentStoragePort } from '@ici/integration-storage';
import type { PreservationExecutionInput, PreservationExecutionPort, PreservationExecutionResult } from './jobs.js';

export class PreservationInterventionRequired extends Error {
  public readonly code = 'PRESERVATION_INTERVENTION_REQUIRED' as const;
  public constructor(message: string) { super(message); this.name = 'PreservationInterventionRequired'; }
}

/** The remote workflow is still progressing. Keep the fenced durable intent
 * recoverable instead of converting an ordinary poll into FAILED. */
export class PreservationExecutionDeferred extends Error {
  public readonly code = 'PRESERVATION_EXECUTION_DEFERRED' as const;
  public constructor(message: string) { super(message); this.name = 'PreservationExecutionDeferred'; }
}

export interface PreservationTransferPackageStager {
  stage(input: { readonly institutionId: string; readonly transferId: string; readonly manifestSha256: string; readonly canonicalManifestJson: string; readonly versions: readonly PreservationPackageVersionRecord[] }): Promise<{ readonly locationUuid: string; readonly relativePath: string }>;
}

function safeFilename(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return normalized.length === 0 ? 'object.bin' : normalized.slice(0, 180);
}

async function consumeToFile(body: ReadableStream<Uint8Array>, target: string, expectedSize: string, expectedSha256: string): Promise<void> {
  const reader = body.getReader();
  const hash = createHash('sha256');
  let size = 0n;
  const output = createWriteStream(target, { flags: 'wx' });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += BigInt(next.value.byteLength);
      hash.update(next.value);
      if (!output.write(next.value)) await once(output, 'drain');
    }
    await new Promise<void>((resolveOutput, rejectOutput) => { output.end(() => resolveOutput()); output.once('error', rejectOutput); });
  } catch (error) {
    output.destroy();
    throw error;
  } finally { reader.releaseLock(); }
  const digest = hash.digest('hex');
  if (size !== BigInt(expectedSize) || digest.toLowerCase() !== expectedSha256.toLowerCase()) { await rm(target, { force: true }); throw new Error('Clean object failed authoritative size or SHA-256 verification'); }
}

/** Filesystem boundary for a configured Archivematica Transfer Source. The
 * source root is deployment configuration, never user input. */
export class FilesystemPreservationTransferStager implements PreservationTransferPackageStager {
  public constructor(private readonly root: string, private readonly locationUuid: string, private readonly storage: DocumentStoragePort) {}

  public async stage(input: { readonly institutionId: string; readonly transferId: string; readonly manifestSha256: string; readonly canonicalManifestJson: string; readonly versions: readonly PreservationPackageVersionRecord[] }): Promise<{ readonly locationUuid: string; readonly relativePath: string }> {
    const relativePath = `ici/${input.transferId}/${input.manifestSha256}`;
    const packageRoot = resolve(this.root, relativePath);
    const rootPrefix = `${resolve(this.root)}${sep}`;
    if (!packageRoot.startsWith(rootPrefix)) throw new Error('Preservation staging path escaped the configured Transfer Source root');
    const metadataPath = join(packageRoot, 'metadata', 'manifest.json');
    try {
      const existing = await readFile(metadataPath, 'utf8');
      if (existing !== input.canonicalManifestJson) throw new Error('Existing staged package has a different approved manifest');
      return { locationUuid: this.locationUuid, relativePath };
    } catch (error) {
      if (error instanceof Error && error.message !== 'ENOENT' && !('code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
    }
    const temporary = `${packageRoot}.tmp-${randomUUID()}`;
    await mkdir(join(temporary, 'metadata'), { recursive: true });
    await mkdir(join(temporary, 'objects'), { recursive: true });
    try {
      await writeFile(join(temporary, 'metadata', 'manifest.json'), input.canonicalManifestJson, 'utf8');
      for (const version of input.versions) {
        const target = join(temporary, 'objects', version.versionId, safeFilename(version.filename));
        await mkdir(dirname(target), { recursive: true });
        await consumeToFile(await this.storage.open({ zone: 'CLEAN', key: version.storageKey }), target, version.sizeBytes, version.sha256);
      }
      await mkdir(dirname(packageRoot), { recursive: true });
      try { await rename(temporary, packageRoot); }
      catch (error) {
        const metadata = await readFile(metadataPath, 'utf8').catch(() => undefined);
        if (metadata !== input.canonicalManifestJson) throw error;
        await rm(temporary, { recursive: true, force: true });
      }
      return { locationUuid: this.locationUuid, relativePath };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}

export interface ProductionPreservationDependencies {
  readonly database: Database;
  readonly cleanStorage: DocumentStoragePort;
  readonly atom: AtomClient;
  readonly archivematica: ArchivematicaPreservationService;
  readonly transferSourceLocationUuid: string;
  readonly stager: PreservationTransferPackageStager;
  readonly verifyArchivalIntegration: (input: { readonly institutionId: string; readonly transferId: string; readonly expedienteId: string; readonly fileSlug: string; readonly dipUuid: string }) => Promise<boolean>;
}

function interventionFromObservation(observation: PreservationObservation): void {
  if (observation.state === 'awaiting_intervention') throw new PreservationInterventionRequired(observation.diagnostic ?? 'Archivematica requires human intervention');
  if (observation.state === 'failed') throw new Error(observation.diagnostic ?? 'Archivematica preservation failed');
}

/** Production composition boundary. It deliberately returns success only
 * after package/AIP evidence and an explicit archival integration evidence
 * port agree. */
export class ProductionPreservationExecution implements PreservationExecutionPort {
  public constructor(private readonly dependencies: ProductionPreservationDependencies) {}

  public async execute(input: PreservationExecutionInput): Promise<PreservationExecutionResult> {
    const context = await loadApprovedPreservationPackageContext(this.dependencies.database, { institutionId: input.institutionId, transferId: input.transferId });
    const mappingStore = createAtomMappingStore(this.dependencies.database);
    const pathLoader = createArchivalClassificationPathLoader(this.dependencies.database);
    const atomContextLoader = createApprovedExpedienteAtomSyncContextLoader(this.dependencies.database);
    const atomContext = await atomContextLoader.load({ institutionId: input.institutionId, transferId: input.transferId });
    await ensureAtomClassificationHierarchy(this.dependencies.atom, mappingStore, pathLoader, { institutionId: input.institutionId, targetNodeId: atomContext.archivalParentNodeId });
    const file = await ensureApprovedExpedienteFileDescription(this.dependencies.atom, mappingStore, atomContextLoader, { institutionId: input.institutionId, transferId: input.transferId });
    const fileSlug = file.mapping.atomSlug;
    if (fileSlug === null) throw new Error('AtoM expediente mapping has no slug');
    const stagingStore = createPreservationStagingStore(this.dependencies.database);
    const existingStaging = await stagingStore.find({ institutionId: input.institutionId, archiveTransferId: input.transferId });
    let source: { readonly locationUuid: string; readonly relativePath: string };
    if (existingStaging?.status === 'STAGED') {
      const expectedPath = `ici/${input.transferId}/${context.manifestSha256}`;
      if (existingStaging.manifestSha256 !== context.manifestSha256 || existingStaging.locationUuid !== this.dependencies.transferSourceLocationUuid || existingStaging.relativePath !== expectedPath) throw new PreservationInterventionRequired('Persisted preservation staging evidence conflicts with the approved package');
      source = { locationUuid: existingStaging.locationUuid, relativePath: existingStaging.relativePath };
    }
    else if (existingStaging !== undefined) throw new PreservationInterventionRequired('Preservation package staging requires reconciliation before retry');
    else {
      const plannedPath = `ici/${input.transferId}/${context.manifestSha256}`;
      const reservation = await stagingStore.reserve({ institutionId: input.institutionId, archiveTransferId: input.transferId, locationUuid: this.dependencies.transferSourceLocationUuid, relativePath: plannedPath, manifestSha256: context.manifestSha256 });
      if (!reservation.reserved) throw new PreservationInterventionRequired('A concurrent preservation staging attempt requires reconciliation');
      try {
        source = await this.dependencies.stager.stage({ institutionId: input.institutionId, transferId: input.transferId, manifestSha256: context.manifestSha256, canonicalManifestJson: context.canonicalManifestJson, versions: context.versions });
        if (source.locationUuid !== this.dependencies.transferSourceLocationUuid || source.relativePath !== plannedPath || source.relativePath.startsWith('/') || source.relativePath.includes('..') || source.relativePath.includes('\\')) throw new PreservationInterventionRequired('Preservation stager returned an unsafe or unexpected Transfer Source reference');
        await stagingStore.markStaged({ institutionId: input.institutionId, archiveTransferId: input.transferId, manifestSha256: context.manifestSha256 });
      } catch (error) {
        await stagingStore.markReconciliationRequired({ institutionId: input.institutionId, archiveTransferId: input.transferId }).catch(() => undefined);
        throw error;
      }
    }
    const record = await this.dependencies.archivematica.submit({ institutionId: input.institutionId, archiveTransferId: input.transferId, source });
    if (record.archivematicaTransferUuid === null) throw new Error('Archivematica transfer identity is unavailable');
    const transferObservation = await this.dependencies.archivematica.observeTransfer({ institutionId: input.institutionId, archiveTransferId: input.transferId, transferUuid: record.archivematicaTransferUuid });
    interventionFromObservation(transferObservation);
    if (transferObservation.sipUuid === undefined) throw new PreservationExecutionDeferred('Archivematica transfer is complete or progressing but has not produced an authoritative SIP UUID');
    const ingestObservation = await this.dependencies.archivematica.observeIngest({ institutionId: input.institutionId, archiveTransferId: input.transferId, transferUuid: record.archivematicaTransferUuid, sipUuid: transferObservation.sipUuid });
    interventionFromObservation(ingestObservation);
    if (ingestObservation.ingestComplete !== true) throw new PreservationExecutionDeferred('Archivematica ingest is not complete');
    const aip = await this.dependencies.archivematica.verifyAip({ institutionId: input.institutionId, archiveTransferId: input.transferId, transferUuid: record.archivematicaTransferUuid, sipUuid: transferObservation.sipUuid, aipUuid: transferObservation.sipUuid });
    let dip: PreservationObservation;
    try { dip = await this.dependencies.archivematica.discoverDip({ institutionId: input.institutionId, archiveTransferId: input.transferId, transferUuid: record.archivematicaTransferUuid, sipUuid: transferObservation.sipUuid, aipUuid: aip.aipUuid! }); }
    catch (error) { if (error instanceof Error && 'code' in error && (error as { readonly code?: unknown }).code === 'DIP_NOT_PROVABLE') throw new PreservationInterventionRequired(error.message); throw error; }
    if (dip.dipUuid === undefined || !(await this.dependencies.verifyArchivalIntegration({ institutionId: input.institutionId, transferId: input.transferId, expedienteId: input.expedienteId, fileSlug, dipUuid: dip.dipUuid }))) throw new PreservationInterventionRequired('Archivematica DIP delivery to AtoM is not independently provable');
    return { approvedManifestPreserved: true, aipStored: true, archivalIntegrationCompleted: true };
  }
}
