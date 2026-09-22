import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LifecycleState,
  TaskLoopState,
  StateMachine,
  TaskLoopStateMachine,
  VALID_LIFECYCLE_TRANSITIONS,
  VALID_TASK_LOOP_TRANSITIONS,
  InvalidStateTransitionError,
  AidmError,
  type BlockedStateData,
  type StateTransitionEvent,
} from '../dist/index.js';

describe('Authoritative Deterministic FSM Engine (TASK-P1-02)', () => {
  describe('Initial State and Prohibitions', () => {
    it('1. should allow INITIALIZING -> REQUIREMENTS_INGESTION (PASS)', () => {
      const fsm = new StateMachine();
      assert.equal(fsm.getState(), LifecycleState.INITIALIZING);

      fsm.transitionTo(LifecycleState.REQUIREMENTS_INGESTION);
      assert.equal(fsm.getState(), LifecycleState.REQUIREMENTS_INGESTION);
    });

    it('2. should reject INITIALIZING -> TASK_LOOP (FAIL)', () => {
      const fsm = new StateMachine();
      assert.throws(
        () => fsm.transitionTo(LifecycleState.TASK_LOOP),
        (err: unknown) => {
          assert.ok(err instanceof InvalidStateTransitionError);
          assert.equal(err.code, 'ERR_INVALID_STATE_TRANSITION');
          assert.equal(err.fromState, LifecycleState.INITIALIZING);
          assert.equal(err.toState, LifecycleState.TASK_LOOP);
          return true;
        }
      );
    });

    it('should reject INITIALIZING -> BLOCKED_ON_HUMAN (FAIL)', () => {
      const fsm = new StateMachine();
      assert.throws(
        () => fsm.transitionTo(LifecycleState.BLOCKED_ON_HUMAN),
        (err: unknown) => {
          assert.ok(err instanceof InvalidStateTransitionError);
          assert.equal(err.code, 'ERR_INVALID_STATE_TRANSITION');
          assert.equal(err.fromState, LifecycleState.INITIALIZING);
          assert.equal(err.toState, LifecycleState.BLOCKED_ON_HUMAN);
          return true;
        }
      );
    });
  });

  describe('Authoritative Lifecycle Progression', () => {
    it('3. should allow REQUIREMENTS_INGESTION -> ARCHITECTURE_SPEC (PASS)', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.REQUIREMENTS_INGESTION });
      fsm.transitionTo(LifecycleState.ARCHITECTURE_SPEC);
      assert.equal(fsm.getState(), LifecycleState.ARCHITECTURE_SPEC);
    });

    it('4. should allow ARCHITECTURE_SPEC -> TASK_DECOMPOSITION (PASS)', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.ARCHITECTURE_SPEC });
      fsm.transitionTo(LifecycleState.TASK_DECOMPOSITION);
      assert.equal(fsm.getState(), LifecycleState.TASK_DECOMPOSITION);
    });

    it('5. should allow TASK_DECOMPOSITION -> TASK_SELECTION (PASS)', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.TASK_DECOMPOSITION });
      fsm.transitionTo(LifecycleState.TASK_SELECTION);
      assert.equal(fsm.getState(), LifecycleState.TASK_SELECTION);
    });

    it('6. should allow TASK_SELECTION -> TASK_LOOP (PASS)', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.TASK_SELECTION });
      fsm.transitionTo(LifecycleState.TASK_LOOP);
      assert.equal(fsm.getState(), LifecycleState.TASK_LOOP);
    });

    it('should execute the full end-to-end authoritatively ordered lifecycle progression', () => {
      const fsm = new StateMachine(); // INITIALIZING
      fsm.transitionTo(LifecycleState.REQUIREMENTS_INGESTION);
      fsm.transitionTo(LifecycleState.ARCHITECTURE_SPEC);
      fsm.transitionTo(LifecycleState.TASK_DECOMPOSITION);
      fsm.transitionTo(LifecycleState.TASK_SELECTION);
      fsm.transitionTo(LifecycleState.TASK_LOOP);

      // Self-iteration within TASK_LOOP
      fsm.transitionTo(LifecycleState.TASK_LOOP);
      assert.equal(fsm.getState(), LifecycleState.TASK_LOOP);

      // Complete
      fsm.transitionTo(LifecycleState.PROJECT_COMPLETE);
      assert.equal(fsm.getState(), LifecycleState.PROJECT_COMPLETE);
    });
  });

  describe('Strict BLOCKED_ON_HUMAN and RESUME_EXACT_BLOCKED_POINT Constraints', () => {
    it('7. should reject BLOCKED_ON_HUMAN -> REQUIREMENTS_INGESTION (FAIL)', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.BLOCKED_ON_HUMAN });
      assert.throws(
        () => fsm.transitionTo(LifecycleState.REQUIREMENTS_INGESTION),
        (err: unknown) => {
          assert.ok(err instanceof InvalidStateTransitionError);
          assert.equal(err.code, 'ERR_INVALID_STATE_TRANSITION');
          assert.equal(err.fromState, LifecycleState.BLOCKED_ON_HUMAN);
          assert.equal(err.toState, LifecycleState.REQUIREMENTS_INGESTION);
          return true;
        }
      );
    });

    it('8. should reject BLOCKED_ON_HUMAN -> ARCHITECTURE_SPEC (FAIL)', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.BLOCKED_ON_HUMAN });
      assert.throws(
        () => fsm.transitionTo(LifecycleState.ARCHITECTURE_SPEC),
        (err: unknown) => {
          assert.ok(err instanceof InvalidStateTransitionError);
          assert.equal(err.code, 'ERR_INVALID_STATE_TRANSITION');
          assert.equal(err.fromState, LifecycleState.BLOCKED_ON_HUMAN);
          assert.equal(err.toState, LifecycleState.ARCHITECTURE_SPEC);
          return true;
        }
      );
    });

    it('9. should reject BLOCKED_ON_HUMAN -> new task selection (FAIL)', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.BLOCKED_ON_HUMAN });
      assert.throws(
        () => fsm.transitionTo(LifecycleState.TASK_SELECTION),
        (err: unknown) => {
          assert.ok(err instanceof InvalidStateTransitionError);
          assert.equal(err.code, 'ERR_INVALID_STATE_TRANSITION');
          assert.equal(err.fromState, LifecycleState.BLOCKED_ON_HUMAN);
          assert.equal(err.toState, LifecycleState.TASK_SELECTION);
          return true;
        }
      );
    });

    it('10-13. should allow BLOCKED_ON_HUMAN -> RESUME_EXACT_BLOCKED_POINT preserving exact task ID, iteration, and context (PASS)', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.TASK_LOOP });

      const blockedData: BlockedStateData = {
        blockedTaskId: 'AUTH-042',
        blockedIteration: 3,
        blockedContextReference: 'sha256-ctx-auth-v3',
        blockingReason: 'CRITICAL_OPERATION: Production DB mutation requiring human sign-off',
        resumePoint: 'INSTRUCT_ANTIGRAVITY',
      };

      // Enter BLOCKED_ON_HUMAN
      fsm.blockOnHuman(blockedData, { alert: 'Human confirmation needed' });
      assert.equal(fsm.getState(), LifecycleState.BLOCKED_ON_HUMAN);
      assert.deepEqual(fsm.getBlockedState(), {
        ...blockedData,
        timestamp: fsm.getBlockedState()?.timestamp,
      });

      // 10. Resume strictly to RESUME_EXACT_BLOCKED_POINT
      const resumeEvent = fsm.resumeFromHuman('User approved mutation');
      assert.equal(fsm.getState(), LifecycleState.RESUME_EXACT_BLOCKED_POINT);
      assert.equal(resumeEvent.fromState, LifecycleState.BLOCKED_ON_HUMAN);
      assert.equal(resumeEvent.toState, LifecycleState.RESUME_EXACT_BLOCKED_POINT);

      // 11. Exact task ID is preserved
      const payload = resumeEvent.payload as {
        userResponse: string;
        resumedBlockedState: BlockedStateData;
      };
      assert.equal(payload.resumedBlockedState.blockedTaskId, 'AUTH-042');

      // 12. Exact iteration is preserved
      assert.equal(payload.resumedBlockedState.blockedIteration, 3);

      // 13. Exact context reference is preserved
      assert.equal(payload.resumedBlockedState.blockedContextReference, 'sha256-ctx-auth-v3');
      assert.equal(payload.resumedBlockedState.resumePoint, 'INSTRUCT_ANTIGRAVITY');
      assert.equal(payload.userResponse, 'User approved mutation');

      // Transition from RESUME_EXACT_BLOCKED_POINT into TASK_LOOP
      const taskLoopEvent = fsm.transitionTo(LifecycleState.TASK_LOOP);
      assert.equal(fsm.getState(), LifecycleState.TASK_LOOP);
      assert.equal(taskLoopEvent.fromState, LifecycleState.RESUME_EXACT_BLOCKED_POINT);
      assert.equal(taskLoopEvent.toState, LifecycleState.TASK_LOOP);
      assert.equal(taskLoopEvent.blockedState?.blockedTaskId, 'AUTH-042');
    });
  });

  describe('Terminal State, Listeners, and Error Validation', () => {
    it('14. should reject any transition out of PROJECT_COMPLETE (FAIL)', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.PROJECT_COMPLETE });

      const allStates = Object.values(LifecycleState);
      for (const targetState of allStates) {
        assert.throws(
          () => fsm.transitionTo(targetState),
          (err: unknown) => {
            assert.ok(err instanceof InvalidStateTransitionError);
            assert.equal(err.code, 'ERR_INVALID_STATE_TRANSITION');
            assert.equal(err.fromState, LifecycleState.PROJECT_COMPLETE);
            return true;
          }
        );
      }
    });

    it('15. should invoke listeners in deterministic registration order', () => {
      const fsm = new StateMachine();
      const callLog: string[] = [];

      fsm.subscribe(() => callLog.push('first'));
      fsm.subscribe(() => callLog.push('second'));
      fsm.subscribe(() => callLog.push('third'));

      fsm.transitionTo(LifecycleState.REQUIREMENTS_INGESTION);
      assert.deepEqual(callLog, ['first', 'second', 'third']);
    });

    it('16. should throw InvalidStateTransitionError with correct error hierarchy and details', () => {
      const fsm = new StateMachine({ initialState: LifecycleState.TASK_DECOMPOSITION });

      assert.throws(
        () => fsm.transitionTo(LifecycleState.PROJECT_COMPLETE),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err instanceof AidmError);
          assert.ok(err instanceof InvalidStateTransitionError);
          assert.equal(err.code, 'ERR_INVALID_STATE_TRANSITION');
          assert.equal(err.name, 'InvalidStateTransitionError');
          assert.equal(err.fromState, LifecycleState.TASK_DECOMPOSITION);
          assert.equal(err.toState, LifecycleState.PROJECT_COMPLETE);
          return true;
        }
      );
    });
  });

  describe('Nested TaskLoopStateMachine Process Validation', () => {
    it('should follow the nested process within TASK_LOOP correctly', () => {
      const loopFsm = new TaskLoopStateMachine();
      assert.equal(loopFsm.getState(), TaskLoopState.TASK_SELECTION);

      loopFsm.transitionTo(TaskLoopState.PRE_FLIGHT_CHECKPOINT);
      loopFsm.transitionTo(TaskLoopState.INSTRUCT_ANTIGRAVITY);
      loopFsm.transitionTo(TaskLoopState.IMPLEMENTATION);
      loopFsm.transitionTo(TaskLoopState.EVIDENCE_COLLECTION);
      loopFsm.transitionTo(TaskLoopState.ORCHESTRATOR_EVIDENCE_VALIDATION);
      loopFsm.transitionTo(TaskLoopState.CHATGPT_REVIEW);
      loopFsm.transitionTo(TaskLoopState.ANALYZE_EVIDENCE);
      loopFsm.transitionTo(TaskLoopState.ACCEPT);
      loopFsm.transitionTo(TaskLoopState.POST_FLIGHT_COMMIT);
      loopFsm.transitionTo(TaskLoopState.CHECK_DAG_COMPLETION);

      assert.equal(loopFsm.getState(), TaskLoopState.CHECK_DAG_COMPLETION);
    });

    it('should handle rejection and retry flow inside TaskLoop', () => {
      const loopFsm = new TaskLoopStateMachine(TaskLoopState.ANALYZE_EVIDENCE);
      loopFsm.transitionTo(TaskLoopState.REJECT);
      loopFsm.transitionTo(TaskLoopState.ROOT_CAUSE_ANALYSIS);
      loopFsm.transitionTo(TaskLoopState.RETRY_STRATEGY_CHECK);
      loopFsm.transitionTo(TaskLoopState.INSTRUCT_ANTIGRAVITY);

      assert.equal(loopFsm.getState(), TaskLoopState.INSTRUCT_ANTIGRAVITY);
    });
  });
});
