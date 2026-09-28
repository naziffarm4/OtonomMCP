# P18 — Real Project Pilot
## Phase 1: External Pilot Discovery & Project Specification Report

---

### Executive State Summary

| State Dimension | Authoritative Status |
| :--- | :--- |
| **P18 Discovery** | **COMPLETE** |
| **PROJECT_SPEC** | **GENERATED & VERIFIED** (rev-1) |
| **Specification Completeness Gate** | **BLOCKED_ON_HUMAN** (Pending explicit Product Owner decisions) |
| **Product Owner Approval** | **NOT APPROVED** (`BLOCKED_ON_HUMAN`) |
| **Implementation** | **NOT STARTED** |
| **Autonomous Driver** | **NOT STARTED** |
| **Pilot Codebase** | **UNCHANGED** (Initial commit `8c3fa40`, working tree clean) |

---

### A. Pilot Repository Identity
* **Repository Name:** `aidm-pilot-task-queue`
* **Canonical URL:** `https://github.com/naziffarm4/aidm-pilot-task-queue`

### B. Pilot Git Root
* **Path:** `/workspaces/aidm-pilot-task-queue`
* **Boundary Invariant:** Operates as an independent Git repository, fully decoupled from OtonomMCP.

### C. Pilot Remote
* **Origin Fetch:** `https://github.com/naziffarm4/aidm-pilot-task-queue.git`
* **Origin Push:** `https://github.com/naziffarm4/aidm-pilot-task-queue.git`

### D. Pilot HEAD
* **Commit SHA:** `8c3fa40b3c29db0323fbe570b95adc9752ae9cec`
* **Commit Subject:** `Create README.md`
* **Branch:** `main` (synchronized with `origin/main`)

### E. Pilot Working-Tree Status
* **Status:** Clean (`nothing to commit, working tree clean`)
* **Untracked / Modified Files:** None.

### F. Existing Pilot Files
* `.git/` (Git metadata)
* `README.md` (Content: `# AIDM Pilot Task Queue\n\nThis repository is the isolated pilot project for AIDM.\n`)
* **Project Configuration:** No `package.json`, `tsconfig.json`, or build/test configuration exists in the pilot repository yet.

### G. Existing vs. Planned Functionality
* **EXISTING:**
  * Initial repository initialization and top-level README description only.
* **PLANNED:**
  * TypeScript compiler and build configuration (`tsconfig.json`, `package.json`).
  * Domain models (`TaskItem`, `TaskPriority`, `QueueConfig`, `TaskLease`).
  * Queue engine operations (`enqueue`, `dequeue`, `peek`, `lease`, `release`, `expireStale`).
  * Deterministic state snapshot JSON serialization and deserialization with runtime schema validation.
  * Unit, integration, and E2E automated test suites.

### H. Project Purpose
* A reliable prioritized in-memory task queue engine supporting:
  * FIFO / priority scheduling
  * Task leasing
  * TTL expiration
  * Deterministic state snapshots
  * JSON serialization / deserialization
* Intended to be an independently versioned, small, real TypeScript library project.

### I. Target Users
* Developers and software systems integrating a prioritized in-memory task queue with deterministic state snapshot capabilities and lease semantics.

### J. In-Scope Requirements
1. **Domain Models & Schema Validation (`FREQ-pilot-models`):**
   * Strongly typed domain contracts: `TaskItem`, `TaskPriority`, `QueueConfig`, `TaskLease`.
   * Runtime schema validation for task creation and queue configuration.
2. **Prioritized In-Memory Queue Operations (`FREQ-pilot-queue-ops`):**
   * Core operations: `enqueue`, `dequeue`, `peek`, `lease`, `release`, `expireStale`.
   * Priority scheduling with FIFO ordering strictly preserved within identical priority levels.
   * Exclusive task leasing with lease expiration timers.
   * Stale task eviction via TTL / lease expiration (`expireStale`).
3. **Persistence Representation (`FREQ-pilot-persistence`):**
   * Deterministic JSON state serialization snapshots.
   * Deterministic JSON state deserialization with schema validation.
