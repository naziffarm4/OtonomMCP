# Phase 11 Boundary Specification & Architecture Synchronization

> **Status:** AUTHORITATIVE ARCHITECTURE SPECIFICATION
> **Phase:** Phase 11 — Controlled Continuation & End-to-End Scope Chain
> **Accepted Baseline:** `e11049a0eca539bfe5bc805fd87319805792b728`
> **Reference Subtasks:** P11-01, P11-02, P11-03-A, P11-03-B, P11-03-C, P11-03-D, P11-05, P11-04

---

## 1. Executive Summary & Purpose

Phase 11 defines and hardens the **controlled continuation boundary** and the **end-to-end task scope chain** within the AIDM orchestration architecture. It enables sequential multi-task execution governed strictly by human Product Owner policy without introducing autonomous run-away loops, without creating shadow state engines or secondary DAGs, and without permitting unauthorized executor escapes beyond bounded scopes.

The implementation strictly maintains existing ownership invariants:
- **USER / PRODUCT OWNER:** Sole human authority for development approval and execution continuation checkpoints.
- **CHATGPT / DIRECTOR:** Architectural planning, task selection, and structured intent formulation; never executes code, never grants self-approval, never bypasses continuation gates.
- **AIDM (Orchestrator):** Authoritative state FSM (`DurableStateManager`), task DAG (`TaskDagEngine`), immutable specifications (`SpecStore`), audit logging (`HistoryManager`), and policy governance (`HumanApprovalEngine`, `PolicyEngine`).
- **ANTIGRAVITY (Executor):** Implementation executor boundary; receives isolated `ExecutionRequest` payloads via `AntigravityAdapter` and produces `RawExecutorOutcome`; never creates tasks, never mutates state, never self-verifies.
- **SYSTEM EVIDENCE VERIFICATION & STATE INTEGRATION:** Independent post-execution collection (`SystemExecutionEvidence`), objective QA criteria evaluation (`ExecutionQaBridge`), and atomic state integration (`ExecutionStateIntegrator`).

---

## 2. Phase 11 Scope & Subtask Matrix

The Phase 11 implementation encompasses the following authoritative milestones:

| Subtask | Scope & Description | Status | Authoritative Commit | Key Test Suites / Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **P11-01** | **Continuation Boundary Definition**: Architectural specification of continuation checkpoints, eliminating secondary loop proposals. | **ACCEPTED** | `e7d9f8c` | `.ai-manager/discovery/phase-11-boundary-spec.md` |
| **P11-02** | **Controlled Continuation Implementation**: Addition of `continuationState` and `continuationPolicy` to `DurableState`, `ExecutionStateIntegrator` checkpointing, `HumanApprovalEngine` authorization, MCP tool `phase11.requestContinue`, and `DirectorDecisionEngine` gating. | **ACCEPTED** | `d6989f5` | `packages/core/tests/phase11-continuation-boundary.test.ts` (46/46 PASS) |
| **P11-03-A** | **Adaptive Targeted Analysis Policy**: Formulated 5-point targeted code analysis policy avoiding full-repository scanning loops. | **ACCEPTED** | `d85f93b` | Integrated into `AntigravityAdapter` prompt generation |
| **P11-03-B** | **Task Scope Contract**: Contract extensions adding `analysisScope` and `implementationScope` to `ExecutionInstruction` / `ExecutionRequest` with path normalization, traversal rejection, and deterministic SHA-256 ID derivation. | **ACCEPTED** | `1d9f2b3` | `packages/core/tests/execution-request-contract.test.ts` (T58–T67 PASS) |
| **P11-03-C** | **Post-Execution Scope Verification**: Verification engine extension enforcing that repository changes observed in Git working tree strictly adhere to `implementationScope` (exact matches, directory boundaries, renames, deletions). | **ACCEPTED** | `e7aef39` | `packages/core/tests/system-evidence-pipeline.test.ts` (C01–C20 PASS) |
| **P11-03-D** | **Scope Propagation to Antigravity**: Adapter prompt bridge exposing `ANALYSIS SCOPE`, `IMPLEMENTATION SCOPE`, and `TARGET FILES` distinctly in the structured prompt provided to Antigravity CLI. | **ACCEPTED** | `1540e8f` | `packages/core/tests/execution-request-contract.test.ts` (D01–D14 PASS) |
| **P11-05** | **Multi-Task Continuation Integration & Hardening**: End-to-end multi-task sequential chaining (`A -> B -> C`), restart/recovery resilience, cross-project/session isolation, and zero autonomous bypass verification. | **ACCEPTED** | `e11049a` | `packages/core/tests/phase11-e2e-continuation.test.ts` (10/10 PASS) |
| **P11-04** | **Documentation & Architectural Spec Sync**: Synchronizing all authoritative architecture documents, diagrams, and invariants with the exact repository implementation. | **ACCEPTED** | *(current)* | Full documentation synchronization |

