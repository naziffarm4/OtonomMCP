# Plan: AIDM Universal Project Bootstrap & Scaffolding Engine

## Context & Objectives
This plan implements the universal scaffolding protocol defined in `UNIVERSAL-PROJECT-BOOTSTRAP-SPEC.md` and `SPEC.md`.
Currently, AIDM (`@aidm/core`) runs spec ingestion directly into functional tasks (`TASK-001`, `TASK-002`, ...) with empty dependencies. In uninitialized/empty repositories, LLM executors frequently violate the "Zero-Monolith Law" by dumping entire applications into a single file (`src/index.ts` or `app.js`). Furthermore, CLI scaffolding tools fail when executed in non-empty directories (e.g. containing `SPEC.md` or `.git`).

This implementation introduces:
1. **Multi-Runtime Manifest Scanning**: Detects whether a workspace is `INITIALIZED` or `UNINITIALIZED` across 8 ecosystems + mobile/embedded.
2. **Dynamic Tech Stack Extractor**: Extracts structured metadata and non-interactive scaffolding CLI commands.
3. **Phase 0 `TASK-000: SCAFFOLD_PROJECT`**: Automatically created as a blocking prerequisite in uninitialized workspaces with all subsequent tasks dependent on it (`dependencies: ["TASK-000"]`).
4. **Isolated Staging / Empty Directory Guarantee**: Safely runs scaffolding in `.ai-manager/.tmp-scaffold/` and merges files to prevent CLI conflict errors, protecting existing specs and git metadata.
5. **DAG Dependency Blocking**: Ensures `autonomous-runner` will never dispatch a dependent task until its prerequisites are `ACCEPTED`.
6. **Universal Health Verification Gate**: Validates syntax, typecheck, lint, and build (exit code 0).
7. **Post-Scaffold Tree Re-indexing & Scope Remap**: Re-indexes the disk tree upon `TASK-000` acceptance and maps functional task target files into framework directories.
8. **Director Directive Injection**: Injects the Section 10 Zero-Monolith directive into the Director system prompts.

---

## Architecture & Capability Dependency Graph

```text
[Phase 1: Manifest Scanner] ─────────┐
                                      ▼
[Phase 2: Tech Stack Extractor] ──► [Phase 4: TASK-000 Ingestion & DAG] ──► [Phase 5: Runner DAG & Scope Remap]
                                      ▲                                      ▲
[Phase 3: Staging & Conflict Guard] ──┘                                      │
                                                                             │
[Phase 6: Health Gate & System Directive] ────────────────────────────────────┘
```

---

## Detailed Task Breakdown

### Phase 1: Repo Manifest Scanner (MOD-01)
- **Goal**: Scan root directory for manifest files across 8 ecosystems + mobile/embedded. Return `UNINITIALIZED` if none exist or only contain stubs.
- **Files**:
  - `packages/core/src/adapters/project-adapter.ts` (or `packages/core/src/autonomous/repo-manifest-scanner.ts`)
  - `packages/core/tests/repo-manifest-scanner.test.ts`
- **Specification & Signatures**:
  ```ts
  export interface WorkspaceStatusResult {
    readonly isInitialized: boolean;
    readonly detectedEcosystems: readonly string[];
    readonly manifestFiles: readonly string[];
  }

  export async function detectWorkspaceStatus(workspaceRoot: string): Promise<WorkspaceStatusResult>;
  ```
- **Supported Manifests**:
  - Node/Web: `package.json`, `tsconfig.json`
  - Python: `pyproject.toml`, `setup.py`, `requirements.txt`, `Pipfile`
  - Go: `go.mod`
  - Rust: `Cargo.toml`
  - Java/Kotlin: `pom.xml`, `build.gradle`, `build.gradle.kts`
  - .NET/C#: `*.csproj`, `*.sln`
  - PHP: `composer.json`
  - Mobile: `pubspec.yaml`, `app.json`
  - Embedded: `platformio.ini`
- **Verification**:
  - Test empty folder -> `isInitialized: false`.
  - Test folder with only `SPEC.md` / `.git` -> `isInitialized: false`.
  - Test folder with `package.json` -> `isInitialized: true`, ecosystem `'node'`.

---

### Phase 2: Dynamic Tech Stack Extractor (MOD-02)
- **Goal**: Parse spec markdown sections (`TECH`, `PURPOSE`, `REQUIREMENTS`) into typed JSON schema with non-interactive CLI commands and confidence scores.
- **Files**:
  - `packages/core/src/autonomous/tech-stack-extractor.ts`
  - `packages/core/tests/tech-stack-extractor.test.ts`
