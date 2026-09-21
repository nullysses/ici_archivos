import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ConfirmAction, EmptyState, ErrorState, ForbiddenState, Folio, LifecycleBadge, LoadingState, NotFoundState } from './ux.js';

describe('shared UX presentation primitives', () => {
  it('presents operational folios and lifecycle labels', () => {
    const html = renderToStaticMarkup(<><Folio value="EXP-2026-000045" /><LifecycleBadge status="TRANSFER_PENDING" /></>);
    expect(html).toContain('EXP-2026-000045');
    expect(html).toContain('Transferencia pendiente');
  });

  it('presents loading, empty, error, forbidden and not-found states', () => {
    expect(renderToStaticMarkup(<LoadingState />)).toContain('role="status"');
    expect(renderToStaticMarkup(<EmptyState title="Sin expedientes" />)).toContain('Sin expedientes');
    expect(renderToStaticMarkup(<ErrorState message="Servicio no disponible" />)).toContain('Servicio no disponible');
    expect(renderToStaticMarkup(<ForbiddenState />)).toContain('No tienes permisos');
    expect(renderToStaticMarkup(<NotFoundState />)).toContain('Página no encontrada');
  });

  it('explains the consequence of a destructive confirmation', () => {
    const dialog = ConfirmAction({ consequence: 'El expediente quedará congelado.', onCancel: () => undefined, onConfirm: () => undefined, open: true, title: 'Cerrar expediente' }) as ReactElement<{ readonly children: ReactNode; readonly open: boolean }>;
    const html = renderToStaticMarkup(<>{dialog.props.children}</>);
    expect(dialog.props.open).toBe(true);
    expect(html).toContain('El expediente quedará congelado.');
    expect(html).toContain('Cerrar expediente');
  });
});
