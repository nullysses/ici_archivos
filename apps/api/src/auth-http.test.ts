import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from './app.js';
import type { AuthenticatedPrincipal } from './auth.js';
import { JoseAccessTokenVerifier } from './oidc.js';

describe('Fastify authentication seam', () => {
  it('passes a real jose-verified JWT through HTTP to /auth/me', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    const verifier = new JoseAccessTokenVerifier({ issuer: 'https://issuer.example.test', audience: 'ici-archivos', jwksUri: 'https://issuer.example.test/jwks' }, {
      keySet: createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }),
    });
    const principal: AuthenticatedPrincipal = {
      userId: '00000000-0000-4000-8000-000000000001',
      institutionId: '00000000-0000-4000-8000-000000000002',
      issuer: 'https://issuer.example.test',
      subject: 'subject-1',
      authorization: { userId: '00000000-0000-4000-8000-000000000001', institutionId: '00000000-0000-4000-8000-000000000002', institutionCapabilities: new Set(), unitCapabilities: new Map() },
    };
    const app = await createApp({
      authenticateAccessToken: async (accessToken) => {
        const verified = await verifier.verify(accessToken);
        return { ...principal, issuer: verified.issuer, subject: verified.subject };
      },
      checkDatabase: () => Promise.resolve(true),
      version: 'test',
      webOrigin: 'http://localhost',
    });
    const token = await new SignJWT({ permissions: ['identity.manage'], roles: ['ADMINISTRATOR'], institutionId: 'attacker', authorizedUnitIds: ['attacker-unit'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(principal.issuer)
      .setAudience('ici-archivos')
      .setSubject(principal.subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const response = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: principal.userId, institutionId: principal.institutionId, issuer: principal.issuer, subject: principal.subject });
  });
});
