export interface ApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly webOrigin: string;
}

export interface WorkerConfig {
  readonly redisUrl: string;
}

export function readApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    databaseUrl: environment.DATABASE_URL ?? 'postgres://ici_app:change-me-local-only@127.0.0.1:5432/ici_archivos',
    host: environment.API_HOST ?? '127.0.0.1',
    port: readPort(environment.API_PORT, 3000),
    webOrigin: environment.WEB_ORIGIN ?? 'http://127.0.0.1:5173',
  };
}

export function readWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return { redisUrl: environment.REDIS_URL ?? 'redis://127.0.0.1:6379' };
}

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid TCP port: ${value}`);
  }
  return parsed;
}

