# Technical Implementation Plan: Module `antigravity-sync-bridge`

## Context
The Antigravity IDE agent and the Director interact through MCP pull-mode tools (`aidm.next_task`, `aidm.submit_task`) and mailbox files under `.ai-manager/state/ide/`. Currently:
1. `aidm.next_task` does not include `architectureIntent`, so Antigravity cannot inspect the overarching monorepo topology.
2. `aidm.submit_task` does not accept `testEvidence` (test commands run, exit code, output), preventing evidence-driven verification claims.
This module enriches `ide-executor.ts` and `ide-executor-tools.ts` to attach `architectureIntent` to `next_task` responses and support `testEvidence` in task submissions.

---

## Task Breakdown

### Task 1: IDE Executor Architecture Intent & Test Evidence Support (TDD)
- **Goal:** Update `ideNextTask()` to read and return `architectureIntent`, expand `IdeSubmit` and `ideSubmit()` to record `testEvidence`, and propagate `testEvidence` into invoker stdout JSON.
- **Files:**
  - `packages/core/src/executor-bridge/ide-executor.ts`
  - `packages/core/tests/ide-executor-sync.test.ts`
- **Acceptance Criteria:**
  - `ideNextTask(root)` includes `architectureIntent` when `architecture-intent.json` exists.
  - `ideSubmit(root, seq, summary, files, testEvidence)` stores `testEvidence` in `submit.json`.
  - Invoker stdout JSON contains `test_evidence`.
- **Verification:**
  - `node packages/core/scripts/run-tests.js ide-executor-sync`

---

### Task 2: MCP Tool Schema & Handler Enrichment (TDD)
- **Goal:** Update `ideNextTaskToolDefinition`, `ideSubmitTaskToolDefinition`, and their handlers in `ide-executor-tools.ts` to expose `architectureIntent` in output and accept `testEvidence` in input.
- **Files:**
  - `packages/core/src/mcp/tools/ide-executor-tools.ts`
  - `packages/core/tests/ide-executor-sync.test.ts`
- **Acceptance Criteria:**
  - `aidm.next_task` tool returns `architectureIntent` object when present.
  - `aidm.submit_task` accepts `testEvidence: { command, exitCode, output }` without validation error.
- **Verification:**
  - `node packages/core/scripts/run-tests.js ide-executor-sync`

---

### Task 3: Build & Full Suite Verification
- **Goal:** Compile TypeScript build (`tsc -b`) and verify all suites across the 4 modules pass with zero regressions.
- **Files:**
  - Entire `@aidm/core` package
- **Acceptance Criteria:**
  - `tsc -b` succeeds without errors.
  - `ide-executor-sync.test.ts`, `architecture-intent.test.ts`, `tech-stack-extractor.test.ts`, `p21-authorization-policy.test.ts` all pass.
- **Verification:**
  - `pnpm --filter @aidm/core build`
  - Run test scripts for all suites
