import { expect, test } from '@playwright/test';

test.use({ extraHTTPHeaders: { authorization: 'Bearer e2e-oficialia-token' } });

test('completes the Oficialía to Gestor operational workflow with role boundaries', async ({ page, browser }) => {
  const gestorContext = await browser.newContext({
    baseURL: 'http://127.0.0.1:5174',
    extraHTTPHeaders: { authorization: 'Bearer e2e-gestor-token' },
  });
  const gestorPage = await gestorContext.newPage();

  try {
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
  const matterId = new URL(matterUrl).pathname.split('/').pop();
  if (matterId === undefined || matterId === '') throw new Error('Matter URL did not contain an id');
  const usersLookup = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().includes('/api/lookups/organizational-units/') && response.url().endsWith('/users') && response.status() === 200);
  await page.reload();
  await usersLookup;
  const assignmentResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/matters/${matterId}/assign`) && response.status() === 200);
  await page.getByRole('combobox').nth(1).click();
  await page.getByText('Gestor E2E', { exact: true }).click();
  await assignmentResponse;
  const assignedMatter = ((await (await page.request.get('/api/matters/inbox')).json()) as { items: readonly { id: string; assignmentUserId?: string | null }[] }).items.find((item) => item.id === matterId);
  expect(assignedMatter?.assignmentUserId).toBe('22000000-0000-4000-8000-000000000014');

  const unauthorizedStart = await page.request.post(`/api/matters/${matterId}/start`, { data: {} });
  expect(unauthorizedStart.status()).toBe(403);

  await gestorPage.goto('/matters');
  await expect(gestorPage.getByText('Solicitud operativa E2E')).toBeVisible();
  await gestorPage.goto(matterUrl);
  await gestorPage.getByRole('button', { name: 'Iniciar trabajo' }).click();

  await gestorPage.goto('/expedientes');
  await gestorPage.getByRole('button', { name: 'Crear expediente' }).click();
  await gestorPage.locator('[role="combobox"]').last().click();
  await gestorPage.getByRole('option', { name: /Expediente E2E/ }).click();
  await gestorPage.getByLabel('Título').fill('Expediente operativo E2E');
  await gestorPage.getByRole('button', { name: 'Crear expediente' }).last().click();
  const expedienteLink = gestorPage.getByRole('link', { name: /EXP-\d{4}-\d{6}/ }).first();
  await expect(expedienteLink).toBeVisible();
  const expedienteFolio = await expedienteLink.textContent();
  await expedienteLink.click();
  await expect(gestorPage.getByText(expedienteFolio ?? /EXP-/)).toBeVisible();
  const expedienteId = new URL(gestorPage.url()).pathname.split('/').pop();
  if (expedienteId === undefined || expedienteId === '') throw new Error('Expediente URL did not contain an id');

  await gestorPage.getByLabel('Título').fill('Oficio E2E');
  await gestorPage.getByLabel('Tipo de documento').fill('Oficio');
  await gestorPage.locator('[role="combobox"]').last().click();
  await gestorPage.getByRole('option', { name: 'PUBLIC' }).click();
  await gestorPage.locator('input[type="file"]').first().setInputFiles({ name: 'oficio.txt', mimeType: 'text/plain', buffer: Buffer.from('Contenido documental E2E\n') });
  await gestorPage.getByRole('button', { name: 'Cargar documento' }).click();
  await expect(gestorPage.getByText(/Pendiente de análisis/)).toBeVisible();
  await expect.poll(async () => {
    const response = await gestorPage.request.get(`/api/expedientes/${expedienteId}/documents`);
    if (!response.ok()) return false;
    const body = (await response.json()) as { readonly items?: readonly { readonly versions?: readonly { readonly malwareScanStatus?: string }[] }[] };
    return body.items?.some((document) => document.versions?.some((version) => version.malwareScanStatus === 'CLEAN')) === true;
  }, { intervals: [250, 500, 1000], timeout: 15_000 }).toBe(true);
  await gestorPage.reload();
  await expect(gestorPage.getByText(/Limpio/)).toBeVisible();

  await gestorPage.goto(matterUrl);
  await gestorPage.reload();
  await gestorPage.locator('[role="combobox"]').last().click();
  await gestorPage.getByRole('option').first().click();
  await gestorPage.getByRole('button', { name: 'Vincular expediente' }).click();
  await gestorPage.getByLabel('Resultado de resolución').fill('Trabajo concluido en la operación E2E');
  await gestorPage.getByRole('button', { name: 'Resolver asunto' }).click();
  await gestorPage.getByLabel('Nota de cierre').fill('Cierre operativo E2E');
  await gestorPage.getByRole('button', { name: 'Cerrar asunto' }).click();
  await expect(gestorPage.getByText('Cerrado', { exact: true })).toBeVisible();
  await gestorPage.reload();
  await expect(gestorPage.getByText('Cerrado', { exact: true })).toBeVisible();

  await gestorPage.goto('/expedientes');
  await gestorPage.getByRole('link', { name: expedienteFolio ?? /EXP-/ }).click();
  await gestorPage.getByLabel('Nota de cierre').fill('Expediente cerrado tras validación E2E');
  await gestorPage.getByRole('button', { name: 'Cerrar expediente' }).click();
  await gestorPage.getByRole('button', { name: 'Confirmar' }).click();
  await expect(gestorPage.getByText('Cerrado', { exact: true })).toBeVisible();
  await gestorPage.reload();
  await expect(gestorPage.getByText('Cerrado', { exact: true })).toBeVisible();
  await expect(gestorPage.getByRole('button', { name: 'Nueva versión' })).toHaveCount(0);
  await expect(gestorPage.getByRole('button', { name: 'Cargar documento' })).toHaveCount(0);
  } finally {
    await gestorContext.close();
  }
});
