import { expect, test } from '@playwright/test';

test.use({ extraHTTPHeaders: { authorization: 'Bearer e2e-token' } });

test('administrador consulta institución y administra una unidad', async ({ page }) => {
  await page.goto('/admin/institution');
  await expect(page.getByRole('heading', { name: 'Institución' })).toBeVisible();
  await expect(page.getByLabel('Código institucional')).toHaveValue('E2E');

  await page.goto('/admin/units');
  await expect(page.getByRole('heading', { name: 'Unidades organizacionales' })).toBeVisible();
  await page.getByLabel('Código').first().fill('E2E-ADMIN');
  await page.getByLabel('Nombre').first().fill('Unidad administrativa E2E');
  await page.getByRole('button', { name: 'Crear unidad' }).click();
  await expect(page.getByText('Cambio guardado.')).toBeVisible();

  await page.goto('/admin/expediente-types');
  await expect(page.getByRole('heading', { name: 'Tipos de expediente' })).toBeVisible();
  await page.getByLabel('Código').fill('E2E-ADMIN-TYPE');
  await page.getByLabel('Nombre').fill('Tipo administrativo E2E');
  await page.getByRole('button', { name: 'Crear draft' }).click();
  await expect(page.getByText('Tipo administrativo E2E')).toBeVisible();
});
