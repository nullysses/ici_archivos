import { expect, test } from '@playwright/test';

test('renders the operational shell and API status', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'ICI Archivos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Base operativa lista' })).toBeVisible();
  await expect(page.getByText(/Disponible|Requiere atención/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Inicio' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Administración' })).toHaveCount(0);
  const inicio = page.getByRole('link', { name: 'Inicio' });
  await inicio.focus();
  await expect(inicio).toBeFocused();
  await page.goto('/matters');
  await expect(page.getByRole('heading', { name: 'No tienes permisos para ver esta sección' })).toBeVisible();
  await page.goto('/ruta-inexistente');
  await expect(page.getByRole('heading', { name: 'Página no encontrada' })).toBeVisible();
});
