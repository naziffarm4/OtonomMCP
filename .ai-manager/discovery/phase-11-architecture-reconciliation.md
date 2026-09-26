# PHASE_11_ARCHITECTURE_RECONCILIATION

## 1. VERIFIED_REPOSITORY_FACTS
- **FACT** `DurableStateManager` exists in `packages/core/src/storage/durable-state.ts` and is the sole durable lifecycle state authority.
- **FACT** `TaskDagEngine` exists in `packages/core/src/task-engine/dag-engine.ts` and is the only DAG authority.
- **FACT** `HistoryManager` exists in `packages/core/src/storage/history-manager.ts` and enforces append‑only audit logs.
- **FACT** `ApprovalStore` / `HumanApprovalEngine` are defined under `packages/core/src/approval/*` and provide the only human‑approval authority.
- **FACT** The P10 execution boundary chain (DirectorDecision → ExecutionIntent → ExecutionRequest → ExecutorGuard → AntigravityAdapter → RawExecutorOutcome → SystemEvidence → QA → ACCEPT/REJECT/BLOCK → state integration) is implemented in the following files:
  - `packages/core/src/director/director-session.ts`
  - `packages/core/src/director/director-decision.ts`
  - `packages/core/src/executor-bridge/antigravity-adapter.ts`
  - `packages/core/src/executor-bridge/executor-guard.ts`
  - `packages/core/src/execution/integration-service.ts`
- **FACT** `AutonomousLifecycleHarness` (`packages/core/src/harness/autonomous-lifecycle-harness.ts`) is **present** but its constructor is never used by the Director or any runtime entry point.
- **FACT** `TaskLoopStateMachine` (`packages/core/src/fsm/state-machine.ts`) is used only inside `AutonomousLifecycleHarness`.
- **FACT** No code imports `AutonomousLifecycleHarness` outside its own module; the main application entry (`src/index.ts`/CLI) creates a `DirectorSession` and calls `run()` on it, never instantiating the harness.

## 2. EXISTING_EXECUTION_PATH
**CALL/DEPENDENCY FLOW** (simplified):
1. **User / Product Owner** creates a **Project** and a **Requirement** (locked).
2. `DirectorSession` loads the durable state via `DurableStateManager`.
3. `DirectorSession` invokes `DirectorDecision` which selects the next ready task using `TaskDagEngine` (topological order and readiness checks).
4. `DirectorDecision` builds an **ExecutionIntent** and an **ExecutionRequest**.
5. `ExecutorGuard` validates the request against `PolicyEngine`.
6. `AntigravityAdapter` translates the request and calls the Antigravity CLI.
7. The CLI returns a `RawExecutorOutcome`.
8. `ExecutionQaBridge` collects `SystemVerifiedEvidence` and runs `qa-review-engine`.
9. Based on the review, the system records **ACCEPT**, **REJECT**, or **BLOCK** and updates `DurableStateManager` and `HistoryManager` via `ExecutionIntegrationService`.
10. The loop returns to step 3 for the next ready task.

**Who does what today?**
- **Task selection:** `DirectorDecision` (via `TaskDagEngine`).
- **Authorization:** `PolicyEngine` (via `ExecutorGuard`) and final human approval via `HumanApprovalEngine` when a task is marked **CRITICAL**.
- **Start execution:** `AntigravityAdapter` (called by `ExecutorGuard`).
- **Verification:** `ExecutionQaBridge` + `qa-review-engine`.
- **Result integration:** `ExecutionIntegrationService` updates `DurableStateManager` and `HistoryManager`.
- **Continuation decision:** After integration, `DirectorDecision` is consulted again; there is **no** automatic harness‑driven next‑task start.
- **Director invocation:** Yes, between every accepted task.
- **AutonomousLifecycleHarness involvement:** **None** in the current P9/P10 path.
- **Number of execution loops:** **One** – the Director‑driven loop.

