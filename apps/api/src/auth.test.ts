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

  it('returns units resolved by ICI authorization persistence, not token claims', async () => {
    const issuer = 'https://issuer.example.test';
    const subject = 'subject-123';
    const userId = '90000000-0000-4000-8000-000000000201';
    const institutionId = '90000000-0000-4000-8000-000000000202';
    const authorizedUnitIds = new Set(['90000000-0000-4000-8000-000000000203']);
    databaseMocks.resolveExternalIdentity.mockResolvedValue({ institutionId, userId, status: 'ACTIVE' });
    databaseMocks.resolveAuthorizationContext.mockResolvedValue({ userId, institutionId, capabilities: new Set(['matter.start']), authorizedUnitIds });
    const verifier: AccessTokenVerifier = { verify: vi.fn().mockResolvedValue({ issuer, subject, email: 'changed@example.test' }) };

    const principal = await authenticateAccessToken({} as Database, verifier, 'access-token');

    expect(principal).toMatchObject({ userId, institutionId, issuer, subject, authorizedUnitIds });
    expect(principal.permissions.has('matter.start')).toBe(true);
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
