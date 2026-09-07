import { expect, test } from '@playwright/test';

test('renders the operational shell and API status', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'ICI Archivos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Base operativa lista' })).toBeVisible();
  await expect(page.getByText(/Disponible|Requiere atención/)).toBeVisible();
});