---

## 3. End-to-End Architectural Flow Diagram

The complete end-to-end execution lifecycle and continuation boundary operates through the following deterministic sequence:

```mermaid
sequenceDiagram
    autonumber
    actor PO as Product Owner (Human)
    participant D as Director (ChatGPT Session)
    participant DE as DirectorDecisionEngine
    participant TD as TaskDagEngine
    participant HA as HumanApprovalEngine
    participant EI as ExecutionRequestBuilder
    participant AA as AntigravityAdapter
    participant EV as SystemEvidenceCollector
    participant QA as ExecutionQaBridge
    participant SI as ExecutionStateIntegrator
    participant DS as DurableStateManager
    participant MCP as MCP Tool (phase11.requestContinue)
    participant HM as HistoryManager

    Note over PO,HM: 1. TASK SELECTION & DECISION FORMULATION
    PO->>D: Interacts via Director Session
    D->>DE: createDecision(IMPLEMENT_TASK)
    DE->>DS: Check continuationState
    Note right of DE: Must be 'NONE'; if 'WAITING', throws CONTINUATION_WAITING
    DE->>TD: Validate Task DAG & Kahn Topological Order
    DE-->>D: Authorized Director Decision (TASK-A)

    Note over D,AA: 2. CONTRACT FORMULATION & EXECUTOR INVOCATION
    D->>EI: buildExecutionRequest(Decision, Intent)
    EI->>EI: Validate targetFiles, analysisScope, implementationScope
    EI->>EI: Compute deterministic SHA-256 requestId
    EI-->>AA: Immutable ExecutionRequest
    AA->>AA: translateExecutionRequest (Target Files, Analysis Scope, Impl Scope, Analysis Policy)
    AA->>AA: Invoke Antigravity CLI (/home/codespace/.local/bin/agy)
    AA-->>EV: RawExecutorOutcome (stdout, stderr, exitCode, duration)

    Note over EV,QA: 3. INDEPENDENT VERIFICATION & QA EVALUATION
    EV->>EV: Validate RequestBinding (taskId, revision, fingerprint, projectId)
    EV->>EV: Inspect Git working tree independently (GitPort)
    EV->>EV: Validate Path Safety (no traversal, no absolute paths)
    EV->>EV: Verify CHECK_IMPLEMENTATION_SCOPE (changes within allowed scope)
    EV->>EV: Execute independent test/build verification commands
    EV->>QA: evaluate(SystemVerifiedEvidence)
    QA-->>SI: VerificationDecision: ACCEPT

    Note over SI,DS: 4. DURABLE STATE INTEGRATION & CHECKPOINT CREATION
    SI->>DS: recordTaskCompletion(TASK-A) -> completedTaskIds updated
    SI->>DS: Evaluate continuationPolicy (MANUAL)
    SI->>DS: Set continuationState = 'WAITING' (Atomic JSON write)
    SI->>HM: Append PHASE11_CONTINUATION_WAITING event
    SI-->>D: Integration Result: ACCEPTED (continuationState: WAITING)

    Note over DE,PO: 5. DIRECTOR BLOCKED AT CONTINUATION GATE
    D->>DE: createDecision(TASK-B)
    DE->>DS: Check continuationState
    DS-->>DE: continuationState === 'WAITING'
    DE-->>D: BLOCKED (Error: CONTINUATION_WAITING / DirectorInvalidTransitionError)
    Note over D: Director is strictly unable to proceed autonomously

    Note over PO,DE: 6. HUMAN CONTINUATION & NEXT TASK RELEASE
    PO->>MCP: phase11.requestContinue(directorSessionId, contextFingerprint, actorRole: PRODUCT_OWNER)
    MCP->>HA: validateContinuationRequest()
    HA->>HA: Verify human role (PRODUCT_OWNER / USER), project binding, non-stale snapshot
    MCP->>DS: Transition continuationState: WAITING -> NONE
    MCP->>HM: Append PHASE11_CONTINUATION_REQUESTED & PHASE11_CONTINUATION_ACCEPTED
    MCP-->>PO: Success (continuationState: NONE, completedTaskIds unchanged)

    Note over D,TD: 7. DIRECTOR PROCEEDS TO NEXT READY TASK
    D->>DE: createDecision(TASK-B)
    DE->>DS: Check continuationState -> NONE
    DE->>TD: Check TASK-B dependencies in DAG -> All Met (Ready)
    DE-->>D: Decision Created for TASK-B (Topological sequence maintained)
```

