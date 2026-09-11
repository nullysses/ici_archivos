import { describe, expect, it, beforeAll } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { createJoseAccessTokenVerifier, JoseAccessTokenVerifier } from './oidc.js';

const issuer = 'https://issuer.example.test';
const audience = 'ici-archivos';
const jwksUri = 'https://issuer.example.test/.well-known/jwks.json';

describe('JoseAccessTokenVerifier', () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let alternatePublicKey: CryptoKey;

  beforeAll(async () => {
    const generated = await generateKeyPair('RS256');
    privateKey = generated.privateKey;
    publicKey = generated.publicKey;
    alternatePublicKey = (await generateKeyPair('RS256')).publicKey;
  });

  async function token(overrides: { issuer?: string; audience?: string; subject?: string | undefined; expirationTime?: string; notBefore?: string; kid?: string } = {}): Promise<string> {
    const builder = new SignJWT(overrides.subject === undefined ? {} : { sub: overrides.subject })
      .setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? 'test-key' })
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt();
    if (overrides.expirationTime !== undefined) builder.setExpirationTime(overrides.expirationTime);
    else builder.setExpirationTime('5m');
    if (overrides.notBefore !== undefined) builder.setNotBefore(overrides.notBefore);
    return builder.sign(privateKey);
  }

  function verifier(keySet = createLocalJWKSet({ keys: [] })) {
    return new JoseAccessTokenVerifier({ issuer, audience, jwksUri }, { keySet });
  }

  it('accepts a valid signed token and returns verified issuer and subject', async () => {
    const jwk = await exportJWK(publicKey);
    const result = await verifier(createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })).verify(await token({ subject: 'subject-1' }));
    expect(result).toEqual({ issuer, subject: 'subject-1' });
  });

  it.each([
    ['wrong issuer', { issuer: 'https://other.example.test' }],
    ['wrong audience', { audience: 'other-audience' }],
    ['expired token', { expirationTime: '0s' }],
    ['future nbf', { notBefore: '10m' }],
    ['missing subject', { subject: undefined }],
  ])('rejects %s', async (_name, overrides) => {
    const jwk = await exportJWK(publicKey);
    const local = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
    await expect(verifier(local).verify(await token(overrides))).rejects.toThrow();
  });

  it('rejects an invalid signature and an unknown signing key', async () => {
    const alternateJwk = await exportJWK(alternatePublicKey);
    const invalidSignature = createLocalJWKSet({ keys: [{ ...alternateJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
    await expect(verifier(invalidSignature).verify(await token({ subject: 'subject-1' }))).rejects.toThrow();
    const knownJwk = await exportJWK(publicKey);
    const unknownKey = createLocalJWKSet({ keys: [{ ...knownJwk, kid: 'different-key', alg: 'RS256', use: 'sig' }] });
    await expect(verifier(unknownKey).verify(await token({ subject: 'subject-1' }))).rejects.toThrow();
  });

  it('rejects malformed or empty JWKS', async () => {
    await expect(verifier().verify(await token({ subject: 'subject-1' }))).rejects.toThrow();
  });

  it('validates the configured issuer when loading OIDC discovery', async () => {
    const config = {
      databaseUrl: 'postgres://unused',
      host: '127.0.0.1',
      port: 3000,
      webOrigin: 'http://127.0.0.1:5174',
      oidcIssuer: issuer,
      oidcAudience: audience,
      oidcJwksUri: undefined,
      oidcDiscoveryUrl: 'https://issuer.example.test/.well-known/openid-configuration',
      isProduction: false,
    };
    const fetchImplementation = () => Promise.resolve(new Response(JSON.stringify({ issuer: 'https://attacker.example.test', jwks_uri: jwksUri }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(createJoseAccessTokenVerifier(config, { fetchImplementation })).rejects.toThrow('OIDC_DISCOVERY_INVALID');
  });
});