## 3. AUTONOMOUS_HARNESS_RELATIONSHIP
- The harness imports its own `TaskDagEngine`, `TaskLoopStateMachine`, and policy/evidence components, but **no other module imports** it.
- Tests (`packages/core/tests/autonomous-harness.test.ts`) instantiate it in isolation for historic Phase‑1‑7 simulations.
- No registration in MCP or entry‑point scripts.
- **Conclusion (B):** It is a **legacy autonomous execution path** (Phase 1‑7) **not integrated** with the newer Director/ExecutionIntent architecture.

## 4. DIRECTOR_P9_P10_RELATIONSHIP
- Director owns the task DAG, durable state, and invokes the execution boundary.
- All authority invariants (1‑10) are satisfied by the current code.
- The P10 boundary remains authoritative; no second FSM/DAG/History store is introduced.

## 5. AUTHORIZATION_ANALYSIS
- **ApprovalPackage** stores a single human approval token per **Project/Requirement** (not per task). It is referenced by `HumanApprovalEngine.isDevelopmentAuthorized()` which checks that the token is still valid for the current session.
- The token **does not expire** until the project is completed or the user revokes it.
- **FACT** Multiple sequential tasks can be executed under one still‑valid approval token because each task authorisation checks the same token.
- **GAP:** None – the current model already supports sequential task execution without per‑task tokens.

## 6. ITERATION_ID_ANALYSIS
- Existing identifiers (`projectId`, `taskId`, `taskRevision`, `requestId`, `evidenceId`) already provide full traceability for each execution attempt.
- **INFERENCE** An additional `iterationId` would be redundant unless cross‑task rollback required, which is not present today.
- **CONCLUSION:** No architectural need for a separate iteration identifier.

## 7. TASK_CONTINUATION_ANALYSIS
- After a task is **ACCEPTED** and state is integrated, **DirectorDecision** is invoked again to select the next ready task.
- **Result:** **A** – the system automatically starts the next task via the Director; the harness plays no role.
- There is **no** built‑in pre‑computed harness loop that continues tasks.

## 8. RECOVERY_ANALYSIS
- `RecoveryIntegrator` is used only inside `AutonomousLifecycleHarness` for restart/retry strategies.
- The P9/P10 path relies on **PolicyEngine** to block unsafe actions; failures result in **REJECT** and the Director may re‑select a different task, but no automatic rollback of previous tasks.
- **FACT** Cross‑task recovery is **not** currently implemented.

## 9. MCP_ANALYSIS
- MCP (Micro‑Control‑Protocol) registers tools for **approval**, **execution‑intent**, **history‑query**, etc.
- No MCP endpoint calls `AutonomousLifecycleHarness`; only the Director‑related services are exposed.
- **FACT** No MCP loop‑control APIs (pause/resume, iterationId) exist.

## 10. AUTHORITY_MODEL
| Component | Authority | Current Role |
|-----------|-----------|--------------|
| User / Product Owner | Final human approval | Issues `ApprovalPackage` token |
| Director (Session/Decision) | Task selection & overall flow | Chooses next task, builds intents |
| AIDM / Orchestrator | State persistence, DAG, history, policy | `DurableStateManager`, `TaskDagEngine`, `HistoryManager`, `PolicyEngine` |
| AntigravityAdapter | Execution executor | Runs concrete task implementation |
| AutonomousLifecycleHarness | **Legacy** only – not used in production |

## 11. ARCHITECTURAL_CONFLICTS_FOUND
- **CONFLICT** The discovery report suggested adding an `iterationId` and new harness‑based loop, which would violate invariants #6‑#10 (no second DAG, FSM, or history).
- **CONFLICT** Proposals to pause/resume loops introduce a second execution control path, conflicting with the single Director‑driven loop.

## 12. PHASE_11_ACTUAL_PROBLEM
- The repository **lacks** a formal definition of a **Phase 11 boundary** that governs how the system should behave after a task is accepted (e.g., automatic continuation, graceful pausing, or manual checkpoint).
- There is **no** explicit mechanism to signal “end of autonomous iteration” or to expose a higher‑level loop‑control API to the user.

