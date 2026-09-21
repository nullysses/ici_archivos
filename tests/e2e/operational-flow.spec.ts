import { expect, test } from '@playwright/test';

test.use({ extraHTTPHeaders: { authorization: 'Bearer e2e-token' } });

test('completes the Oficialía to Gestor operational workflow', async ({ page }) => {
  await page.goto('/matters');
  await page.getByRole('button', { name: 'Registrar asunto' }).click();
  await page.getByLabel('Remitente').fill('Ciudadanía E2E');
  await page.getByRole('textbox', { name: 'Asunto' }).fill('Solicitud operativa E2E');
  await page.getByRole('textbox', { name: 'Descripción' }).fill('Descripción de prueba del flujo operativo');
  await page.locator('[role="combobox"]').nth(0).click();
  await page.getByRole('option', { name: /Unidad E2E/ }).click();
  await page.locator('[role="combobox"]').nth(1).click();
  await page.getByRole('option', { name: 'PUBLIC' }).click();
  await page.getByRole('button', { name: 'Registrar asunto' }).last().click();

  await expect(page.getByText(/OP-\d{4}-\d{6}/)).toBeVisible();
  const matterUrl = page.url();
  await page.getByRole('button', { name: 'Asignar unidad' }).click();
  await page.getByRole('button', { name: 'Iniciar trabajo' }).click();

  await page.goto('/expedientes');
  await page.getByRole('button', { name: 'Crear expediente' }).click();
  await page.locator('[role="combobox"]').last().click();
  await page.getByRole('option', { name: /Expediente E2E/ }).click();
  await page.getByLabel('Título').fill('Expediente operativo E2E');
  await page.getByRole('button', { name: 'Crear expediente' }).last().click();
  const expedienteLink = page.getByRole('link', { name: /EXP-\d{4}-\d{6}/ });
  await expect(expedienteLink).toBeVisible();
  const expedienteFolio = await expedienteLink.textContent();
  await expedienteLink.click();
  await expect(page.getByText(expedienteFolio ?? /EXP-/)).toBeVisible();

  await page.getByLabel('Título').fill('Oficio E2E');
  await page.getByLabel('Tipo de documento').fill('Oficio');
  await page.locator('[role="combobox"]').last().click();
  await page.getByRole('option', { name: 'PUBLIC' }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'oficio.txt', mimeType: 'text/plain', buffer: Buffer.from('Contenido documental E2E\n') });
  await page.getByRole('button', { name: 'Cargar documento' }).click();
  await expect(page.getByText(/Pendiente de análisis/)).toBeVisible();
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByText(/Limpio/)).toBeVisible();

  await page.goto(matterUrl);
  await page.reload();
  await page.locator('[role="combobox"]').last().click();
  await page.getByRole('option').first().click();
  await page.getByRole('button', { name: 'Vincular expediente' }).click();
  await page.getByLabel('Resultado de resolución').fill('Trabajo concluido en la operación E2E');
  await page.getByRole('button', { name: 'Resolver asunto' }).click();
  await page.getByLabel('Nota de cierre').fill('Cierre operativo E2E');
  await page.getByRole('button', { name: 'Cerrar asunto' }).click();
  await expect(page.getByText('Cerrado', { exact: true })).toBeVisible();

  await page.goto('/expedientes');
  await page.getByRole('link', { name: expedienteFolio ?? /EXP-/ }).click();
  await page.getByLabel('Nota de cierre').fill('Expediente cerrado tras validación E2E');
  await page.getByRole('button', { name: 'Cerrar expediente' }).click();
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Cerrado', { exact: true })).toBeVisible();
});
