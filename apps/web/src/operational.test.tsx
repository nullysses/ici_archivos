import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ExpedienteTable, MatterTable } from './operational.js';

describe('operational workflow presentation', () => {
  it('renders matter folios and status without exposing UUIDs as the primary reference', () => {
    const html = renderToStaticMarkup(<MemoryRouter><MatterTable filtered={false} items={[{ id: '11111111-1111-4111-8111-111111111111', folio: 'OP-2026-000123', status: 'IN_PROGRESS', receivedAt: '2026-01-01T00:00:00.000Z', sender: 'Ciudadanía', subject: 'Solicitud', description: 'Descripción', priority: 'Normal', channel: 'Ventanilla', destinationUnitId: null, accessClassificationId: null, operationalVisibility: 'INSTITUTION', resolutionMetadata: null, closureMetadata: null, linkedExpedienteId: null, createdBy: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]} /></MemoryRouter>);
    expect(html).toContain('OP-2026-000123');
    expect(html).toContain('En proceso');
    // The technical id may appear in the internal detail-link href, but it
    // must not be rendered as the operator-facing table value.
    expect(html.replace(/href="[^"]+"/g, '')).not.toContain('11111111-1111-4111-8111-111111111111');
  });

  it('distinguishes an empty expediente list', () => {
    expect(renderToStaticMarkup(<ExpedienteTable items={[]} />)).toContain('No hay expedientes');
  });
});
