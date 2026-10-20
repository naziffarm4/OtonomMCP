# Spec: Module `antigravity-sync-bridge`

## 1. Objective
Establish a two-way architectural sync and evidence-driven verification bridge between the OtonomMCP Director and the Antigravity IDE agent.

Currently:
1. When Antigravity calls `aidm.next_task`, it receives only raw prompt text without awareness of the overarching multi-target workspace intent (`architectureIntent`).
2. When Antigravity calls `aidm.submit_task`, it can only send a text summary and changed files list. It cannot attach concrete terminal test/build execution evidence (`exitCode`, `command`, `output`).
3. The Director and Antigravity operate as a one-way pipeline rather than co-architects sharing architectural intent and concrete verification evidence.

This module:
1. Enriches `aidm.next_task` responses with the parsed `architectureIntent` object (from `.ai-manager/reports/architecture-intent.json`), allowing Antigravity to verify that the task matches the full declared workspace topology.
2. Expands `aidm.submit_task` to accept structured `testEvidence` (`command`, `exitCode`, `output`) and records it in `submit.json`.
3. Propagates `testEvidence` into the runner's execution outcome payload for authoritative verification.

---

## 2. Tech Stack
- **Runtime:** Node.js 22 (ESM)
- **Language:** TypeScript 5.6+
- **Protocol:** Model Context Protocol (MCP) + JSON Mailbox (`.ai-manager/state/ide/`)
- **Package:** `@aidm/core`

---

## 3. Commands
- **Build:** `pnpm --filter @aidm/core build`
- **Unit Tests:**
  - `node packages/core/scripts/run-tests.js ide-executor`
  - `node packages/core/scripts/run-tests.js p10-03-executor-tools`
- **Typecheck:** `pnpm --filter @aidm/core typecheck`

---

## 4. Project Structure & Affected Files
```text
packages/core/
├── src/
│   ├── executor-bridge/
│   │   └── ide-executor.ts        # Include architectureIntent in ideNextTask, accept testEvidence in ideSubmit
│   └── mcp/
│       └── tools/
│           └── ide-executor-tools.ts # Update MCP tool schemas & handlers for next_task and submit_task
└── tests/
    └── ide-executor-sync.test.ts  # Verification of architectureIntent output and testEvidence submission
```

---

## 5. Architectural Contracts

### 5.1. `aidm.next_task` Response Schema
```typescript
export interface IdeNextTaskResponse {
  state: 'TASK' | 'NONE';
  seq?: number;
  taskId?: string;
  instruction?: string;
  message?: string;
  architectureIntent?: ArchitectureIntentReport;
}
```

### 5.2. `aidm.submit_task` Input Schema
```typescript
export interface IdeSubmitInput {
  workspaceRoot?: string;
  seq: number;
  summary: string;
  changedFiles?: string[];
  testEvidence?: {
    command: string;
    exitCode: number;
    output?: string;
  };
}
```

### 5.3. Mailbox Storage (`submit.json`)
```typescript
export interface IdeSubmit {
  seq: number;
  taskId: string;
  summary: string;
  changedFiles: string[];
  submittedAt: string;
  testEvidence?: {
    command: string;
    exitCode: number;
    output?: string;
  };
}
```

---

## 6. Testing Strategy
- **Framework:** `node:test` + `node:assert/strict`
- **Test Scenarios:**
  1. `ideNextTask` returns `architectureIntent` when `architecture-intent.json` exists in `.ai-manager/reports/`.
  2. `ideSubmit` persists `testEvidence` into `submit.json`.
  3. `createIdeRequestInvoker` propagates `testEvidence` into the executor stdout JSON.
  4. MCP tools `aidm.next_task` and `aidm.submit_task` handle the expanded fields with schema validation.

---

## 7. Boundaries

### Always Do
- Ensure `architectureIntent` inclusion is optional and fails-safe if `architecture-intent.json` has not yet been generated.
- Truncate large test outputs (e.g. max 10,000 chars) to prevent context buffer overflow.
- Retain the Zero-Executor-Trust invariant: Antigravity claims and evidence are evaluated independently by the Director.

### Ask First
- Adding breaking changes to the existing `aidm.next_task` or `aidm.submit_task` return format.

### Never Do
- Never treat executor-submitted `testEvidence` as authoritative bypass for Director verification.
- Never crash if `testEvidence` is omitted (it remains optional for non-test tasks).

---

## 8. Success Criteria
- [ ] `ideNextTask()` includes `architectureIntent` from `readArchitectureIntentReport(root)`.
- [ ] `aidm.next_task` MCP tool exposes `architectureIntent` in its output.
- [ ] `ideSubmit()` records `testEvidence` in `submit.json`.
- [ ] `aidm.submit_task` MCP schema accepts `testEvidence` (`command`, `exitCode`, `output`).
- [ ] All unit tests pass with 0 errors and `tsc -b` succeeds.

---

## 9. Open Questions
*(Tüm gereksinimler netleştirilmiştir; açık soru bulunmamaktadır.)*
