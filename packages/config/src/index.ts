export interface ApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly webOrigin: string;
  readonly oidcIssuer: string | undefined;
  readonly oidcAudience: string | undefined;
  readonly oidcJwksUri: string | undefined;
  readonly oidcDiscoveryUrl: string | undefined;
  readonly isProduction: boolean;
}

export interface WorkerConfig {
  readonly redisUrl: string;
}

export function readApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const isProduction = environment.NODE_ENV === 'production';
  const databaseUrl = blankToUndefined(environment.DATABASE_URL) ?? (isProduction ? undefined : 'postgres://ici_app:change-me-local-only@127.0.0.1:5432/ici_archivos');
  const oidcIssuer = blankToUndefined(environment.OIDC_ISSUER);
  const oidcAudience = blankToUndefined(environment.OIDC_AUDIENCE);
  const oidcJwksUri = blankToUndefined(environment.OIDC_JWKS_URI);
  const oidcDiscoveryUrl = blankToUndefined(environment.OIDC_DISCOVERY_URL);
  if (isProduction) {
    requireValue(databaseUrl, 'DATABASE_URL');
    requireValue(oidcIssuer, 'OIDC_ISSUER');
    requireValue(oidcAudience, 'OIDC_AUDIENCE');
    if (oidcJwksUri === undefined && oidcDiscoveryUrl === undefined) throw new Error('Missing required OIDC_JWKS_URI or OIDC_DISCOVERY_URL');
    for (const [name, value] of [['OIDC_ISSUER', oidcIssuer], ['OIDC_JWKS_URI', oidcJwksUri], ['OIDC_DISCOVERY_URL', oidcDiscoveryUrl]] as const) {
      if (value !== undefined && !isHttpsUrl(value)) throw new Error(`${name} must use HTTPS in production`);
    }
  }
  return {
    databaseUrl: databaseUrl ?? '',
    host: environment.API_HOST ?? '127.0.0.1',
    port: readPort(environment.API_PORT, 3000),
    webOrigin: environment.WEB_ORIGIN ?? 'http://127.0.0.1:5174',
    oidcIssuer,
    oidcAudience,
    oidcJwksUri,
    oidcDiscoveryUrl,
    isProduction,
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

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function requireValue(value: string | undefined, name: string): asserts value is string {
  if (value === undefined) throw new Error(`Missing required ${name}`);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
