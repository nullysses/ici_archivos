import { expect, test } from '@playwright/test';

test.use({ extraHTTPHeaders: { authorization: 'Bearer e2e-token' } });

test('prepara y aprueba una transferencia archivística sin falsear preservación', async ({ page }) => {
  await page.goto('/archive');
  await expect(page.getByRole('tab', { name: /Por preparar/ })).toBeVisible();
  await expect(page.getByText('EXP-2026-000001')).toBeVisible();
  await page.getByRole('button', { name: 'Preparar transferencia' }).click();
  await expect(page.getByRole('dialog')).toContainText('Se creará un borrador');
  await page.getByRole('button', { name: 'Confirmar' }).click();

  await expect(page).toHaveURL(/\/archive\/transfers\//);
  await expect(page.getByText('Borrador', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Manifest' })).toBeVisible();
  await expect(page.getByText('Fondo E2E > Sección E2E > Serie E2E')).toBeVisible();

  await page.getByRole('button', { name: 'Aprobar transferencia' }).click();
  await expect(page.getByRole('dialog')).toContainText('SHA-256 quedan congelados');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Aprobado', { exact: true })).toBeVisible();
  await expect(page.getByText('Manifest aprobado — inmutable')).toBeVisible();
  await expect(page.getByText('Transferencia Archivematica')).toBeVisible();
  await expect(page.getByText('Transferencia completada')).toHaveCount(0);
});

test('expone la frontera de intervención AtoM sin marcar la transferencia como completada', async ({ page }) => {
  await page.goto('/archive');
  await page.getByRole('tab', { name: 'Requieren atención' }).click();
  await expect(page.getByText('EXP-2026-000002')).toBeVisible();
  await page.getByRole('link', { name: 'Abrir transferencia' }).click();
  await expect(page.getByText('Intervención de preservación')).toBeVisible();
  await expect(page.getByText(/Requiere verificación humana/)).toBeVisible();
  await expect(page.getByText('DIP identificado', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reintentar preservación' })).toHaveCount(0);
  await expect(page.getByText('Transferencia completada')).toHaveCount(0);
});
