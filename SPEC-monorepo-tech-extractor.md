# Spec: Module `monorepo-tech-extractor`

## 1. Objective
Eliminate "Naive Keyword Extraction" and "Unilateral Scope Truncation" in OtonomMCP's tech stack extractor.

Currently, `packages/core/src/autonomous/tech-stack-extractor.ts` evaluates keywords through a linear `if-else` chain. If a specification mentions `Next.js` anywhere in the text, it immediately classifies the entire project as a standalone single-app Node.js repository and issues `npx create-next-app@latest ./`, completely ignoring declared mobile (`flutter`, `expo`), backend (`nestjs`, `fastapi`), desktop, or monorepo (`pnpm workspace`, `turborepo`) requirements.

This module upgrades `tech-stack-extractor.ts` and `spec-ingestor.ts` to:
1. Semantically scan and count all declared targets and platforms (Web, Mobile, Backend/API, Desktop, Shared Packages).
2. Automatically classify projects with 2+ targets or explicit workspace keywords as **Monorepo / Workspace** (`isMonorepo: true`, `workspaceType: 'monorepo'`).
3. Retain complete platform fidelity: `targets` array enumerating each platform, its framework, language, and relative workspace path (e.g. `apps/web`, `apps/mobile`, `packages/ui`).
4. Prevent destructive root CLI scaffolds on monorepo projects by generating non-destructive workspace initialization definitions.
5. Fully preserve backward compatibility for single-framework, standalone projects.

---

## 2. Tech Stack
- **Runtime:** Node.js 22 (ESM)
- **Language:** TypeScript 5.6+
- **Validation:** Zod / Strict TypeScript interfaces
- **Package:** `@aidm/core`

---

## 3. Commands
- **Build:** `pnpm --filter @aidm/core build`
- **Unit Tests:**
  - `node packages/core/scripts/run-tests.js tech-stack-extractor`
  - `node packages/core/scripts/run-tests.js autonomous-spec-ingestor`
- **Typecheck:** `pnpm --filter @aidm/core typecheck`

---

## 4. Project Structure & Affected Files
```text
packages/core/
├── src/
│   └── autonomous/
│       ├── tech-stack-extractor.ts   # Multi-target & monorepo extraction logic & schema expansion
│       └── spec-ingestor.ts          # Integrate monorepo schema into TASK-000 metadata & description
└── tests/
    ├── tech-stack-extractor.test.ts  # Multi-platform & monorepo extraction tests
    └── autonomous-spec-ingestor.test.ts # TASK-000 scaffolding metadata tests
```

---

## 5. Schema & Architectural Design

### 5.1. Expanded `TechnologyStackSchema`
```typescript
export type TargetPlatformType = 'web' | 'mobile' | 'backend' | 'desktop' | 'shared';

export interface ArchitectureTarget {
  readonly name: string;
  readonly type: TargetPlatformType;
  readonly framework?: string;
  readonly runtime: SupportedRuntime;
  readonly language: SupportedLanguage;
  readonly path: string;
  readonly scaffoldCommand?: string;
}

export interface TechnologyStackSchema {
  readonly projectName: string;
  readonly isMonorepo: boolean;
  readonly workspaceType: 'standalone' | 'monorepo';
  readonly workspaceManager?: 'pnpm' | 'npm' | 'yarn' | 'cargo' | 'uv';
  readonly targets: readonly ArchitectureTarget[];
  readonly runtime: SupportedRuntime;
  readonly language: SupportedLanguage;
  readonly framework?: string;
  readonly routerOrArchitecture?: string;
  readonly styling?: string;
  readonly uiComponents?: string;
  readonly databaseOrm?: string;
  readonly packageManager?: string;
  readonly scaffoldCommand?: string;
  readonly confidenceScore: number;
}
```

### 5.2. Detection Strategy
1. **Target Scanning:**
   - Scan for Web targets: Next.js, Vite, React, Vue, Svelte, Nuxt.
   - Scan for Mobile targets: Flutter, React Native, Expo, Kotlin, Swift.
   - Scan for Backend / API targets: NestJS, FastAPI, Express, Actix, Gin.
   - Scan for Desktop targets: Tauri, Electron.
   - Scan for Shared / Library targets: Shared UI, Shared Types, Common.
2. **Container Determination:**
   - If `targets.length > 1` OR the markdown contains keywords (`monorepo`, `workspace`, `turborepo`, `pnpm-workspace`):
     - `isMonorepo = true`
     - `workspaceType = 'monorepo'`
     - `workspaceManager = 'pnpm'` (default in ecosystem)
     - `scaffoldCommand`: workspace bootstrap creating `pnpm-workspace.yaml`, root `package.json`, `turbo.json`, `apps/`, `packages/`.
   - Else:
     - `isMonorepo = false`
     - Single target with standalone scaffold command (backward compatible).

---

## 6. Testing Strategy
- **Framework:** `node:test` + `node:assert/strict`
- **Test Scenarios:**
  1. **Multi-Target Detection:** Spec with Next.js Web + Flutter Mobile + NestJS Backend yields:
     - `isMonorepo === true`
     - `workspaceType === 'monorepo'`
     - `targets` contains 3 distinct targets with correct paths (`apps/web`, `apps/mobile`, `apps/api` or `services/api`).
  2. **Explicit Workspace Keyword Detection:** Spec with `pnpm-workspace` or `Turborepo` sets `isMonorepo === true`.
  3. **Standalone Backward Compatibility:** Spec with only Next.js retains `isMonorepo === false` and existing `npx create-next-app` command.
  4. **Spec Ingestion Integration:** Ingesting a multi-target spec populates `TASK-000` with `techStack.isMonorepo === true` and the full `targets` list in `metadata.techStack`.

---

## 7. Boundaries

### Always Do
- Detect and preserve all platforms listed in the spec; never drop a platform.
- Default to `pnpm` workspaces for TypeScript / Node-centric monorepos.
- Maintain 100% backward compatibility for standalone single-target projects.

### Ask First
- Adding support for non-standard monorepo managers (e.g. Nx, Lerna, Bazel).

### Never Do
- Never issue a destructive root `npx create-next-app ./` if multiple targets are detected.
- Never downgrade a multi-target spec into a single monolithic target.

---

## 8. Success Criteria
- [ ] Specs describing multiple platforms (e.g. Web + Mobile or Web + API) produce `isMonorepo: true`.
- [ ] `targets` lists all declared platforms with designated workspace paths (`apps/*`, `packages/*`).
- [ ] Standalone specs continue to pass all existing tests in `tech-stack-extractor.test.ts`.
- [ ] `SpecIngestor` embeds the complete multi-target architecture in `TASK-000` metadata.
- [ ] `tsc -b` and all tests pass with 0 errors.

---

## 9. Open Questions
*(Tüm gereksinimler netleştirilmiştir; açık soru bulunmamaktadır.)*
