import { describe, expect, it, vi } from 'vitest';
import { can, canAnywhere, canInUnit, canInstitution, fetchHealth, type Session } from './api.js';

const session: Session = {
  userId: 'user-1',
  institutionId: 'institution-1',
  issuer: 'https://issuer.example.test',
  subject: 'subject-1',
  institutionCapabilities: ['records.read', 'archive_transfer.approve'],
  unitCapabilities: { 'unit-a': ['matter.assign'] },
};

describe('frontend capability presentation', () => {
  it('uses institution capabilities as the source for global navigation', () => {
    expect(can(session, 'records.read')).toBe(true);
    expect(can(session, 'identity.manage')).toBe(false);
    expect(can(null, 'records.read')).toBe(false);
  });

  it('does not elevate a unit-scoped capability to institution scope', () => {
    expect(can(session, 'matter.assign')).toBe(false);
    expect(canInstitution(session, 'matter.assign')).toBe(false);
    expect(canInUnit(session, 'matter.assign', 'unit-a')).toBe(true);
    expect(canInUnit(session, 'matter.assign', 'unit-b')).toBe(false);
    expect(canAnywhere(session, 'matter.assign')).toBe(true);
  });

  it('preserves the degraded health response returned with HTTP 503', async () => {
    const response = new Response(JSON.stringify({ status: 'degraded', service: 'api', version: 'test', timestamp: '2026-09-21T00:00:00.000Z', dependencies: { database: 'down' } }), { headers: { 'Content-Type': 'application/json' }, status: 503 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchHealth()).resolves.toMatchObject({ status: 'degraded', dependencies: { database: 'down' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
