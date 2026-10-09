# Contributing to OtonomMCP (AIDM)

Thank you for your interest in contributing to the AI Development Manager (AIDM) project.

## Code of Conduct & Invariants

This project implements strict safety and governance guarantees. All contributions must respect these hard invariants:

1. **Zero Executor Trust:** Verbal agent claims or exit codes alone do not constitute proof of success. Independent verification via `EvidenceCollector` is mandatory.
2. **Fail-Closed Security:** Security, budget, authorization, and human approval checks must fail closed.
3. **Deterministic Testing:** Default test suite (`pnpm test`) must run 100% offline, without external network, API keys, or live host CLI dependencies.
4. **Git Safety:** Force pushing (`git push -f`) is strictly forbidden. All operations must be verified before push.

## Prerequisites

- **Node.js:** `>=22.6.0` (LTS `v22.19.0` recommended, see `.nvmrc`)
- **pnpm:** `12.3.4` (enforced via `packageManager`)
- **Git:** 2.40+

## Development Workflow

1. Clone repository and install dependencies:
   ```bash
   pnpm install
   ```

2. Build the project:
   ```bash
   pnpm build
   ```

3. Run typecheck:
   ```bash
   pnpm typecheck
   ```

4. Run offline deterministic tests:
   ```bash
   pnpm test
   ```

5. Run live tests (optional, requires valid environment credentials):
   ```bash
   pnpm test:live
   ```

## Commit Guidelines

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- Keep changes scoped, auditable, and backed by automated tests.
