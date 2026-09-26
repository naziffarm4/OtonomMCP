# Phase 11 Boundary Specification

## 1. Purpose
**Statement:** Define the authoritative boundary for Phase 11 that enables *controlled continuation* of the existing Director‑driven execution loop without introducing a second execution loop.  
5: **Classification:** FACT
6: 
7: ## 1. Execution Integration / Director
8: **Statement:** `ExecutionIntegrationService` only integrates verified execution results into durable state, history, and DAG authorities. It does **not** invoke `DirectorDecision` nor depend on `DirectorDecisionEngine`. It cannot call `DirectorDecision` directly on a continuation request.
9: **Classification:** FACT
10: 
11: ## 2. Scope
**Statement:** The specification covers continuation‑checkpoint handling, minimal durable‑state extensions, MCP contract for continuation, and crash‑recovery semantics. It *excludes* any modifications to task selection, DAG mutation, approval flow, or introduction of a second FSM/DAG/history authority.  
**Classification:** FACT

## 3. Non‑Goals
- Introduce a new decision authority (Phase11Controller must remain non‑authoritative).  
- Add `iterationId`, `loopId` or any per‑task human‑approval token.  
- Create a second FSM, DAG, or History store.  
- Implement dynamic DAG mutation, cross‑task rollback, or task injection.  
**Classification:** FACT

## 4. Existing Architecture Reused
- **DirectorSession / DirectorDecision** – selects the next ready task.  
- **DurableStateManager** – sole source of truth for lifecycle state.  
- **TaskDagEngine** – sole authority for DAG validation.  
- **HistoryManager** – append‑only audit log.  
- **HumanApprovalEngine / ApprovalStore** – retains current development‑time approval semantics.  
**Classification:** FACT

## 5. Authority Model
| Actor                | Authority                                                                                 | Classification |
|----------------------|-------------------------------------------------------------------------------------------|----------------|
| Product Owner        | Final human authority; may approve continuation checkpoints.                              | FACT |
| Director             | Decides *when* to continue, invokes `DirectorDecision`, but never bypasses policy.       | FACT |
| AIDM (Orchestrator) | Persists continuation state, enforces policy/authorization, records audit events.       | FACT |
| Antigravity          | Executes implementation only; never creates tasks or approvals.                         | FACT |
| Phase11Controller   | Coordination/policy hook **only**; must not select tasks, create execution intents, mutate DAG, or invoke Antigravity. | DECISION |

## 6. Continuation Model
1. **ACCEPT** – evidence verified and state integrated.  
2. **Phase 11 Continuation Policy Evaluation** – reads `continuationPolicy` (AUTONOMOUS | MANUAL).  
   - **AUTONOMOUS** – the normal Director continuation behaviour proceeds immediately; `DirectorDecision` selects the next ready task.  
   - **MANUAL** – a *continuation checkpoint* is created and the system enters `PHASE11_CONTINUATION_WAITING` (durable). No `DirectorDecision` is run until an authorized `requestContinue` arrives.  
**Classification:** DECISION (definition of flow)

## 7. Crash / Checkpoint Atomicity (Manual Mode)
The window between **successful state integration** and **persistent checkpoint creation** must be atomic. We achieve this by:
- Writing a single JSON document in `DurableStateManager` that includes both the normal `currentLifecycleState` **and** the new `continuationState` field in one atomic file‑write operation.
- The write is performed inside the existing `ExecutionIntegrationService` flow; durable state persistence uses the existing atomicWriteJson primitive. State and HistoryManager append are not a single transaction; full state+history rollback is not guaranteed.
- On restart, `DurableStateManager` is consulted: if `continuationState === "WAITING"` the system resumes in the waiting state; otherwise normal flow continues.
**Classification:** PROPOSED (implementation detail respecting existing authorities)

## 8. Continuation Binding
A continuation request must contain:
- `projectId`
- `directorSessionId`
These two identifiers uniquely bind the request to the waiting checkpoint because the checkpoint is created *after* integration of a specific task, not *before* any particular task identifier. No additional `iterationId`, `taskId`, `taskRevision`, `requestId`, or `evidenceId` is required.  
**Classification:** DECISION

## 9. Development Approval vs Continuation Authorization
- **Development Authorization** – performed by `HumanApprovalEngine` for code changes, schema migrations, etc.  
- **Continuation Authorization** – also validated by `HumanApprovalEngine` but using a distinct *continuation* permission (`CONTINUE_AFTER_CHECKPOINT`). It does **not** create a new per‑task approval token and does not interfere with the existing development approval workflow.  
**Classification:** PROPOSED

