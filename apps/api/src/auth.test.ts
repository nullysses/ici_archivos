import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@ici/database';

const databaseMocks = vi.hoisted(() => ({
  resolveAuthorizationContext: vi.fn(),
  resolveExternalIdentity: vi.fn(),
  withTenantTransaction: vi.fn(),
}));

vi.mock('@ici/database', () => databaseMocks);

import { authenticateAccessToken, type AccessTokenVerifier } from './auth.js';

type TransactionCallback = (transaction: unknown) => Promise<unknown>;

describe('authenticateAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.withTenantTransaction.mockImplementation(async (_database: unknown, _institutionId: string, callback: TransactionCallback) => callback({}));
  });

  it('returns scoped authorization resolved by ICI persistence, not token claims', async () => {
    const issuer = 'https://issuer.example.test';
    const subject = 'subject-123';
    const userId = '90000000-0000-4000-8000-000000000201';
    const institutionId = '90000000-0000-4000-8000-000000000202';
    const unitId = '90000000-0000-4000-8000-000000000203';
    const authorization = { userId, institutionId, institutionCapabilities: new Set(['records.read']), unitCapabilities: new Map([[unitId, new Set(['matter.start'])]]) };
    databaseMocks.resolveExternalIdentity.mockResolvedValue({ institutionId, userId, status: 'ACTIVE' });
    databaseMocks.resolveAuthorizationContext.mockResolvedValue(authorization);
    const verifier: AccessTokenVerifier = { verify: vi.fn().mockResolvedValue({ issuer, subject, email: 'changed@example.test', permissions: ['identity.manage'], authorizedUnitIds: ['forged-unit'] }) };

    const principal = await authenticateAccessToken({} as Database, verifier, 'access-token');

    expect(principal).toMatchObject({ userId, institutionId, issuer, subject, authorization });
    expect(principal).not.toHaveProperty('permissions');
    expect(principal).not.toHaveProperty('authorizedUnitIds');
    expect(databaseMocks.resolveExternalIdentity).toHaveBeenCalledWith(expect.anything(), issuer, subject);
    expect(databaseMocks.resolveAuthorizationContext).toHaveBeenCalledWith(expect.anything(), institutionId, userId);
  });

  it('rejects unknown or inactive issuer-subject identities before resolving authorization', async () => {
    const verifier: AccessTokenVerifier = { verify: vi.fn().mockResolvedValue({ issuer: 'https://wrong-issuer.example.test', subject: 'unknown' }) };
    databaseMocks.resolveExternalIdentity.mockResolvedValue(undefined);
    await expect(authenticateAccessToken({} as Database, verifier, 'access-token')).rejects.toThrow('UNAUTHENTICATED');
    databaseMocks.resolveExternalIdentity.mockResolvedValue({ institutionId: '90000000-0000-4000-8000-000000000204', userId: '90000000-0000-4000-8000-000000000205', status: 'INACTIVE' });
    await expect(authenticateAccessToken({} as Database, verifier, 'access-token')).rejects.toThrow('UNAUTHENTICATED');
    expect(databaseMocks.resolveAuthorizationContext).not.toHaveBeenCalled();
  });
});
