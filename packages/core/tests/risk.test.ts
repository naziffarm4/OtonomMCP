import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RiskLevel,
  RISK_LEVELS,
  SAFE,
  CAUTION,
  DANGEROUS,
  CRITICAL,
  isRiskLevel,
} from '../dist/risk.js';

describe('RiskLevel Definitions and Policy Hierarchy', () => {
  it('should define all four required risk levels in RiskLevel enum/object', () => {
    assert.equal(RiskLevel.SAFE, 'SAFE');
    assert.equal(RiskLevel.CAUTION, 'CAUTION');
    assert.equal(RiskLevel.DANGEROUS, 'DANGEROUS');
    assert.equal(RiskLevel.CRITICAL, 'CRITICAL');
  });

  it('should export standalone risk level constants matching RiskLevel values', () => {
    assert.equal(SAFE, 'SAFE');
    assert.equal(CAUTION, 'CAUTION');
    assert.equal(DANGEROUS, 'DANGEROUS');
    assert.equal(CRITICAL, 'CRITICAL');
  });

  it('should list all risk levels in RISK_LEVELS array', () => {
    assert.deepEqual([...RISK_LEVELS], ['SAFE', 'CAUTION', 'DANGEROUS', 'CRITICAL']);
  });

  it('should correctly validate risk levels with isRiskLevel guard', () => {
    assert.equal(isRiskLevel('SAFE'), true);
    assert.equal(isRiskLevel('CAUTION'), true);
    assert.equal(isRiskLevel('DANGEROUS'), true);
    assert.equal(isRiskLevel('CRITICAL'), true);

    assert.equal(isRiskLevel('SUPER_SAFE'), false);
    assert.equal(isRiskLevel(''), false);
    assert.equal(isRiskLevel(null), false);
    assert.equal(isRiskLevel(999), false);
    assert.equal(isRiskLevel({}), false);
  });
});