4. **Verification:**
   * Automated unit test suite covering domain models, priority ordering, and queue operations.
   * Automated integration/E2E test suite covering lease/release lifecycles and serialization round-trips.
   * Build and strict TypeScript typechecking verification.

### K. Out-of-Scope Requirements
The following capabilities and components are explicitly excluded:
* External databases (SQL / PostgreSQL / MySQL / MongoDB / SQLite)
* Redis
* Distributed consensus or clustering mechanisms
* HTTP APIs, REST endpoints, or gRPC services
* UI / frontend frameworks or web dashboards
* Authentication and authorization subsystems
* Cloud infrastructure and deployment orchestrators (AWS / GCP / Azure)
* Unnecessary external framework dependencies

### L. Non-Functional Requirements
* **Performance:** High-throughput, low-latency in-memory operations with efficient scheduling.
* **Reliability:** Strict FIFO determinism within priority levels; zero task loss during valid leasing lifecycles; deterministic snapshot recovery.
* **Usability:** Idiomatic TypeScript API with strongly typed contracts and clear error reporting.
* **Compatibility:** Modern Node.js LTS environments.
* **Security:** Memory-isolated in-process execution; zero external network exposure; runtime schema validation rejecting malformed payloads.

### M. Architecture
* Modular TypeScript library architecture separating domain types, queue execution engine, and serialization adapters.
* Pure in-memory data structures (priority heap / ordered lists) with zero background daemon dependencies.

### N. Technology
* **Language & Runtime:** TypeScript, Node.js (standard built-ins).
* **Package / Module Format:** ESM TypeScript package.
* **Prohibited Technologies:** External databases, Redis, HTTP/REST/gRPC frameworks, frontend UI frameworks, cloud infrastructure.

### O. Persistence Model
* In-memory state representation with deterministic JSON snapshot serialization and deserialization. No persistent database daemon or external key-value store.

### P. Integration Requirements
* Designed as a standalone, consumable TypeScript library module.

### Q. Security Considerations
* No network listening ports or remote execution surface.
* Strict runtime schema validation on state deserialization prevents state injection and memory corruption.

### R. Business Rules
* **BR-FIFO-PRIORITY:** Higher priority tasks are always dequeued first; ties within identical priority levels are broken strictly by FIFO order.
* **BR-EXCLUSIVE-LEASE:** A leased task is hidden from dequeue until released or until its lease duration elapses.
* **BR-STALE-TTL:** Tasks exceeding their TTL or expired leases are reclaimed/evicted by `expireStale`.
* **BR-DETERMINISTIC-SNAPSHOT:** JSON state snapshot serialization must be strictly deterministic across independent executions.
* **BR-SCHEMA-ENFORCEMENT:** Deserialized state snapshots must satisfy schema validation prior to in-memory queue hydration.

### S. Acceptance Criteria
* **AC-MODELS:** `TaskItem`, `TaskPriority`, `QueueConfig`, `TaskLease` defined with complete TypeScript types and schema validators.
* **AC-QUEUE-OPS:** `enqueue`, `dequeue`, `peek`, `lease`, `release`, and `expireStale` operate according to business rules with 100% unit test pass rate.
* **AC-SERIALIZATION:** Deterministic JSON serialization and deserialization round-trip preserves state identically with zero data loss.
* **AC-VERIFICATION:** Clean build and typecheck with zero compiler errors under strict mode.

### T. Risks
* **RISK-TECH-CLOCK:** System clock drift or non-monotonic time could impact lease/TTL evaluation if not isolated via an injectable clock abstraction.
* **RISK-OPERATIONAL-MEM:** Unbounded task ingestion without queue capacity limits could lead to memory exhaustion.

### U. Human Decision Points (Pending Product Owner Choice)
AIDM identified and recorded 23 pending human decision points conforming to the rule against silent decisions:
1. **Deployment & Hosting Environment Model (`HDP-EDC65B5BE88D`, `HDP-EDB5EEDB4BFE`):**
   * *Question:* Select the target distribution/deployment model for the system.
   * *Options:* `Cloud Hosted (AWS / GCP / Azure)` vs. `Local / Self-Hosted Docker Container` (or library package distribution).
   * *Status:* `PENDING_DECISION`
