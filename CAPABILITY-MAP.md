# Capability Map: OtonomMCP Universal Monorepo & Anti-Simplification Engine

| Module ID | Responsibility | Depends On | Status |
| :--- | :--- | :--- | :--- |
| **`mandate-scaffold-policy`** | Expand `autoExecutableTaskClasses` to include `SCAFFOLD`, `ANALYSIS`, `CONFIGURATION`. Add standard monorepo directories (`apps/*`, `packages/*`) and workspace root files to `allowedDirectories`. Support wildcard/root file targeting for scaffold tasks without `DIRECTORY_ACCESS_FORBIDDEN` or policy lockup. | — | **COMPLETED** |
| **`monorepo-tech-extractor`** | Upgrade `tech-stack-extractor.ts` and `spec-ingestor.ts` to detect multi-target architectures (Web, Mobile, Backend, Desktop) semantically instead of naive single-keyword fallback; generate monorepo workspace scaffold definitions. | `mandate-scaffold-policy` | **COMPLETED** |
| **`director-anti-simplification`** | Inject `ZERO_UNILATERAL_SIMPLIFICATION` into Director reasoning; generate `.ai-manager/reports/architecture-intent.json` capturing the full intended workspace topology. | `monorepo-tech-extractor` | **COMPLETED** |
| **`antigravity-sync-bridge`** | Embed `architectureIntent` in `aidm_next_task` output; enrich `aidm_submit_task` with verification/test evidence payload; enable two-way Director ↔ Antigravity peer review. | `director-anti-simplification` | **COMPLETED** |

**Build Order:** `mandate-scaffold-policy` (DONE) → `monorepo-tech-extractor` (DONE) → `director-anti-simplification` (DONE) → `antigravity-sync-bridge` (DONE)
