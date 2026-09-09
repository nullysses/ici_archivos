import { describe, expect, it } from 'vitest';
import { canPerform, type AuthorizationContext, type Capability } from './index.js';

const userId = '00000000-0000-4000-8000-000000000001';
const institutionId = '00000000-0000-4000-8000-000000000002';
const unitA = '00000000-0000-4000-8000-000000000003';
const unitB = '00000000-0000-4000-8000-000000000004';

function context(institutionCapabilities: readonly Capability[], unitCapabilities: ReadonlyArray<readonly [string, readonly Capability[]]>): AuthorizationContext {
  return {
    userId,
    institutionId,
    institutionCapabilities: new Set(institutionCapabilities),
    unitCapabilities: new Map(unitCapabilities.map(([unitId, granted]) => [unitId, new Set(granted)])),
  };
}

describe('scoped authorization evaluation', () => {
  it('does not cross-product capabilities granted through different units', () => {
    const authorization = context([], [[unitA, ['matter.assign']], [unitB, ['matter.start']]]);
    expect(canPerform(authorization, 'matter.assign', unitA)).toBe(true);
    expect(canPerform(authorization, 'matter.start', unitB)).toBe(true);
    expect(canPerform(authorization, 'matter.start', unitA)).toBe(false);
    expect(canPerform(authorization, 'matter.assign', unitB)).toBe(false);
  });

  it('does not elevate a unit grant to institution or sibling-unit scope', () => {
    const authorization = context([], [[unitA, ['matter.start']]]);
    expect(canPerform(authorization, 'matter.start', unitA)).toBe(true);
    expect(canPerform(authorization, 'matter.start', unitB)).toBe(false);
    expect(canPerform(authorization, 'matter.start')).toBe(false);
  });

  it('allows institution grants everywhere while preserving other unit-specific grants', () => {
    const authorization = context(['matter.start'], [[unitA, ['matter.assign']]]);
    expect(canPerform(authorization, 'matter.start')).toBe(true);
    expect(canPerform(authorization, 'matter.start', unitA)).toBe(true);
    expect(canPerform(authorization, 'matter.start', unitB)).toBe(true);
    expect(canPerform(authorization, 'matter.assign', unitA)).toBe(true);
    expect(canPerform(authorization, 'matter.assign', unitB)).toBe(false);
  });
});