---

## 4. Controlled Continuation Architecture

### 4.1 Durable State Representation
The continuation state is persisted as part of the authoritative, atomic `DurableState` JSON document managed by [`DurableStateManager`](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/storage/durable-state.ts):

```typescript
export type ContinuationState = 'NONE' | 'WAITING';
export type ContinuationPolicy = 'AUTONOMOUS' | 'MANUAL';

export interface DurableState {
  readonly schemaVersion: number;
  readonly currentLifecycleState: LifecycleState;
  readonly activeTaskId: string | null;
  readonly completedTaskIds: string[];
  readonly blockedState: BlockedState | null;
  readonly lastCheckpoint?: string | null;
  readonly continuationState: ContinuationState;     // 'NONE' | 'WAITING'
  readonly continuationPolicy: ContinuationPolicy;   // 'AUTONOMOUS' | 'MANUAL'
  readonly updatedAt: string;
  readonly metadata?: Record<string, unknown>;
}
```

### 4.2 Checkpoint Transition Logic
Continuation checkpoints are created post-integration inside [`ExecutionStateIntegrator`](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/execution-integration/execution-integration-service.ts):
1. **Verification Acceptance:** A task's independent execution evidence is verified with decision `ACCEPT`.
2. **Task Completion:** `completedTaskIds` is updated with the completed `taskId`, and `activeTaskId` is cleared.
3. **Policy Evaluation:**
   - Under `continuationPolicy: 'AUTONOMOUS'`: `continuationState` remains `'NONE'`. The Director may immediately formulate decisions for subsequent ready tasks.
   - Under `continuationPolicy: 'MANUAL'`: `continuationState` transitions to `'WAITING'`.
4. **Audit Logging:** An append-only `PHASE11_CONTINUATION_WAITING` event is written to `HistoryManager`.

### 4.3 Continuation Invariants
Continuation is purely a checkpoint gate and satisfies strict negative guarantees:
- **Does NOT complete a task:** Continuation only releases `continuationState` (`WAITING -> NONE`); it never mutates `completedTaskIds`.
- **Does NOT create evidence:** No `SystemExecutionEvidence` or QA evaluation is fabricated.
- **Does NOT create execution requests:** No `ExecutionIntent` or `ExecutionRequest` is constructed.
- **Does NOT invoke Antigravity:** Zero child processes or executor tools are dispatched.
- **Does NOT mutate DAG:** Task topology and status remain governed solely by `TaskDagEngine`.
- **Does NOT trigger autonomous retries:** Failures (`REJECT` or `BLOCK`) never create continuation checkpoints.

