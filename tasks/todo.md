# Todo: AIDM Universal Project Bootstrap & Scaffolding Engine

- [x] **Phase 1: Repo Manifest Scanner (MOD-01)**
  - [x] Implement `packages/core/src/adapters/project-adapter.ts` (or `repo-manifest-scanner.ts`) supporting 8 ecosystems + mobile/embedded.
  - [x] Create `packages/core/tests/repo-manifest-scanner.test.ts` to test uninitialized vs initialized directory detection.
  - [x] Run test suite for Phase 1.

- [x] **Phase 2: Dynamic Tech Stack Extractor (MOD-02)**
  - [x] Implement `packages/core/src/autonomous/tech-stack-extractor.ts` to extract `TechnologyStackSchema` with non-interactive CLI templates.
  - [x] Create `packages/core/tests/tech-stack-extractor.test.ts` for Next.js, Vite, FastAPI, Go, Rust, Flutter, PlatformIO specs.
  - [x] Run test suite for Phase 2.

- [x] **Phase 3: Isolated Staging & Conflict-Free Scaffold Manager**
  - [x] Implement `packages/core/src/autonomous/scaffold-staging.ts` with staging directory management, atomic merge, file permission preservation (`0o755`), staged `.git` purge, and zero overwrites for preserved paths (`.git`, `SPEC.md`, `README.md`, `tasks`).
  - [x] Create `packages/core/tests/scaffold-staging.test.ts` verifying file permissions, git preservation, and symlink security.
  - [x] Run test suite for Phase 3.

- [x] **Phase 4: TASK-000 Ingestion & DAG Enforcing (MOD-03)**
  - [x] Update `packages/core/src/autonomous/spec-ingestor.ts` to support `workspaceRoot` / `isInitialized` and inject `TASK-000` with `dependencies: ["TASK-000"]` for subsequent tasks.
  - [x] Update `packages/core/tests/autonomous-spec-ingestor.test.ts` to verify `TASK-000` generation while ensuring backward compatibility.
  - [x] Run test suite for Phase 4.

- [x] **Phase 5: Autonomous Runner DAG Dependency Blocking & Scope Remapping (MOD-05)**
  - [x] Update `dependsOnUnfinished` in `packages/core/src/autonomous/autonomous-runner.ts` to block tasks until prerequisites are `ACCEPTED`.
  - [x] Implement post-scaffold tree rescanning and `targetFiles` remapping after `TASK-000` is accepted.
  - [x] Run test suite for Phase 5.

- [x] **Phase 6: Universal Health Gate & Directive Injection (MOD-04, MOD-06)**
  - [x] Implement runtime health verification commands generator for `TASK-000` validation.
  - [x] Update `packages/core/src/director/director-prompt-builder.ts` to inject Section 10 Zero-Monolith Directive.
  - [x] Create `packages/core/tests/health-gate-directive.test.ts`.
  - [x] Run full project typecheck and test suites.