- **Specification & Signatures**:
  ```ts
  export interface TechnologyStackSchema {
    readonly projectName: string;
    readonly runtime: 'node' | 'python' | 'go' | 'rust' | 'java' | 'dotnet' | 'php' | 'unknown';
    readonly language: 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'csharp' | 'kotlin' | 'dart' | 'unknown';
    readonly framework?: string;
    readonly routerOrArchitecture?: string;
    readonly styling?: string;
    readonly uiComponents?: string;
    readonly databaseOrm?: string;
    readonly packageManager?: string;
    readonly scaffoldCommand?: string;
    readonly confidenceScore: number;
  }

  export function extractTechStackSchema(markdown: string, projectName?: string): TechnologyStackSchema;
  ```
- **Templates**:
  - Next.js (App Router, TS, Tailwind): `npx -y create-next-app@latest ./ --typescript --tailwind --eslint --app --src-dir=false --import-alias="@/*" --use-pnpm`
  - Vite + React (TS): `npm create vite@latest ./ -- --template react-ts`
  - NestJS (TS): `npx -y @nestjs/cli new ./ --skip-git --package-manager pnpm`
  - FastAPI (Poetry): `poetry init -n && poetry add fastapi uvicorn[standard]`
  - Go: `go mod init {{project_name}} && mkdir -p cmd/api internal/handlers`
  - Rust: `cargo init .`
  - Flutter: `flutter create --platforms=android,ios,web .`
- **Verification**:
  - Tests parsing sample specs for each framework and verifying extracted command and confidence score >= 0.9.

---

### Phase 3: Isolated Staging & Conflict-Free Scaffold Manager
- **Goal**: Prevent CLI directory conflict errors (`directory contains files that could conflict: SPEC.md, .git`) by scaffolding in staging and promoting files safely, while strictly preserving file permissions, preventing git repository hijack, and defending against symlink traversal.
- **Files**:
  - `packages/core/src/autonomous/scaffold-staging.ts`
  - `packages/core/tests/scaffold-staging.test.ts`
- **Key Guards & Specifications**:
  1. **Preserved Paths**: Default includes `['.git', '.ai-manager', 'SPEC.md', 'UNIVERSAL-PROJECT-BOOTSTRAP-SPEC.md', 'README.md', 'tasks', '.gitignore', '.env*']` - these can NEVER be overwritten or deleted.
  2. **Git Hijack Prevention**: If the scaffold CLI initialized its own `.git` directory inside `.tmp-scaffold/`, it MUST be removed before promotion so root git history is intact.
  3. **Permission Preservation**: Preserves POSIX `0o755` executable permissions for wrapper scripts (`gradlew`, `mvnw`, `*.sh`).
  4. **Symlink Traversal Guard**: Rejects or bounds symlinks pointing outside `workspaceRoot`.
  5. **Windows Attribute Handling**: Unlocks read-only attributes to prevent write failures.
- **Specification & Signatures**:
  ```ts
  export interface ScaffoldStagingOptions {
    readonly workspaceRoot: string;
    readonly preservedPaths?: readonly string[]; // default: ['.git', '.ai-manager', 'SPEC.md', 'UNIVERSAL-PROJECT-BOOTSTRAP-SPEC.md', 'README.md', 'tasks', '.gitignore', '.env*']
    readonly preservePermissions?: boolean;     // default: true (preserves 0o755 executable bits)
  }

  export class ScaffoldStagingManager {
    constructor(options: ScaffoldStagingOptions);
    getStagingDirectory(): string;
    promoteStagedFiles(): Promise<string[]>;
    cleanStaging(): Promise<void>;
  }
  ```
- **Verification**:
  - Unit tests verifying:
    - Zero overwrites of preserved files (`SPEC.md`, `.git`).
    - Staged `.git` deletion so root `.git` is never hijacked.
    - Executable bit (`0o755`) preservation for `gradlew` / `*.sh`.
    - Path traversal rejection via invalid symlinks.

---

### Phase 4: TASK-000 Ingestion & DAG Enforcing (MOD-03)
- **Goal**: Inject `TASK-000: Universal Project Scaffolding & Bootstrap` into `SpecIngestor` when workspace is uninitialized and enforce `dependencies: ["TASK-000"]` on all subsequent tasks.
- **Files**:
  - `packages/core/src/autonomous/spec-ingestor.ts`
  - `packages/core/tests/autonomous-spec-ingestor.test.ts`