---

## 5. Authorization Boundary & Governance

Continuation authority is strictly decoupled from session identity and executor operations:

### 5.1 Authorized Human Roles
Under [`HumanApprovalEngine.validateContinuationRequest()`](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director/human-approval-engine.ts), continuation can **only** be authorized by human operators:
- `actorRole === 'PRODUCT_OWNER'`
- `actorRole === 'USER'`

### 5.2 Forbidden Actors & Explicit Rejection
Attempts by autonomous agents or non-human roles to authorize continuation are strictly rejected with error code `ACTOR_UNAUTHORIZED`:
- `DIRECTOR` (ChatGPT session identity)
- `EXECUTOR` / `ANTIGRAVITY`
- `SYSTEM`
- `ORCHESTRATOR`

### 5.3 Multi-Dimensional Binding Validation
A continuation request is rejected unless all cryptographic and contextual bindings match:
- **Project Binding (`PROJECT_BINDING_MISMATCH`):** The session and request must match the canonical workspace project identity (`package.json`).
- **Session Binding (`SESSION_INVALID` / `SESSION_NOT_ACTIVE`):** The referenced Director session must exist and be in `ACTIVE` state.
- **Context Fingerprint (`CONTEXT_FINGERPRINT_MISMATCH` / `CONTEXT_STALE`):** The request must be bound to the latest non-stale context snapshot logical fingerprint.
- **State Checkpoint (`CONTINUATION_NOT_WAITING`):** If `continuationState` is not `WAITING`, the request is rejected (or handled idempotently if already `NONE`).

---

## 6. Task DAG Orthogonality & Kahn Topological Sort

A fundamental architectural guarantee verified in Phase 11 is the **orthogonality between Task DAG readiness and continuation gating**:

```
┌───────────────────────────────────────────┐      ┌───────────────────────────────────────────┐
│              TaskDagEngine                │      │            DurableStateManager            │
│         (Structural DAG Authority)        │      │          (Continuation Checkpoint)        │
├───────────────────────────────────────────┤      ├───────────────────────────────────────────┤
│ TASK-1: COMPLETED                         │      │ continuationPolicy: 'MANUAL'              │
│ TASK-2: Dependencies (TASK-1) satisfied   │      │ continuationState:  'WAITING'             │
│                                           │      │                                           │
│ Result: TASK-2 is structurally READY      │      │ Result: Decision creation BLOCKED         │
└─────────────────────┬─────────────────────┘      └─────────────────────┬─────────────────────┘
                      │                                                  │
                      └────────────────────────┬─────────────────────────┘
                                               ▼
                              ┌──────────────────────────────────┐
                              │      DirectorDecisionEngine      │
                              ├──────────────────────────────────┤
                              │ validateDecision() checks:       │
                              │ 1. Is task ready in DAG? (YES)   │
                              │ 2. Is continuationState WAITING? │
                              │    -> YES: REJECT with           │
                              │       CONTINUATION_WAITING       │
                              └──────────────────────────────────┘
```

- `TaskDagEngine` remains the single source of truth for graph integrity, acyclicity, and dependency evaluation using Kahn's topological sort algorithm.
- Even when Task B is structurally ready in the DAG, `DirectorDecisionEngine` enforces `continuationState !== 'WAITING'`, ensuring that autonomous selection cannot occur until human approval is recorded.

---

## 7. Multi-Task Continuation Hardening (P11-05 Verified)

Phase 11 (P11-05) proves the correctness of sequential multi-task execution across consecutive tasks:

