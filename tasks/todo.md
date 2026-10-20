# Task List: Module `antigravity-sync-bridge` (Completed)

- [x] **Task 1: IDE Executor Architecture Intent & Test Evidence Support (TDD)**
  - [x] Write tests in `packages/core/tests/ide-executor-sync.test.ts` for `architectureIntent` in `ideNextTask` and `testEvidence` in `ideSubmit`
  - [x] Update `ideNextTask`, `ideSubmit`, `createIdeRequestInvoker` in `packages/core/src/executor-bridge/ide-executor.ts`
  - [x] Verify test passes (GREEN)
- [x] **Task 2: MCP Tool Schema & Handler Enrichment (TDD)**
  - [x] Update MCP tool definitions and handlers in `packages/core/src/mcp/tools/ide-executor-tools.ts`
  - [x] Add MCP tool invocation tests in `packages/core/tests/ide-executor-sync.test.ts`
  - [x] Verify test passes (GREEN)
- [x] **Task 3: Build & Full Suite Verification**
  - [x] Run `pnpm --filter @aidm/core build` (`tsc -b`)
  - [x] Run `ide-executor-sync.test.ts` (4/4 PASS)
  - [x] Run all affected test suites:
    - `p21-authorization-policy.test.ts` (28/28 PASS)
    - `autonomous-mandate.test.ts` (10/10 PASS)
    - `tech-stack-extractor.test.ts` (11/11 PASS)
    - `autonomous-spec-ingestor.test.ts` (10/10 PASS)
    - `architecture-intent.test.ts` (4/4 PASS)
    - `ide-executor-sync.test.ts` (4/4 PASS)
