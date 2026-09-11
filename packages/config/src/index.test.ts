import { describe, expect, it } from 'vitest';
import { readApiConfig } from './index.js';

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