2. **Acceptance Thresholds for Qualitative Criteria (e.g. `HDP-EFB9453FF6F7`, `HDP-F1172CC740BB`):**
   * *Question:* Define authoritative quantitative metrics or approve qualitative review for security, usability, and availability criteria.
   * *Status:* `PENDING_DECISION`

### V. Discovery Revision
* **Revision:** `rev-1`
* **Cryptographic Fingerprint (SHA-256):** `cfbbc6183d4894941bc70ae98be927056742bc4d51898fbd237be422b333ca74`
* **Persisted Store Path:** `.ai-manager/project-discovery/records/aidm-pilot-task-queue/rev-1.json`

### W. PROJECT_SPEC Revision
* **Specification Revision:** `rev-1`
* **Semantic Fingerprint (SHA-256):** `db5df3fd9980ed214821f8ef4e1ffa37d7c8d297bfc674b6c11eff71077f9354`
* **Persisted Spec Projection:** `.ai-manager/project-spec/records/aidm-pilot-task-queue/PROJECT_SPEC.md`

### X. Completeness Gate Result
* **Overall Status:** **`BLOCKED_ON_HUMAN`**
* **Fingerprint (SHA-256):** `150ceb90492ae57f6b5fa3cfd1e1c7df2d834f51a43c261dd4d04936d095d60f`
* **Is Eligible For Approval:** `false`
* **Reason:** Contains unresolved Human Decision Points that require explicit Product Owner determination.

### Y. Approval Package Status
* **Package ID:** `pkg-p15-aidm-pilot-task-queue`
* **Revision:** `rev-1`
* **Package Status:** **`BLOCKED_ON_HUMAN`**
* **Approval State:** **NOT APPROVED**
* **Persisted Store Path:** `.ai-manager/approval/packages/pkg-p15-aidm-pilot-task-queue/rev-1.json`

### Z. Unresolved Decisions
* The 23 Human Decision Points (including deployment model and acceptance threshold formalizations) remain recorded in `PENDING_DECISION` status. No decision was made autonomously or fabricated.

### AA. Proposed Implementation Task Graph (Planning Only)
```
TASK-PILOT-01: Domain Models & Schema Validation
       ↓
TASK-PILOT-02: Priority Queue Engine & TTL Eviction
       ↓
TASK-PILOT-03: State Serialization & E2E Integration
```
*(Planning representation only; not ingested into executable DAG and not authorized for execution).*

### AB. Confirmation: No Implementation Task Executed
* Confirmed: Zero implementation tasks were ingested, authorized, or executed.

### AC. Confirmation: Driver Not Started
* Confirmed: Neither the Director nor the Autonomous Driver runtime was invoked or started.

### AD. Confirmation: Pilot Repository Remained Isolated
* Confirmed: Pilot Git tree at `/workspaces/aidm-pilot-task-queue` remained completely untouched, with clean working tree on commit `8c3fa40`. No code or files were written to the pilot workspace.

### AE. Confirmation: OtonomMCP Not Unintentionally Modified
* Confirmed: OtonomMCP source code under `packages/core/src/` was completely unmodified (0 source lines changed). Only authoritative AIDM planning records were saved under `.ai-manager/`.

---

### Authoritative Commit Report (OtonomMCP)

* **Commit SHA:** `ea2b1d0ebe161325c111c5abbe9552eb0d5bff52`
* **Short SHA:** `ea2b1d0`
* **Subject:** `docs(p18): persist authoritative pilot discovery and project specification artifacts`
* **Rationale:** Persisted the authoritative project-initiation records (discovery, requirements/scope, architecture/technology, business rules, acceptance criteria, risks/HDPs, PROJECT_SPEC projection, completeness gate, and approval package) for the external pilot project (`aidm-pilot-task-queue`) under `.ai-manager/`.
