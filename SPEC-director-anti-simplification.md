# Spec: Module `director-anti-simplification`

## 1. Objective
Enforce the "Absolute Fidelity Law" (Anti-Simplification) in the Director's reasoning engine and establish a persistent Architectural Intent record.

Currently:
1. The Director's reasoning prompts lack an explicit anti-simplification directive. When confronted with complex, multi-platform requirements (Web, Mobile, Backend, Monorepo), the LLM Director may arbitrarily prune or postpone layers with rationalizations like *"I'll focus on a single Web app for Phase 1 and defer mobile/backend"*.
2. There is no structured, inspectable report capturing the Director's architectural topology before task execution begins.

This module:
1. Injects the normative `ZERO_UNILATERAL_SIMPLIFICATION` directive into the Director's reasoning prompt and stable run context (`autonomous-runner.ts`).
2. Implements `ArchitectureIntentReport` generation and persistence:
   - Saves `.ai-manager/reports/architecture-intent.json` immediately upon spec ingestion.
   - Records whether the system is standalone or monorepo, its workspace manager, package hierarchy, and all declared platform targets.
3. Exposes `techStack` on `SpecIngestionResult` for clean provenance.

---

## 2. Tech Stack
- **Runtime:** Node.js 22 (ESM)
- **Language:** TypeScript 5.6+
- **Persistence:** JSON atomic write (`atomicWriteJson` / standard fs write)
- **Package:** `@aidm/core`

---

## 3. Commands
- **Build:** `pnpm --filter @aidm/core build`
- **Unit Tests:**
  - `node packages/core/scripts/run-tests.js architecture-intent`
  - `node packages/core/scripts/run-tests.js autonomous-spec-ingestor`
- **Typecheck:** `pnpm --filter @aidm/core typecheck`

---

## 4. Project Structure & Affected Files
```text
packages/core/
├── src/
│   └── autonomous/
│       ├── architecture-intent.ts      # Types and generator/reader for architecture-intent.json
│       ├── autonomous-runner.ts        # Inject ZERO_UNILATERAL_SIMPLIFICATION & generate report
│       ├── spec-ingestor.ts            # Expose techStack on SpecIngestionResult
│       └── index.ts                    # Export architecture-intent module
└── tests/
    └── architecture-intent.test.ts     # Verification tests for report generation & prompt directive
```

---

## 5. Architectural Contracts

### 5.1. Prompt Directive
```text
[DIRECTIVE: ZERO_UNILATERAL_SIMPLIFICATION]
1. The specification is the absolute, inviolable contract.
2. You are strictly forbidden from:
   - Downgrading multi-platform or workspace requirements into a single monolithic project.
   - Postponing or dropping declared architectural layers (e.g. monorepo, desktop, mobile, backend) on your own initiative.
   - Making arbitrary "Phase 1 only" scope reduction assumptions unless the user explicitly requested it in the prompt.
3. If the specification describes a comprehensive architecture, your planning, scaffolding (TASK-000), and task breakdown MUST reflect that full architecture from day one.
4. If you identify architectural complexity, ambiguities, or trade-offs, DO NOT quietly truncate scope. You MUST formulate a structured Architectural Report and consult Antigravity / User.
```

### 5.2. Architecture Intent Schema
```typescript
export interface ArchitectureIntentReport {
  readonly projectId: string;
  readonly projectName: string;
  readonly specFingerprint: string;
  readonly generatedAt: string;
  readonly isMonorepo: boolean;
  readonly workspaceType: 'standalone' | 'monorepo';
  readonly workspaceManager?: string;
  readonly targets: readonly ArchitectureTarget[];
  readonly rootDirectories: readonly string[];
  readonly packageHierarchy: readonly {
    readonly name: string;
    readonly type: string;
    readonly path: string;
    readonly framework?: string;
  }[];
  readonly antiSimplificationDirective: string;
}
```

---

## 6. Testing Strategy
- **Framework:** `node:test` + `node:assert/strict`
- **Scenarios:**
  1. `generateArchitectureIntentReport` produces a valid report with all declared targets for multi-target specs.
  2. `saveArchitectureIntentReport` writes atomic JSON to `.ai-manager/reports/architecture-intent.json` and `readArchitectureIntentReport` re-reads it accurately.
  3. `autonomous-runner.ts` stable context string contains the exact `ZERO_UNILATERAL_SIMPLIFICATION` directive.
  4. `SpecIngestor.ingest()` includes `techStack` on the returned result.

---

## 7. Boundaries

### Always Do
- Persist `.ai-manager/reports/architecture-intent.json` before any task dispatch occurs.
- Include the anti-simplification directive in all Director prompts.
- Ensure report paths use safe project-relative normalization.

### Ask First
- Adding new properties to `ArchitectureIntentReport` that require external network schema registries.

### Never Do
- Never omit declared platforms from the architecture intent report.
- Never silence or weaken the anti-simplification prompt constraints.

---

## 8. Success Criteria
- [ ] `ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE` constant is exported and injected into Director prompt context.
- [ ] `.ai-manager/reports/architecture-intent.json` is generated upon spec ingestion and contains the complete package hierarchy.
- [ ] `SpecIngestionResult` exposes `techStack`.
- [ ] All unit tests pass with 0 failures and `tsc -b` compiles cleanly.

---

## 9. Open Questions
*(Tüm detaylar onaylanmış olup açık soru bulunmamaktadır.)*
