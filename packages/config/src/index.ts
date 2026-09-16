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
  readonly malwareLeaseSeconds?: number | undefined;
  readonly atomBaseUrl?: string | undefined;
  readonly atomApiKey?: string | undefined;
  readonly atomCulture?: string | undefined;
  readonly atomRequestTimeoutMs?: number | undefined;
  readonly atomDraftPolicy?: 'SERVICE_ACCOUNT_NO_PUBLISH' | undefined;
  readonly archivematica?: ArchivematicaWorkerConfig | undefined;
}

export interface ArchivematicaWorkerConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  readonly storageBaseUrl: string;
  readonly storageUsername: string;
  readonly storageApiKey: string;
  readonly storageRequestTimeoutMs: number;
  readonly pipelineUuid: string;
  readonly transferSourceLocationUuid: string;
  readonly processingConfiguration: string;
}

export type AtomDraftPolicy = 'SERVICE_ACCOUNT_NO_PUBLISH';

export interface AtomConfig {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly culture: string;
  readonly requestTimeoutMs: number;
  readonly draftPolicy: AtomDraftPolicy;
}

export function readArchivematicaConfig(environment: NodeJS.ProcessEnv = process.env): ArchivematicaWorkerConfig | undefined {
  const values = {
    baseUrl: blankToUndefined(environment.ARCHIVEMATICA_BASE_URL), username: blankToUndefined(environment.ARCHIVEMATICA_USERNAME), apiKey: blankToUndefined(environment.ARCHIVEMATICA_API_KEY),
    storageBaseUrl: blankToUndefined(environment.ARCHIVEMATICA_STORAGE_BASE_URL), storageUsername: blankToUndefined(environment.ARCHIVEMATICA_STORAGE_USERNAME), storageApiKey: blankToUndefined(environment.ARCHIVEMATICA_STORAGE_API_KEY),
    pipelineUuid: blankToUndefined(environment.ARCHIVEMATICA_PIPELINE_UUID), transferSourceLocationUuid: blankToUndefined(environment.ARCHIVEMATICA_TRANSFER_SOURCE_LOCATION_UUID), processingConfiguration: blankToUndefined(environment.ARCHIVEMATICA_PROCESSING_CONFIGURATION),
  };
  const enabled = Object.values(values).some((value) => value !== undefined);
  if (!enabled) return undefined;
  const required = (value: string | undefined, name: string): string => { if (value === undefined) throw new Error(`${name} is required when Archivematica is configured`); return value; };
  const baseUrl = required(values.baseUrl, 'ARCHIVEMATICA_BASE_URL'); const username = required(values.username, 'ARCHIVEMATICA_USERNAME'); const apiKey = required(values.apiKey, 'ARCHIVEMATICA_API_KEY');
  const storageBaseUrl = required(values.storageBaseUrl, 'ARCHIVEMATICA_STORAGE_BASE_URL'); const storageUsername = required(values.storageUsername, 'ARCHIVEMATICA_STORAGE_USERNAME'); const storageApiKey = required(values.storageApiKey, 'ARCHIVEMATICA_STORAGE_API_KEY');
  const pipelineUuid = required(values.pipelineUuid, 'ARCHIVEMATICA_PIPELINE_UUID'); const transferSourceLocationUuid = required(values.transferSourceLocationUuid, 'ARCHIVEMATICA_TRANSFER_SOURCE_LOCATION_UUID'); const processingConfiguration = required(values.processingConfiguration, 'ARCHIVEMATICA_PROCESSING_CONFIGURATION');
  for (const [name, value] of [['ARCHIVEMATICA_BASE_URL', baseUrl], ['ARCHIVEMATICA_STORAGE_BASE_URL', storageBaseUrl]] as const) { try { const parsed = new URL(value); if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(); if (environment.NODE_ENV === 'production' && parsed.protocol !== 'https:') throw new Error(); } catch { throw new Error(`${name} must be a valid HTTP/HTTPS URL${environment.NODE_ENV === 'production' ? ' using HTTPS in production' : ''}`); } }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(pipelineUuid)) throw new Error('ARCHIVEMATICA_PIPELINE_UUID must be a valid UUID');
  if (!uuid.test(transferSourceLocationUuid)) throw new Error('ARCHIVEMATICA_TRANSFER_SOURCE_LOCATION_UUID must be a valid UUID');
  return { baseUrl, username, apiKey, requestTimeoutMs: readOptionalPositive(environment.ARCHIVEMATICA_REQUEST_TIMEOUT_MS, 10_000), storageBaseUrl, storageUsername, storageApiKey, storageRequestTimeoutMs: readOptionalPositive(environment.ARCHIVEMATICA_STORAGE_REQUEST_TIMEOUT_MS, 10_000), pipelineUuid, transferSourceLocationUuid, processingConfiguration };
}

export function readAtomConfig(environment: NodeJS.ProcessEnv = process.env): AtomConfig {
  const baseUrl = blankToUndefined(environment.ATOM_BASE_URL);
  const apiKey = blankToUndefined(environment.ATOM_API_KEY);
  const culture = blankToUndefined(environment.ATOM_CULTURE) ?? 'en';
  const requestTimeoutMs = readOptionalPositive(environment.ATOM_REQUEST_TIMEOUT_MS, 10_000);
  const draftPolicyValue = blankToUndefined(environment.ATOM_DRAFT_POLICY);
  const draftPolicy: AtomDraftPolicy = draftPolicyValue === undefined ? 'SERVICE_ACCOUNT_NO_PUBLISH' : draftPolicyValue === 'SERVICE_ACCOUNT_NO_PUBLISH' ? draftPolicyValue : (() => { throw new Error('ATOM_DRAFT_POLICY must be SERVICE_ACCOUNT_NO_PUBLISH'); })();
  if (baseUrl !== undefined) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    } catch { throw new Error('ATOM_BASE_URL must be a valid HTTP or HTTPS URL'); }
  }
  if (baseUrl === undefined && apiKey !== undefined) throw new Error('ATOM_BASE_URL is required when ATOM_API_KEY is configured');
  if (baseUrl !== undefined && apiKey === undefined) throw new Error('ATOM_API_KEY is required when ATOM_BASE_URL is configured');
  if (baseUrl !== undefined && draftPolicyValue === undefined) throw new Error('ATOM_DRAFT_POLICY is required when AtoM is configured');
  return { baseUrl, apiKey, culture, requestTimeoutMs, draftPolicy };
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
  const atom = readAtomConfig(environment);
  const archivematica = readArchivematicaConfig(environment);
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
    s3Endpoint, s3Region: blankToUndefined(environment.S3_REGION) ?? 'us-east-1', s3AccessKeyId, s3SecretAccessKey, s3QuarantineBucket, s3CleanBucket, s3ForcePathStyle: environment.S3_FORCE_PATH_STYLE === 'true', malwarePollIntervalMs: readOptionalPositive(environment.MALWARE_POLL_INTERVAL_MS, 1000), malwareLeaseSeconds: readOptionalPositive(environment.MALWARE_LEASE_SECONDS, 300), atomBaseUrl: atom.baseUrl, atomApiKey: atom.apiKey, atomCulture: atom.culture, atomRequestTimeoutMs: atom.requestTimeoutMs, atomDraftPolicy: atom.draftPolicy, archivematica,
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
