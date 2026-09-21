import { describe, expect, it } from 'vitest';
import { can, type Session } from './api.js';

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
  });
});
