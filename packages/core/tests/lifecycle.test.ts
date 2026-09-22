import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LifecycleState,
  SystemState,
  LIFECYCLE_STATES,
  INITIALIZING,
  REQUIREMENTS_INGESTION,
  ARCHITECTURE_SPEC,
  TASK_DECOMPOSITION,
  TASK_SELECTION,
  TASK_LOOP,
  BLOCKED_ON_HUMAN,
  RESUME_EXACT_BLOCKED_POINT,
  PROJECT_COMPLETE,
  isLifecycleState,
  TaskLoopState,
  TASK_LOOP_STATES,
  isTaskLoopState,
} from '../dist/lifecycle.js';

describe('System Lifecycle and TaskLoop State Definitions', () => {
  it('should define all 9 authoritative lifecycle states in LifecycleState object', () => {
    assert.equal(LifecycleState.INITIALIZING, 'INITIALIZING');
    assert.equal(LifecycleState.REQUIREMENTS_INGESTION, 'REQUIREMENTS_INGESTION');
    assert.equal(LifecycleState.ARCHITECTURE_SPEC, 'ARCHITECTURE_SPEC');
    assert.equal(LifecycleState.TASK_DECOMPOSITION, 'TASK_DECOMPOSITION');
    assert.equal(LifecycleState.TASK_SELECTION, 'TASK_SELECTION');
    assert.equal(LifecycleState.TASK_LOOP, 'TASK_LOOP');
    assert.equal(LifecycleState.BLOCKED_ON_HUMAN, 'BLOCKED_ON_HUMAN');
    assert.equal(LifecycleState.RESUME_EXACT_BLOCKED_POINT, 'RESUME_EXACT_BLOCKED_POINT');
    assert.equal(LifecycleState.PROJECT_COMPLETE, 'PROJECT_COMPLETE');
  });

  it('should export standalone state constants matching LifecycleState values', () => {
    assert.equal(INITIALIZING, 'INITIALIZING');
    assert.equal(REQUIREMENTS_INGESTION, 'REQUIREMENTS_INGESTION');
    assert.equal(ARCHITECTURE_SPEC, 'ARCHITECTURE_SPEC');
    assert.equal(TASK_DECOMPOSITION, 'TASK_DECOMPOSITION');
    assert.equal(TASK_SELECTION, 'TASK_SELECTION');
    assert.equal(TASK_LOOP, 'TASK_LOOP');
    assert.equal(BLOCKED_ON_HUMAN, 'BLOCKED_ON_HUMAN');
    assert.equal(RESUME_EXACT_BLOCKED_POINT, 'RESUME_EXACT_BLOCKED_POINT');
    assert.equal(PROJECT_COMPLETE, 'PROJECT_COMPLETE');
  });

  it('should maintain SystemState as an alias to LifecycleState', () => {
    assert.equal(SystemState, LifecycleState);
    assert.equal(SystemState.TASK_LOOP, 'TASK_LOOP');
  });

  it('should list all 9 lifecycle states in LIFECYCLE_STATES array', () => {
    assert.deepEqual([...LIFECYCLE_STATES], [
      'INITIALIZING',
      'REQUIREMENTS_INGESTION',
      'ARCHITECTURE_SPEC',
      'TASK_DECOMPOSITION',
      'TASK_SELECTION',
      'TASK_LOOP',
      'BLOCKED_ON_HUMAN',
      'RESUME_EXACT_BLOCKED_POINT',
      'PROJECT_COMPLETE',
    ]);
  });

  it('should correctly validate lifecycle states with isLifecycleState guard', () => {
    assert.equal(isLifecycleState('INITIALIZING'), true);
    assert.equal(isLifecycleState('REQUIREMENTS_INGESTION'), true);
    assert.equal(isLifecycleState('ARCHITECTURE_SPEC'), true);
    assert.equal(isLifecycleState('TASK_DECOMPOSITION'), true);
    assert.equal(isLifecycleState('TASK_SELECTION'), true);
    assert.equal(isLifecycleState('TASK_LOOP'), true);
    assert.equal(isLifecycleState('BLOCKED_ON_HUMAN'), true);
    assert.equal(isLifecycleState('RESUME_EXACT_BLOCKED_POINT'), true);
    assert.equal(isLifecycleState('PROJECT_COMPLETE'), true);

    assert.equal(isLifecycleState('UNKNOWN_STATE'), false);
    assert.equal(isLifecycleState(''), false);
    assert.equal(isLifecycleState(null), false);
    assert.equal(isLifecycleState(123), false);
    assert.equal(isLifecycleState({}), false);
  });

  it('should define and validate nested TaskLoopState states', () => {
    assert.equal(TaskLoopState.TASK_SELECTION, 'TASK_SELECTION');
    assert.equal(TaskLoopState.CHATGPT_REVIEW, 'CHATGPT_REVIEW');
    assert.equal(TaskLoopState.ACCEPT, 'ACCEPT');
    assert.equal(TaskLoopState.REJECT, 'REJECT');

    assert.equal(isTaskLoopState('TASK_SELECTION'), true);
    assert.equal(isTaskLoopState('CHATGPT_REVIEW'), true);
    assert.equal(isTaskLoopState('NON_EXISTENT_STATE'), false);
    assert.ok(TASK_LOOP_STATES.length > 10);
  });
});