- **Modifications in `SpecIngestor`**:
  - Extend `SpecIngestionOptions`:
    ```ts
    export interface SpecIngestionOptions {
      readonly projectId: string;
      readonly specPath?: string;
      readonly maxAttemptsPerTask?: number;
      readonly now?: () => Date;
      readonly workspaceRoot?: string;
      readonly isInitialized?: boolean;
    }
    ```
  - When `isInitialized === false`:
    - Generate `TASK-000`:
      - `task_id: 'TASK-000'`
      - `parent_feature_id: 'FEAT-SPEC'`
      - `title: 'Universal Project Scaffolding & Bootstrap'`
      - `description: 'Bootstrap the official project skeleton...'`
      - `priority: TaskPriority.CRITICAL`
      - `hierarchy_level: 'TASK'`
      - `status: TaskStatus.READY`
      - `dependencies: []`
      - `acceptance_criteria: ['Official project skeleton is scaffolded', 'Build, typecheck, and lint pass with 0 errors']`
      - `metadata: { taskClass: 'SCAFFOLD', targetFiles: ['*'], allowedPaths: ['*'], specFingerprint }`
    - For `TASK-001..n`:
      - Set `dependencies: ['TASK-000']`.
  - Backwards Compatibility:
    - If `isInitialized` is not false (or existing test setups with no `workspaceRoot`), maintain default existing behavior.
- **Verification**:
  - Test `SpecIngestor.ingest` with `isInitialized: false`: verify `TASK-000` is first and `TASK-001` has `dependencies: ['TASK-000']`.
  - Verify existing tests still pass.

---

### Phase 5: Autonomous Runner DAG Dependency Blocking & Scope Remapping (MOD-05)
- **Goal**: In `autonomous-runner.ts`, block dependent tasks from execution until prerequisite tasks are `ACCEPTED`, and after `TASK-000` is accepted, re-index workspace and remap functional task scopes.
- **Files**:
  - `packages/core/src/autonomous/autonomous-runner.ts`
  - `packages/core/tests/autonomous-scaffold-runner.test.ts`
- **Modifications**:
  1. Pass `workspaceRoot: projectRoot` into `SpecIngestor`.
  2. Fix `dependsOnUnfinished(taskReport)`:
     ```ts
     const dependsOnUnfinished = (taskReport: AutonomousTaskReport): boolean => {
       const def = taskDefs.get(taskReport.taskId);
       const deps = def?.dependencies ?? [];
       return deps.some(
         (d) =>
           waiting.has(d) ||
           report.tasks.some(
             (t) =>
               t.taskId === d &&
               (t.status === 'WAITING_DECISION' || t.status === 'SPLIT' || t.status !== 'ACCEPTED')
           )
       );
     };
     ```
  3. In `autonomous-runner.ts` task completion loop (when `taskReport.status === 'ACCEPTED'`):
     If `task.task_id === 'TASK-000'`:
     - Rescan files using `scanWorkspaceFiles(projectRoot)`.
     - Detect new directory tree (e.g. `app/`, `src/`, `routers/`).
     - Remap subsequent tasks' `targetFiles` from root stubs to appropriate subdirectories.
     - Log decision: `this.decide('DESIGN', 'Dizin ağacı yeniden indekslendi ve görev kapsamları eşlendi', ...)`
- **Verification**:
  - Integration test simulating uninitialized run: verify `TASK-000` runs first, `TASK-001` is delayed until `TASK-000` is accepted, and task targetFiles are remapped.

---

### Phase 6: Universal Health Gate & Directive Injection (MOD-04, MOD-06)
- **Goal**: Map runtime to build/lint/typecheck verification commands and inject Section 10 Zero-Monolith directive into Director system prompt.
- **Files**:
  - `packages/core/src/autonomous/web-checks.ts` (or `health-gate-commands.ts`)
  - `packages/core/src/director/director-prompt-builder.ts`
  - `packages/core/src/autonomous/spec-clarification.ts`
  - `packages/core/tests/health-gate-directive.test.ts`
- **Modifications**:
  1. Add runtime verification commands generator for `TASK-000` verification checks:
     - Node/TS: `pnpm typecheck`, `pnpm lint`, `pnpm build`
     - Python: `poetry run mypy .`, `poetry run ruff check .`
     - Go: `go vet ./...`, `go build -o /dev/null ./...`
     - Rust: `cargo check`, `cargo clippy`, `cargo build`
  2. In `DirectorPromptBuilder.buildSystemPrompt()`:
     Add section:
     ```text
     === ZERO-MONOLITH & PROJECT SCAFFOLDING DIRECTIVE ===
     Before writing any functional or business logic code, verify that the repository has a configured framework manifest.
     If the repository is uninitialized, DO NOT dump implementation code into a single arbitrary file (e.g. src/index.ts or main.py).
     Always prioritize TASK-000 scaffolding and verify that the project compiles cleanly before proceeding with business requirements.
     ```
- **Verification**:
  - Prompt builder test asserting the directive appears in system prompt.
  - Health check test asserting appropriate command generation.

---

## Verification & Quality Gates
1. **Typecheck**: `pnpm --filter @aidm/core typecheck`
2. **Unit & Integration Tests**: `pnpm --filter @aidm/core test`
3. **No Regressions**: Existing 20+ test suites in `packages/core/tests/` remain completely green.
