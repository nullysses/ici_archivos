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
  readonly s3Endpoint?: string | undefined;
  readonly s3Region?: string | undefined;
  readonly s3AccessKeyId?: string | undefined;
  readonly s3SecretAccessKey?: string | undefined;
  readonly s3QuarantineBucket?: string | undefined;
  readonly s3CleanBucket?: string | undefined;
  readonly s3ForcePathStyle?: boolean | undefined;
  readonly fileUploadDefaultMaxBytes?: bigint | undefined;
}

export interface WorkerConfig {
  readonly redisUrl: string;
  readonly databaseUrl?: string | undefined;
  readonly clamavHost?: string | undefined;
  readonly clamavPort?: number | undefined;
  readonly clamavConnectTimeoutMs?: number | undefined;
  readonly clamavReadTimeoutMs?: number | undefined;
  readonly s3Endpoint?: string | undefined;
  readonly s3Region?: string | undefined;
  readonly s3AccessKeyId?: string | undefined;
  readonly s3SecretAccessKey?: string | undefined;
  readonly s3QuarantineBucket?: string | undefined;
  readonly s3CleanBucket?: string | undefined;
  readonly s3ForcePathStyle?: boolean | undefined;
  readonly malwarePollIntervalMs?: number | undefined;
}

export function readApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const isProduction = environment.NODE_ENV === 'production';
  const databaseUrl = blankToUndefined(environment.DATABASE_URL) ?? (isProduction ? undefined : 'postgres://ici_app:change-me-local-only@127.0.0.1:5432/ici_archivos');
  const oidcIssuer = blankToUndefined(environment.OIDC_ISSUER);
  const oidcAudience = blankToUndefined(environment.OIDC_AUDIENCE);
  const oidcJwksUri = blankToUndefined(environment.OIDC_JWKS_URI);
  const oidcDiscoveryUrl = blankToUndefined(environment.OIDC_DISCOVERY_URL);
  const s3Endpoint = blankToUndefined(environment.S3_ENDPOINT);
  const s3AccessKeyId = blankToUndefined(environment.S3_ACCESS_KEY_ID);
  const s3SecretAccessKey = blankToUndefined(environment.S3_SECRET_ACCESS_KEY);
  const s3QuarantineBucket = blankToUndefined(environment.S3_QUARANTINE_BUCKET);
  const s3CleanBucket = blankToUndefined(environment.S3_CLEAN_BUCKET);
  const fileUploadDefaultMaxBytes = environment.FILE_UPLOAD_DEFAULT_MAX_BYTES === undefined ? 500n * 1024n * 1024n : readByteLimit(environment.FILE_UPLOAD_DEFAULT_MAX_BYTES, 'FILE_UPLOAD_DEFAULT_MAX_BYTES');
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
    s3Endpoint,
    s3Region: blankToUndefined(environment.S3_REGION) ?? 'us-east-1',
    s3AccessKeyId,
    s3SecretAccessKey,
    s3QuarantineBucket,
    s3CleanBucket,
    s3ForcePathStyle: environment.S3_FORCE_PATH_STYLE === 'true',
    fileUploadDefaultMaxBytes,
    isProduction,
  };
}

export function readWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const production = environment.NODE_ENV === 'production';
  const databaseUrl = blankToUndefined(environment.DATABASE_URL) ?? (production ? undefined : 'postgres://ici_app:change-me-local-only@127.0.0.1:5432/ici_archivos');
  const clamavHost = blankToUndefined(environment.CLAMAV_HOST);
  const s3Endpoint = blankToUndefined(environment.S3_ENDPOINT);
  const s3AccessKeyId = blankToUndefined(environment.S3_ACCESS_KEY_ID);
  const s3SecretAccessKey = blankToUndefined(environment.S3_SECRET_ACCESS_KEY);
  const s3QuarantineBucket = blankToUndefined(environment.S3_QUARANTINE_BUCKET);
  const s3CleanBucket = blankToUndefined(environment.S3_CLEAN_BUCKET);
  if (production) {
    requireValue(databaseUrl, 'DATABASE_URL');
    requireValue(clamavHost, 'CLAMAV_HOST');
    requireValue(s3Endpoint, 'S3_ENDPOINT');
    requireValue(s3AccessKeyId, 'S3_ACCESS_KEY_ID');
    requireValue(s3SecretAccessKey, 'S3_SECRET_ACCESS_KEY');
    requireValue(s3QuarantineBucket, 'S3_QUARANTINE_BUCKET');
    requireValue(s3CleanBucket, 'S3_CLEAN_BUCKET');
    if (!isHttpsUrl(s3Endpoint)) throw new Error('S3_ENDPOINT must use HTTPS in production');
  }
  return {
    redisUrl: environment.REDIS_URL ?? 'redis://127.0.0.1:6379', databaseUrl, clamavHost,
    clamavPort: readOptionalPort(environment.CLAMAV_PORT, 3310), clamavConnectTimeoutMs: readOptionalPositive(environment.CLAMAV_CONNECT_TIMEOUT_MS, 5000), clamavReadTimeoutMs: readOptionalPositive(environment.CLAMAV_READ_TIMEOUT_MS, 30000),
    s3Endpoint, s3Region: blankToUndefined(environment.S3_REGION) ?? 'us-east-1', s3AccessKeyId, s3SecretAccessKey, s3QuarantineBucket, s3CleanBucket, s3ForcePathStyle: environment.S3_FORCE_PATH_STYLE === 'true', malwarePollIntervalMs: readOptionalPositive(environment.MALWARE_POLL_INTERVAL_MS, 1000),
  };
}

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid TCP port: ${value}`);
  }
  return parsed;
}

function readOptionalPort(value: string | undefined, fallback: number): number { return value === undefined ? fallback : readPort(value, fallback); }
function readOptionalPositive(value: string | undefined, fallback: number): number { if (value === undefined) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid positive integer: ${value}`); return parsed; }

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

function readByteLimit(value: string, name: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > 2n * 1024n * 1024n * 1024n) throw new Error();
    return parsed;
  } catch { throw new Error(`${name} must be an integer between 0 and 2147483648 bytes`); }
}
