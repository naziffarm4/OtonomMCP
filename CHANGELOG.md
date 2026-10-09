# Changelog

All notable changes to the OtonomMCP (AIDM) repository will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repository hygiene infrastructure: `.gitattributes`, `.editorconfig`, `.prettierrc.json`, `eslint.config.js`, `.nvmrc`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`.
- Deterministic GitHub Actions CI workflow (`.github/workflows/ci.yml`).
- Technical Debt & Acceptance Gate audit matrix (`docs/TECHNICAL_DEBT_GATE.md`).

## [0.1.0] - 2026-10-09

### Added
- Core AIDM scaffolding, domain types, and FSM engine (`@aidm/core`).
- OM-01: Git checkpointing, workspace isolation (`runtime.lock`), and integrity validation.
- OM-02: Architecture definition, actor boundary clarification, and 4-tier verification model.
- OM-03: Director reasoning runtime, OpenAI wire format adapter, and BigInt Nano-USD budget management (P18-03).
- OM-04: Action protocol, Zod envelope validation, and Project Mandate authorization policy engine.
- OM-05: Closed-loop coordinator, execution bridge, and multi-state failure recovery.
- OM-06: Director MCP control plane with stdio JSON-RPC 2.0 interface.
- OM-07: Durable state recovery, history event ledger (`history.jsonl`), and idempotent retry.
- OM-08: General integration contract, standard error hierarchy, and authoritative dependency fail-closed gate (P34).
- OM-09: Live E2E test harness and readiness audit (P35).
