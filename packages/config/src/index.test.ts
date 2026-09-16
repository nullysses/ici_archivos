import { describe, expect, it } from 'vitest';
import { readApiConfig, readArchivematicaConfig, readAtomConfig } from './index.js';

describe('readApiConfig', () => {
  it('parses an explicit API port', () => {
    expect(readApiConfig({ API_PORT: '4100' }).port).toBe(4100);
  });

  it('rejects an invalid API port', () => {
    expect(() => readApiConfig({ API_PORT: '70000' })).toThrow('Invalid TCP port');
  });

  it('fails closed for missing production secrets and OIDC endpoints', () => {
    expect(() => readApiConfig({ NODE_ENV: 'production' })).toThrow('Missing required DATABASE_URL');
    expect(() => readApiConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db' })).toThrow('Missing required OIDC_ISSUER');
    expect(() => readApiConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db', OIDC_ISSUER: 'https://issuer.example', OIDC_AUDIENCE: 'ici' })).toThrow('Missing required OIDC_JWKS_URI or OIDC_DISCOVERY_URL');
  });

  it('requires HTTPS for production OIDC endpoints', () => {
    expect(() => readApiConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db', OIDC_ISSUER: 'http://issuer.example', OIDC_AUDIENCE: 'ici', OIDC_JWKS_URI: 'http://issuer.example/jwks' })).toThrow('OIDC_ISSUER must use HTTPS');
  });
});

describe('readAtomConfig', () => {
  it('normalizes optional AtoM configuration and keeps it disabled by default', () => {
    expect(readAtomConfig({})).toEqual({ baseUrl: undefined, apiKey: undefined, culture: 'en', requestTimeoutMs: 10_000, draftPolicy: 'SERVICE_ACCOUNT_NO_PUBLISH' });
    expect(readAtomConfig({ ATOM_BASE_URL: 'https://atom.example///', ATOM_API_KEY: 'key', ATOM_CULTURE: 'es', ATOM_REQUEST_TIMEOUT_MS: '2500', ATOM_DRAFT_POLICY: 'SERVICE_ACCOUNT_NO_PUBLISH' })).toEqual({ baseUrl: 'https://atom.example///', apiKey: 'key', culture: 'es', requestTimeoutMs: 2500, draftPolicy: 'SERVICE_ACCOUNT_NO_PUBLISH' });
  });

  it('requires complete and valid AtoM configuration', () => {
    expect(() => readAtomConfig({ ATOM_API_KEY: 'key' })).toThrow('ATOM_BASE_URL');
    expect(() => readAtomConfig({ ATOM_BASE_URL: 'https://atom.example' })).toThrow('ATOM_API_KEY');
    expect(() => readAtomConfig({ ATOM_BASE_URL: 'https://atom.example', ATOM_API_KEY: 'key' })).toThrow('ATOM_DRAFT_POLICY');
    expect(() => readAtomConfig({ ATOM_BASE_URL: 'ftp://atom.example', ATOM_API_KEY: 'key' })).toThrow('ATOM_BASE_URL');
    expect(() => readAtomConfig({ ATOM_DRAFT_POLICY: 'PUBLISH' })).toThrow('ATOM_DRAFT_POLICY');
  });
});

describe('readArchivematicaConfig', () => {
  const valid = {
    ARCHIVEMATICA_BASE_URL: 'https://archivematica.example', ARCHIVEMATICA_USERNAME: 'ici', ARCHIVEMATICA_API_KEY: 'secret',
    ARCHIVEMATICA_STORAGE_BASE_URL: 'https://storage.example', ARCHIVEMATICA_STORAGE_USERNAME: 'ici-ss', ARCHIVEMATICA_STORAGE_API_KEY: 'storage-secret',
    ARCHIVEMATICA_PIPELINE_UUID: '44444444-4444-4444-8444-444444444444', ARCHIVEMATICA_TRANSFER_SOURCE_LOCATION_UUID: '55555555-5555-4555-8555-555555555555', ARCHIVEMATICA_PROCESSING_CONFIGURATION: 'automated',
  };

  it('keeps Archivematica disabled by default and parses a complete config', () => {
    expect(readArchivematicaConfig({})).toBeUndefined();
    expect(readArchivematicaConfig(valid)).toMatchObject({ baseUrl: valid.ARCHIVEMATICA_BASE_URL, processingConfiguration: 'automated', requestTimeoutMs: 10_000 });
  });

  it('fails closed for incomplete credentials, invalid UUIDs, and invalid production URLs', () => {
    expect(() => readArchivematicaConfig({ ARCHIVEMATICA_BASE_URL: 'https://archivematica.example' })).toThrow('ARCHIVEMATICA_USERNAME');
    expect(() => readArchivematicaConfig({ ...valid, ARCHIVEMATICA_PIPELINE_UUID: 'bad' })).toThrow('PIPELINE_UUID');
    expect(() => readArchivematicaConfig({ ...valid, NODE_ENV: 'production', ARCHIVEMATICA_BASE_URL: 'http://archivematica.example' })).toThrow('HTTPS');
    expect(() => readArchivematicaConfig({ ...valid, ARCHIVEMATICA_REQUEST_TIMEOUT_MS: '0' })).toThrow('positive integer');
  });
});
