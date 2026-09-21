import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProgressPanel } from './archive.js';
import type { ArchiveTransferWorkspace } from './api.js';

describe('Archivista preservation presentation', () => {
  it('keeps the AtoM evidence boundary visible instead of showing completion', () => {
    const workspace = {
      transfer: { id: '11111111-1111-4111-8111-111111111111', expedienteId: '22222222-2222-4222-8222-222222222222', status: 'PRESERVING', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', manifest: { id: '33333333-3333-4333-8333-333333333333', transferId: '11111111-1111-4111-8111-111111111111', status: 'APPROVED', canonicalJson: '{}', sha256: 'a'.repeat(64), approvedBy: null, approvedAt: null, documents: [] } },
      expediente: { id: '22222222-2222-4222-8222-222222222222', folio: 'EXP-2026-000001', status: 'TRANSFER_PENDING' },
      archivalPath: [],
      atom: { parent: null, file: null },
      evidence: { submissionStatus: 'SUBMITTED', archivematicaTransferUuid: null, sipUuid: '44444444-4444-4444-8444-444444444444', aipUuid: '44444444-4444-4444-8444-444444444444', dipUuid: '55555555-5555-4555-8555-555555555555', lastRemoteStatus: 'COMPLETE', lastIngestStatus: 'COMPLETE', lastCheckedAt: null },
      staging: null,
      intervention: { kind: 'PRESERVATION_INTERVENTION', message: 'Requires human verification' },
      job: { status: 'RUNNING', attemptCount: 1, lastError: 'PRESERVATION_INTERVENTION_REQUIRED' },
      activity: [],
    } as ArchiveTransferWorkspace;
    const html = renderToStaticMarkup(<ProgressPanel item={workspace} />);
    expect(html).toContain('Requiere verificación humana');
    expect(html).not.toContain('Transferencia completada');
  });
});
