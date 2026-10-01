# M16 — matriz de aceptación end-to-end

Baseline: `d1be47c58e3842f1186794f9bdab8906d6508c73`.

Esta matriz separa evidencia automatizada determinista, ejecución local y
aceptación contra proveedores externos. No se marca una integración real como
`PASS` a partir de mocks.

## Nivel A — aceptación automatizada determinista

| Área | Resultado | Evidencia |
| --- | --- | --- |
| Aplicación, contratos y autorización | PASS | `pnpm test` y `pnpm typecheck` |
| Persistencia PostgreSQL, RLS y auditoría | PASS | `pnpm test:integration` (12 archivos, 94 tests) |
| Oficialía → Gestor | PASS | `tests/e2e/operational-flow.spec.ts` |
| Documentos, malware y versiones | PASS | `packages/database/src/document-intake.integration.test.ts`, `apps/worker/src/jobs.integration.test.ts`, flujo Playwright operativo |
| Transferencia, manifest inmutable e intervención | PASS | `tests/e2e/archive-flow.spec.ts`, pruebas de transfer/worker |
| Administración, scopes y publicación de tipos | PASS | `tests/e2e/admin-flow.spec.ts`, `packages/database/src/admin.integration.test.ts` |
| Salud, 401, 403, 404 y foco de navegación | PASS | `tests/e2e/health.spec.ts`, `apps/api/src/app.test.ts` |
| Staging determinista y divergencia de bytes | PASS | `apps/worker/src/preservation.test.ts` |
| Jobs, fencing, reclaim y reanudación | PASS | `apps/worker/src/jobs.integration.test.ts` |

Comandos reproducibles:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

El escenario operativo comprueba persistencia tras recarga y que un expediente
cerrado no permite cargar documentos ni crear nuevas versiones. El escenario
Archivista conserva la frontera fail-closed: AIP + DIP no se presenta como
`COMPLETED` cuando falta correlación verificable DIP → Item → File.

## Nivel B — aceptación local integrada

El Compose local reproduce las dependencias ICI-owned: PostgreSQL, Redis,
MinIO, ClamAV, migraciones y worker. API y web se ejecutan en el host para
mantener el flujo de desarrollo documentado.

| Gate | Resultado | Evidencia |
| --- | --- | --- |
| Sintaxis y variables requeridas del Compose | PASS | `docker compose --env-file infra/compose/.env.example -f infra/compose/docker-compose.yml config --quiet` |
| Stack local completo con OIDC y almacenamiento persistente | NOT VERIFIED | Requiere configuración local de secretos y una ejecución operativa prolongada |
| Backup/restore institucional | NOT VERIFIED | El entorno disponible no contiene un backup piloto representativo |
| Capacidad de producción | NOT VERIFIED | No se convierten tiempos de CI en SLOs de producción |

```bash
cp infra/compose/.env.example infra/compose/.env
pnpm infra:up
pnpm dev:api
pnpm dev:web
```

Verificaciones mínimas:

```bash
curl -fsS http://127.0.0.1:3000/health
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml ps
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml logs --tail=100 migrate worker
```

La autenticación OIDC real, AtoM y Archivematica no forman parte de este
Compose. Para un piloto deben configurarse como dependencias independientes;
no se deben sustituir por credenciales de desarrollo.

## Nivel C — aceptación de proveedores externos

Estado: `NOT VERIFIED` salvo ejecución explícita del spike vendor.

Procedimiento reproducible:

1. Ejecutar `make check fetch bootstrap` en `infra/spikes/archival-integration`.
2. Configurar únicamente el entorno aislado del spike y credenciales locales.
3. Habilitar en AtoM 2.10.2 la API REST, niveles y repositorio de prueba.
4. Configurar en Archivematica 1.18.0 el perfil `ici-mvp`, Transfer Source y
   entrega nativa a AtoM.
5. Ejecutar `make preflight hierarchy transfer status verify`.
6. Conservar `.state/runs/<run-id>/` como evidencia: respuestas AtoM,
   UUID/status de transfer e ingest, AIP/DIP, árbol AtoM y objeto descargado.

Un DIP identificado no basta para declarar integración archivística completada.
Si la API pública no prueba la relación con los Items bajo el File esperado,
el resultado correcto es intervención humana.

## Gates no verificados o bloqueados

| Gate | Estado | Motivo |
| --- | --- | --- |
| AtoM/Archivematica reales | NOT VERIFIED | Requiere stack vendor, configuración y credenciales explícitas |
| Restauración completa de un piloto productivo | NOT VERIFIED | El entorno local no representa backups institucionales ni OIDC real |
| Capacidad de producción | NOT VERIFIED | Las mediciones locales no son un SLO ni una extrapolación de capacidad |

No se introdujo una inferencia de éxito para cubrir estos gates.
