import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AidmError,
  PolicyViolationError,
  StaleContextError,
} from '../dist/errors/index.js';

describe('AIDM Core Error Hierarchy and Code Distinction', () => {
  describe('AidmError', () => {
    it('should initialize with message, default code, and details', () => {
      const err = new AidmError('General error occurred', 'ERR_AIDM_GENERAL', { foo: 'bar' });
      assert.equal(err.message, 'General error occurred');
      assert.equal(err.code, 'ERR_AIDM_GENERAL');
      assert.deepEqual(err.details, { foo: 'bar' });
      assert.equal(err.name, 'AidmError');
    });

    it('should maintain proper prototype and instanceof behavior', () => {
      const err = new AidmError('Test error');
      assert.ok(err instanceof Error);
      assert.ok(err instanceof AidmError);
    });

    it('should serialize correctly with toJSON()', () => {
      const err = new AidmError('Serialization test', 'ERR_TEST', { id: 123 });
      const json = err.toJSON();
      assert.equal(json.name, 'AidmError');
      assert.equal(json.code, 'ERR_TEST');
      assert.equal(json.message, 'Serialization test');
      assert.deepEqual(json.details, { id: 123 });
      assert.ok(typeof json.stack === 'string');
    });
  });

  describe('PolicyViolationError', () => {
    it('should initialize with ERR_POLICY_VIOLATION default code and specific details', () => {
      const err = new PolicyViolationError('Destructive command blocked', {
        operation: 'rm -rf /',
        riskLevel: 'CRITICAL',
        suggestedAction: 'REQUIRE_HUMAN',
      });

      assert.equal(err.message, 'Destructive command blocked');
      assert.equal(err.code, 'ERR_POLICY_VIOLATION');
      assert.equal(err.operation, 'rm -rf /');
      assert.equal(err.riskLevel, 'CRITICAL');
      assert.equal(err.name, 'PolicyViolationError');
    });

    it('should maintain proper prototype and instanceof inheritance', () => {
      const err = new PolicyViolationError('Blocked');
      assert.ok(err instanceof Error);
      assert.ok(err instanceof AidmError);
      assert.ok(err instanceof PolicyViolationError);
      assert.ok(!(err instanceof StaleContextError));
    });
  });

  describe('StaleContextError', () => {
    it('should initialize with ERR_STALE_CONTEXT default code and hash details', () => {
      const err = new StaleContextError('File has been modified on disk', {
        filePath: 'src/service.ts',
        expectedHash: 'hash-aaa',
        actualHash: 'hash-bbb',
      });

      assert.equal(err.message, 'File has been modified on disk');
      assert.equal(err.code, 'ERR_STALE_CONTEXT');
      assert.equal(err.filePath, 'src/service.ts');
      assert.equal(err.expectedHash, 'hash-aaa');
      assert.equal(err.actualHash, 'hash-bbb');
      assert.equal(err.name, 'StaleContextError');
    });

    it('should maintain proper prototype and instanceof inheritance', () => {
      const err = new StaleContextError('Stale');
      assert.ok(err instanceof Error);
      assert.ok(err instanceof AidmError);
      assert.ok(err instanceof StaleContextError);
      assert.ok(!(err instanceof PolicyViolationError));
    });
  });

  describe('Error Code Distinction', () => {
    it('should have mutually distinct error codes across classes', () => {
      const baseErr = new AidmError('Base');
      const policyErr = new PolicyViolationError('Policy');
      const staleErr = new StaleContextError('Stale');

      assert.notEqual(baseErr.code, policyErr.code);
      assert.notEqual(policyErr.code, staleErr.code);
      assert.notEqual(baseErr.code, staleErr.code);

      assert.equal(baseErr.code, 'ERR_AIDM_GENERAL');
      assert.equal(policyErr.code, 'ERR_POLICY_VIOLATION');
      assert.equal(staleErr.code, 'ERR_STALE_CONTEXT');
    });
  });
});