## 10. Policy Authority (AUTONOMOUS / MANUAL)
- The `continuationPolicy` enum (`AUTONOMOUS | MANUAL`) is stored in the durable state document managed by `DurableStateManager`.
- Only a **PRODUCT_OWNER** (or equivalent role) may update this field via an admin API on the `DirectorSession`.
- The policy is read during the `Phase 11 Continuation Policy Evaluation` step and persists across restarts because it lives in durable state.
- If the exact authority for policy mutation cannot be finalized, the item remains **OPEN** for later design.
**Classification:** OPEN

## 11. MCP Contract
### Operation: `phase11.requestContinue`
- **Caller:** Authorized human/operator with `PRODUCT_OWNER` role.  
- **Input:** `{ projectId: string, directorSessionId: string }`
- **Output:** `{ success: boolean, message?: string }`
- **Authorization:** Validated by `HumanApprovalEngine` using the *continuation* permission (see Section 9).
- **Binding:** Must match the exact `projectId` and `directorSessionId` of the waiting checkpoint.
- **Idempotency:** Re‑issuing when `continuationState === "NONE"` returns `success: false` with explanatory message.
- **Audit Event:** `PHASE11_CONTINUATION_REQUESTED` recorded by `HistoryManager`.
- **State Mutation:** Sets `continuationState` to `NONE`.
**Classification:** PROPOSED

## 12. History Events (append‑only)
- `PHASE11_CONTINUATION_WAITING` – emitted when the system enters the waiting state.  
- `PHASE11_CONTINUATION_REQUESTED` – emitted on a successful `requestContinue` call.  
- `PHASE11_CONTINUATION_ACCEPTED` – emitted when an authorized continuation request successfully transitions the checkpoint from WAITING to NONE.  
- `PHASE11_CONTINUATION_REJECTED` – emitted when an invalid or duplicate continuation request is received.  
**Classification:** PROPOSED

## 13. Crash / Recovery Semantics (summary)
| Crash Point                                          | Recovery Behaviour (using existing P10‑05 idempotency) |
|------------------------------------------------------|------------------------------------------------------|
| After ACCEPT but **before** integration               | Normal retry of integration on restart. |
| After integration **but before** checkpoint persisted | `continuationState` defaults to `NONE`; Director proceeds normally. |
| After checkpoint persisted (`WAITING`)               | System restores `continuationState === "WAITING"`; waits for `requestContinue`. |
| Duplicate `requestContinue` while still `WAITING`    | Returns `success: false`; no state change (idempotent). |
| `requestContinue` after task already progressed        | Returns `success: false`; audit event `PHASE11_CONTINUATION_REJECTED`. |
| `requestContinue` for unrelated project/session       | Returns `success: false`; audit event `PHASE11_CONTINUATION_INVALID`. |
**Classification:** DECISION

## 14. Project Completion
When `DirectorDecision` determines that **no ready task** exists after integration, the system records a `PROJECT_COMPLETE` event, clears `continuationState` to `NONE`, and terminates the session. No further continuation checkpoints are created.  
**Classification:** DECISION

## 15. Implementation Tasks (re‑generated)
1. **Design `continuationState` field** in `DurableStateManager` JSON schema (enum `"WAITING" | "NONE"`).  
2. **Add `continuationPolicy` field** (enum `AUTONOMOUS | MANUAL`) to the same durable state document.  
3. **Hook post‑integration** in `ExecutionIntegrationService` to atomically persist `continuationState` = `WAITING` when policy is MANUAL.  
4. **Implement MCP operation `phase11.requestContinue`** with validation against `HumanApprovalEngine` (continuation permission) and audit logging.  
5. **Implement the continuation-request state transition** so that an authorized request changes `continuationState` from `WAITING` to `NONE` and records the corresponding `HistoryManager` event. The existing Director-driven loop observes the resulting durable state and may subsequently invoke `DirectorDecision` through its existing authority path. `ExecutionIntegrationService` must not invoke `DirectorDecision`.  
6. **Write unit & integration tests** covering autonomous, manual, crash‑recovery, and idempotency scenarios.  
7. **Update documentation** (README, architecture diagrams) to reflect Phase 11 continuation policy and checkpoint semantics.  
8. **Re‑evaluate Phase11Controller** – if it adds no value, remove it from the architecture (marked **OPEN**).  
**Classification:** DECISION

---

**P11‑01_SPEC_STATUS:**
- FILE_CREATED: true
- WORKTREE_CHANGED: false
- PRODUCTION_FILES_CHANGED: false
- TEST_FILES_CHANGED: false
- HEAD: f4f20886b2257f4a57aaf397468e611b3254cd05
- COMMIT_CREATED: false
- PUSH_PERFORMED: false

---

**Acceptance Checklist**
- [x] Spec file updated only.
- [x] No production or test code touched.
- [x] No commit or push performed.
- [x] `git status` shows only the updated spec as modified.