### 7.1 Verified Multi-Task Progression Chain
```
[TASK-A: READY]
      ↓ Director selects & implements
[TASK-A: ACCEPT]
      ↓ State integrated
[continuationState: WAITING] ────(Director BLOCKED from TASK-B)
      ↓ Human Product Owner: phase11.requestContinue
[continuationState: NONE]
      ↓ Director selects next ready task
[TASK-B: READY]
      ↓ Director selects & implements
[TASK-B: ACCEPT]
      ↓ State integrated
[continuationState: WAITING] ────(Director BLOCKED from TASK-C)
      ↓ Human Product Owner: phase11.requestContinue
[continuationState: NONE]
      ↓ Director selects next ready task
[TASK-C: READY]
      ↓ Director selects & implements
[TASK-C: ACCEPT]
      ↓ State integrated
[continuationState: WAITING]
```

### 7.2 Hardening Scenarios Verified
The test suite [`phase11-e2e-continuation.test.ts`](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/tests/phase11-e2e-continuation.test.ts) provides automated verification for all 10 required operational scenarios:
1. **Happy Path:** Task A `ACCEPT` -> `WAITING` -> Director blocked -> Human continuation -> `NONE` -> Task B selectable in Kahn order.
2. **Unauthorized Actor Rejection:** Calls by `DIRECTOR`, `SYSTEM`, or invalid roles fail with `ACTOR_UNAUTHORIZED`; `WAITING` state is strictly preserved.
3. **Task Integrity Preservation:** Requesting continuation releases the checkpoint boundary but does not modify `completedTaskIds`.
4. **DAG Readiness Independence:** Proves DAG readiness evaluation and continuation state gating are completely decoupled.
5. **Multi-Task Chaining (`A -> B -> C`):** Seamless sequential continuation across three consecutive tasks with topological sorting verified.
6. **Idempotent Duplicate Continuation:** Invoking continuation when state is already `NONE` returns `CONTINUATION_NOT_NEEDED` (`isIdempotent: true`) without state corruption.
7. **Cold Restart / Crash Recovery:** `WAITING` state survives process termination, restarts cleanly from disk, and maintains the Director block.
8. **Cross-Project Isolation:** Continuation requests with mismatched project identifiers are rejected (`PROJECT_BINDING_MISMATCH`).
9. **Session & Fingerprint Binding:** Non-existent sessions (`SESSION_INVALID`) and stale context fingerprints (`CONTEXT_FINGERPRINT_MISMATCH`) are rejected.
10. **Zero Autonomous Bypass:** Under `MANUAL` policy, state remains `WAITING` indefinitely; no background timer or automatic progression can bypass the gate.

---

## 8. End-to-End Scope Architecture (P11-03 Sync)

