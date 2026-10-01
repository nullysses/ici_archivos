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
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml ps
```

La migración corre antes del worker. El worker requiere Redis, MinIO, ClamAV y
el rol PostgreSQL de aplicación; si una dependencia no está saludable no debe
considerarse listo para pilotaje. La API y la web son procesos persistentes:
arráncalos en terminales independientes:

```bash
# Terminal 1
pnpm dev:api

# Terminal 2
pnpm dev:web
```

También puede usarse el comando conjunto, que mantiene ambos procesos activos:

```bash
pnpm dev
```

Sólo después de que la API esté escuchando, comprueba su estado:

```bash
curl -fsS http://127.0.0.1:3000/health
```

## Diagnóstico seguro

```bash
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml logs --tail=200 migrate worker postgres minio clamav
```

Los logs pueden contener identificadores de correlación y errores operativos,
pero nunca deben contener API keys, tokens, credenciales, binarios ni secretos.
Un `503` de `/health` con `database: down` significa que la API respondió y que
PostgreSQL está degradado; no es equivalente a una API inalcanzable.

## Backup y recuperación mínima

Clientes necesarios: Docker Compose, `curl`, `mc` (MinIO Client) y los
clientes PostgreSQL `pg_dump`/`pg_restore` si se ejecutan fuera del contenedor.
Las credenciales deben cargarse desde un archivo local no versionado:

```bash
set -a; . infra/compose/.env; set +a
```

ICI-owned:

```bash
backup_stamp=$(date +%Y%m%d)
mc alias set ici "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
mc mirror "ici/$S3_QUARANTINE_BUCKET" ./backup/quarantine
mc mirror "ici/$S3_CLEAN_BUCKET" ./backup/clean

# No usar ici_app para un respaldo integral. En Compose, POSTGRES_USER es la
# identidad migradora con privilegios suficientes para pg_dump.
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml \
  exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom --file="/tmp/ici-archivos-$backup_stamp.dump"
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml \
  cp "postgres:/tmp/ici-archivos-$backup_stamp.dump" \
  "./ici-archivos-$backup_stamp.dump"
```

En un piloto institucional, sustituye `POSTGRES_USER` por una identidad de
respaldo administrada por la plataforma con privilegios explícitos para leer
todos los esquemas/tablas y secuencias necesarios para `pg_dump` (y sólo esos
privilegios). La identidad `ici_app` es el rol de aplicación, está sujeta a RLS
y no debe utilizarse para un respaldo integral.

Para una restauración desechable se requieren `pg_restore` y una base nueva;
aplica las migraciones sólo si aún faltan y verifica que cada `storage_key`
usado por los documentos sigue existiendo en el bucket correspondiente. El
procedimiento de recuperación completo queda para la siguiente fase de QA y
permanece `NOT VERIFIED`; restaurar únicamente PostgreSQL no restaura los
binarios.

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
