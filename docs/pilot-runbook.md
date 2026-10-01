# Runbook mínimo de piloto — ICI Archivos

Este procedimiento cubre la instalación ICI-owned. AtoM y Archivematica son
servicios externos independientes y tienen su propio procedimiento de
aceptación en `infra/spikes/archival-integration/README.md`.

## Configuración

1. Instalar Node.js 22.12+, pnpm 11.1.3 y Docker Compose.
2. Copiar `infra/compose/.env.example` a `infra/compose/.env`.
3. Sustituir todos los secretos de ejemplo antes de compartir el entorno.
4. Configurar `DATABASE_URL`, OIDC y S3 según el entorno; producción exige
   HTTPS para OIDC y S3.
5. Configurar AtoM/Archivematica sólo con sus APIs documentadas y sus cuentas
   de servicio separadas. Nunca colocar API keys en el navegador o en URLs.

## Arranque y comprobación

```bash
pnpm install --frozen-lockfile
pnpm infra:up
curl -fsS http://127.0.0.1:3000/health
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml ps
pnpm dev:api
pnpm dev:web
```

La migración corre antes del worker. El worker requiere Redis, MinIO, ClamAV y
el rol PostgreSQL de aplicación; si una dependencia no está saludable no debe
considerarse listo para pilotaje.

## Diagnóstico seguro

```bash
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml logs --tail=200 migrate worker postgres minio clamav
```

Los logs pueden contener identificadores de correlación y errores operativos,
pero nunca deben contener API keys, tokens, credenciales, binarios ni secretos.
Un `503` de `/health` con `database: down` significa que la API respondió y que
PostgreSQL está degradado; no es equivalente a una API inalcanzable.

## Backup y recuperación mínima

ICI-owned:

```bash
pg_dump --format=custom --file=ici-archivos-$(date +%Y%m%d).dump "$DATABASE_URL"
mc alias set ici "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
mc mirror "$S3_QUARANTINE_BUCKET" ./backup/quarantine
mc mirror "$S3_CLEAN_BUCKET" ./backup/clean
```

Para una prueba desechable, restaure el dump en una base nueva, aplique las
migraciones sólo si aún faltan y verifique que cada `storage_key` usado por los
documentos sigue existiendo en el bucket correspondiente. Restaurar únicamente
PostgreSQL no restaura los binarios.

AtoM, Archivematica y Storage Service mantienen datos externos: sus backups,
AIPs, DIPs y configuración no están incluidos en el backup de ICI. La
restauración completa de un piloto requiere coordinar ambos límites y permanece
`NOT VERIFIED` sin un drill institucional.

## Recuperación operativa

- `USER_INPUT`, reconciliación e intervención se atienden en `/archive`; no se
  reenvía ciegamente una operación incierta.
- Un worker detenido se reanuda con el job durable y su fencing existente.
- Un AIP o DIP observado no se convierte por sí solo en `COMPLETED`.
- Ante divergencia de manifest, identidad remota o staging, conservar la
  evidencia y usar el procedimiento de reconciliación; no editar SQL para
  forzar estados.

## Cierre y limpieza local

```bash
pnpm infra:down
```

Para el spike vendor use únicamente su `make` de cleanup y un `SPIKE_RUN_ID`
nuevo. Nunca apunte los comandos de bootstrap a una instalación compartida o
de producción.