Phase 11 establishes a distinct three-tier scope contract:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 TASK SCOPE CONTRACT                                    │
├────────────────────────┬───────────────────────────────┬───────────────────────────────┤
│ Field Name             │ Authority / Purpose           │ Enforcement Mechanism         │
├────────────────────────┼───────────────────────────────┼───────────────────────────────┤
│ targetFiles            │ Legacy / Primary Files        │ Exact path match fallback     │
│                        │ Direct files targeted for edit│ when implementationScope is   │
│                        │ or inspection in the task.    │ undefined.                    │
├────────────────────────┼───────────────────────────────┼───────────────────────────────┤
│ analysisScope          │ Adaptive Targeted Analysis    │ Communicated in prompt to     │
│                        │ Permitted read/analysis zones │ Antigravity. Does NOT restrict│
│                        │ for code inspection.          │ Git working tree modifications│
│                        │                               │ if implementationScope differs│
├────────────────────────┼───────────────────────────────┼───────────────────────────────┤
│ implementationScope    │ Post-Execution Verification   │ Post-execution Git inspection │
│                        │ Bounded file/directory paths  │ (P10-04). Any change outside  │
│                        │ permitted to be modified.     │ this scope triggers FAIL and  │
│                        │                               │ verification decision REJECT. │
└────────────────────────┴───────────────────────────────┴───────────────────────────────┘
```

### 8.1 Adaptive Targeted Analysis Policy (P11-03-A)
Communicated to Antigravity to avoid unbounded exploration:
1. **Targeted Analysis:** Focus on relevant symbols and local behavior first; avoid sequential reading of entire codebases.
2. **Dependency & Flow Tracing:** Trace callers/callees only when necessary to understand contracts.
3. **Context Reuse:** Reuse findings for previously analyzed contracts without re-reading.
4. **Cycle Protection:** Halt traversal upon cycle detection; emit `ANALYSIS_LOOP_DETECTED` if blocked.
5. **Sufficient-Context Stop:** As soon as requirements and contracts are understood, stop reading and execute.

### 8.2 Scope Normalization & Traversal Protection (P11-03-B)
Both `analysisScope` and `implementationScope` are strictly sanitized:
- Backslashes converted to POSIX forward slashes (`/`).
- Trailing slashes trimmed; duplicate entries removed.
- Lexicographically sorted.
- Path traversal (`..`) and absolute paths are strictly rejected with `ExecutionRequestInvalidPathError`.
- Included in canonical SHA-256 calculation for deterministic `requestId` derivation.

### 8.3 Post-Execution Implementation Scope Enforcement (P11-03-C)
Inside [`ExecutionEvidenceCollector`](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/evidence/execution-evidence-collector.ts):
- Checks actual Git working-tree changes collected post-execution (`inspectState`).
- Evaluates whether every added, modified, deleted, or renamed file falls within `implementationScope`.
- Directory boundaries are strictly enforced (e.g. `packages/core/src` matches `packages/core/src/foo.ts` but does not match `packages/core/src_backup/foo.ts`).
- An empty array `implementationScope: []` signifies that **zero file modifications are permitted**; any observed change fails verification with `CHECK_IMPLEMENTATION_SCOPE FAIL` and final decision `REJECT`.

### 8.4 Scope Propagation into Structured Prompt (P11-03-D)
[`AntigravityAdapter.translateExecutionRequest()`](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/executor-bridge/antigravity-adapter.ts) formats scopes into distinct prompt sections:
- `TARGET FILES:`
- `ANALYSIS SCOPE:`
- `IMPLEMENTATION SCOPE:`
- `ADAPTIVE TARGETED ANALYSIS POLICY:`

---

## 9. Architectural Invariant Governance

The Phase 11 architecture preserves all core governance boundaries:

1. **No Second FSM:** `DurableStateManager` remains the sole lifecycle authority; no `Phase11Controller` or secondary FSM exists.
2. **No Second DAG:** `TaskDagEngine` remains the sole DAG authority.
3. **No Shadow Task Stores:** `SpecStore` and `DurableStateManager` remain the only persistent authorities.
4. **No Autonomous Loop:** Execution is strictly single-task dispatch followed by independent verification and continuation gating.
5. **No Autonomous Retry:** Verification rejections (`REJECT` or `BLOCK`) never automatically re-execute Antigravity.
6. **No Pre-Execution Interception / Git Snapshots:** Working tree inspection is performed post-execution by `GitPort` during P10-04 evidence collection.

---

## 10. Acceptance & Verification Summary

| Component | Status | Verification Result |
| :--- | :--- | :--- |
| P11-01 Boundary Spec | **ACCEPTED** | Documented & reconciled |
| P11-02 Controlled Continuation | **ACCEPTED** | 46 / 46 tests passing |
| P11-03-A Targeted Analysis | **ACCEPTED** | Verified in adapter prompt |
| P11-03-B Scope Contract | **ACCEPTED** | Verified in execution request contract |
| P11-03-C Scope Verification | **ACCEPTED** | 20 / 20 scope tests passing |
| P11-03-D Scope Propagation | **ACCEPTED** | 14 / 14 prompt propagation tests passing |
| P11-05 Multi-Task Hardening | **ACCEPTED** | 10 / 10 E2E integration tests passing |
| P11-04 Documentation Sync | **ACCEPTED** | Fully synchronized with implementation |