## 13. PHASE_11_PROPOSED_BOUNDARY
| Aspect | Definition (based on repo) |
|--------|----------------------------|
| **PURPOSE** | Provide a **controlled continuation point** after each task, allowing optional human review before proceeding to the next task. |
| **PROBLEM** | Lack of an explicit pause/continue checkpoint and no user‑visible way to intervene between tasks without breaking the Director loop. |
| **NON_GOALS** | Introducing a second FSM/DAG, new history store, or per‑task approval tokens. |
| **AUTHORITY_MODEL** | Same as current: User → Director → AIDM → Antigravity. Phase 11 adds a **Phase11Controller** that can optionally request human approval before the Director proceeds. |
| **STATE_MODEL** | Reuse `DurableStateManager`; add a new **phase11State** field (`WAITING_FOR_HUMAN`, `AUTONOMOUS_CONTINUE`). |
| **EXECUTION_MODEL** | Director selects next task; Phase11Controller can pause the loop awaiting explicit user command via MCP. |
| **RECOVERY_MODEL** | No change; existing recovery remains. |
| **MCP_BOUNDARY** | New MCP method `phase11.requestContinue` that returns `allowed: boolean`. |
| **BINDING_MODEL** | Bind `requestId` of the continuation request to the current `projectId` and `taskId`. |
| **TEST_STRATEGY** | Unit tests for Phase11Controller pause/continue, integration test that Director respects the pause, end‑to‑end simulation of user‑initiated continue. |

## 14. P11-01_RECOMMENDATION
- **Option B** is the most appropriate: *“Integrate existing Director decision flow with a controlled multi‑task continuation point.”* This means: create a **Phase11Controller** (specification only) that can be invoked via MCP to pause after each ACCEPT and wait for an explicit “continue” command before the Director selects the next task.
- No code changes are made now; only the specification is recorded.

## 15. FUTURE_TASK_BREAKDOWN
| ID | Description |
|----|-------------|
| P11-01 | Draft specification for `Phase11Controller` (pause/continue API) and update MCP README. |
| P11-02 | Extend `DurableStateManager` schema with `phase11State` (enum). |
| P11-03 | Modify `DirectorSession` to check `phase11State` after each ACCEPT and emit a pause event. |
| P11-04 | Implement MCP tool `phase11.requestContinue` (design only). |
| P11-05 | Write integration tests verifying Director respects pause and continues on user command. |

## 16. EXPLICITLY_REJECTED_PROPOSALS
- Introducing **iterationId** fields.
- Adding **per‑task humanApprovalToken**.
- Creating a second **FSM** or **DAG**.
- Implementing **pauseLoop / resumeLoop** commands inside the autonomous harness.
- Adding **cross‑task rollback** or **dynamic DAG mutation**.
- Any new MCP loop‑control API beyond the Phase11Controller request.

## 17. OPEN_DECISIONS
- Whether the Phase11 pause should be optional (configurable) or always enforced.
- The exact enum values for `phase11State` (e.g., `AUTONOMOUS`, `WAITING_FOR_HUMAN`).
- How long a pause may last before timing out (if at all).

## 18. REQUIRED_ACCEPTANCE_TESTS
- **Unit**: `Phase11Controller` returns correct state transitions.
- **Integration**: Director respects pause after an ACCEPT and resumes only after MCP `phase11.requestContinue`.
- **End‑to‑End**: Simulate a full task DAG with two tasks; verify human intervene between them.

---

**PHASE_11_RECONCILIATION_STATUS**
- FILE_CREATED: `true`
- WORKTREE_CHANGED: `false`
- HEAD: *(unchanged)*
- REMOTE_MAIN: *(unchanged)*
- PRODUCTION_FILES_CHANGED: `0`
- TEST_FILES_CHANGED: `0`
- COMMIT_CREATED: `false`
- PUSH_PERFORMED: `false`
