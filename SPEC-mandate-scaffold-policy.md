# Spec: Module `mandate-scaffold-policy`

## 1. Objective
Enable seamless greenfield project scaffolding (`TASK-000`) and multi-package / monorepo workspace setups without triggering P21 Policy Engine deadlocks.

Currently, when the autonomous runner begins execution on an uninitialized repository:
1. `scaffoldTask` is generated with `taskClass: 'SCAFFOLD'`.
2. The default operator mandate (`autonomous-mandate.ts`) sets `autoExecutableTaskClasses: ['IMPLEMENTATION']`. When the Director dispatches `IMPLEMENT_TASK` for `TASK-000`, `AuthorizationPolicyEngine` rejects it fail-closed with `TASK_CLASS_NOT_AUTO_EXECUTABLE`.
3. The default mandate only allows basic single-tier paths (`src`, `lib`, etc.). Target files in monorepo structures (`apps/*`, `packages/*`, `pnpm-workspace.yaml`, `turbo.json`) trigger `DIRECTORY_ACCESS_FORBIDDEN`.
4. Wildcard targets (`targetFiles: ['*']`) fail directory prefix matching.

This module updates the autonomous mandate generation and policy evaluation engine so that `SCAFFOLD`, `ANALYSIS`, and `CONFIGURATION` task classes and standard monorepo paths are legally authorized without weakening any core security invariants (`WORKSPACE_ESCAPE`, `GIT_PUSH`, `SYSTEM_DESTRUCTIVE` remain non-negotiably forbidden).

---

## 2. Tech Stack
- **Runtime:** Node.js 22 (ESM)
- **Language:** TypeScript 5.6+
- **Validation:** Zod
- **Package:** `@aidm/core`

---

## 3. Commands
- **Build:** `pnpm --filter @aidm/core build`
- **Unit Tests:**
  - `node packages/core/scripts/run-tests.js autonomous-mandate`
  - `node packages/core/scripts/run-tests.js p21-authorization-policy`
- **Typecheck:** `pnpm --filter @aidm/core typecheck`

---

## 4. Project Structure & Affected Files
```text
packages/core/
├── src/
│   ├── autonomous/
│   │   └── autonomous-mandate.ts           # Expand allowed task classes and allowed paths
│   ├── authorization/
│   │   ├── authorization-policy-types.ts   # Type definitions & constants
│   │   └── authorization-policy-engine.ts  # Directory & wildcard matching for scaffold tasks
└── tests/
    ├── autonomous-mandate.test.ts          # Test mandate builder defaults
    └── p21-authorization-policy.test.ts    # Test policy engine evaluations for SCAFFOLD & monorepo paths
```

---

## 5. Code Style & Architectural Conventions
- Strict TypeScript (`noImplicitAny: true`, strict null checks).
- Immutability on exported array constants via `Object.freeze`.
- Safe path normalization (replacing backslashes with `/` for cross-platform Windows/POSIX consistency).
- Deterministic error codes in `appliedRules`.

```typescript
// Example: Expanded task classes and paths in autonomous-mandate.ts
export const DEFAULT_AUTONOMOUS_TASK_CLASSES = Object.freeze([
  'IMPLEMENTATION',
  'SCAFFOLD',
  'ANALYSIS',
  'CONFIGURATION',
]);

export const DEFAULT_AUTONOMOUS_ALLOWED_PATHS = Object.freeze([
  'src', 'lib', 'app', 'apps', 'packages', 'services', 'modules',
  'test', 'tests', '__tests__', 'docs', 'public', 'assets', 'scripts', 'examples',
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'turbo.json',
  'README.md', 'tsconfig.json', 'jsconfig.json', '.gitignore',
]);
```

---

## 6. Testing Strategy
- **Framework:** `node:test` + `node:assert/strict`
- **Test Scenarios:**
  1. `buildAutonomousMandate()` produces a mandate with `autoExecutableTaskClasses` containing all 4 approved classes: `['IMPLEMENTATION', 'SCAFFOLD', 'ANALYSIS', 'CONFIGURATION']`.
  2. `buildAutonomousMandate()` includes `apps`, `packages`, `pnpm-workspace.yaml`, and `turbo.json` in `allowedDirectories`.
  3. `evaluateActionRules` permits `IMPLEMENT_TASK` for a task with `taskClass: 'SCAFFOLD'`.
  4. `evaluateActionRules` permits file operations targeting `apps/web/package.json`, `packages/ui/index.ts`, and root configs.
  5. `evaluateActionRules` handles wildcard `targetFiles: ['*']` for `SCAFFOLD` tasks without throwing `DIRECTORY_ACCESS_FORBIDDEN`.
  6. Invariant check: Malicious operations (`WORKSPACE_ESCAPE`, `GIT_PUSH`, `CREDENTIAL_ACCESS`) remain strictly `DENY`.

---

## 7. Boundaries

### Always Do
- Enforce that mandate changes are sealed by the operator CLI invocation context (P18-04).
- Retain fail-closed default for unclassified or unknown task classes.
- Validate that all target paths remain strictly inside the project root (`path.resolve` check).

### Ask First
- Adding any new operation type to `AUTONOMOUS_ALLOWED_OPERATION_TYPES`.
- Modifying mandate validity window defaults (currently 8 hours).

### Never Do
- Never permit `WORKSPACE_ESCAPE`, `GIT_PUSH`, `GIT_FORCE_PUSH`, `GIT_HISTORY_REWRITE`, `CREDENTIAL_ACCESS`, or `SYSTEM_DESTRUCTIVE`.
- Never allow an LLM or MCP agent to self-sign or mutate its own mandate.
- Never disable or bypass `ANTI_SPOOFING_AUTHORITY_VIOLATION`.

---

## 8. Success Criteria
- [ ] `buildAutonomousMandate()` defaults include `['IMPLEMENTATION', 'SCAFFOLD', 'ANALYSIS', 'CONFIGURATION']`.
- [ ] Monorepo workspace directories (`apps`, `packages`) and root configs (`pnpm-workspace.yaml`, `turbo.json`) are authorized by default.
- [ ] `TASK-000` execution intents with `taskClass: 'SCAFFOLD'` evaluate to `ALLOW` (or `REQUIRE_HUMAN_APPROVAL` only when out-of-scope operations are present, never `TASK_CLASS_NOT_AUTO_EXECUTABLE`).
- [ ] All tests in `autonomous-mandate.test.ts` and `p21-authorization-policy.test.ts` pass with 0 failures.
- [ ] TypeScript compilation (`tsc -b`) succeeds without warnings or type errors.

---

## 9. Open Questions
*(Tüm açık sorular Phase 0 aşamasında netleştirilmiştir; modül düzeyinde açık soru kalmamıştır.)*
