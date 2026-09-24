# AIDM MCP Server Foundation (P8-01)

The **AIDM Model Context Protocol (MCP) Server** establishes an authoritative, standard JSON-RPC 2.0 control plane boundary for the AI Development Manager (AIDM). It enables external Director models (such as ChatGPT Director) to interact with AIDM as the authoritative state and orchestration authority.

---

## 1. Target Architecture & Director Loop

The system supports the following authoritative autonomous Director loop:

```
  USER
    ↓
  CHATGPT — Director / Architect / Reviewer
    ↓ MCP (JSON-RPC 2.0)
  AIDM MCP SERVER — Control Boundary & Protocol Adapter
    ↓
  AIDM ORCHESTRATOR — State Authority (FSM, Task DAG, Context, Policy, Git)
    ↓
  ANTIGRAVITY — Implementer
    ↓
  CODE / TESTS / BUILD
    ↓
  SYSTEM-VERIFIED EVIDENCE
    ↓
  AIDM ORCHESTRATOR
    ↓ MCP
  CHATGPT — Analyzes Result & Decides Next Step
```

The loop continues until:
- The project goals are met and verified,
- The user requests a stop,
- Or an operation requires a human decision and AIDM enters `BLOCKED_ON_HUMAN`.

---

## 2. Core Architectural Invariant: MCP Is Not a Second Orchestrator

The MCP layer sits strictly **above** the Orchestrator as an external adapter and control boundary.

The MCP Server **never**:
- directly mutates FSM lifecycle state,
- bypasses the `TaskDagEngine`,
- bypasses the `PolicyEngine`,
- accepts agent claims as system evidence,
- directly manipulates Git or runs Git commands,
- directly executes arbitrary OS/shell commands,
- implements a competing QA review engine,
- implements independent retry or recovery logic,
- creates a competing task scheduler.

All mutations and domain evaluations are delegated into authoritative AIDM services via the `McpOrchestratorDelegate`.

---

## 3. Protocol & Transport Neutrality

The MCP boundary adheres to the Model Context Protocol specification (`2024-11-05`) and standard JSON-RPC 2.0.

### Supported Transports:
- **`InMemoryMcpTransport`**: Zero-overhead in-process communication for testing, programmatic subagent loops, and internal benchmarks.
- **`StreamMcpTransport`**: Generalized streaming transport using newline-delimited JSON (NDJSON) framing over arbitrary Node.js duplex streams.
- **`StdioMcpTransport`**: Standard I/O transport for production integration with standard MCP hosts (Cursor, Claude Desktop, ChatGPT desktop agent, CLI).

Transports implement the `McpTransport` interface (`start()`, `send()`, `onMessage()`, `onError()`, `onClose()`, `close()`), ensuring total decoupling of protocol dispatch from transport mechanics.

---

## 4. Request Correlation Boundary

Every message crossing the MCP boundary is assigned a structured `McpRequestCorrelation` context:

| Identifier | Purpose | Phase Defined |
| :--- | :--- | :--- |
| `correlationId` | Unique trace ID for AIDM logging, telemetry, and evidence | Phase 8 (P8-01) |
| `mcpRequestId` | JSON-RPC message ID from client envelope | Phase 8 (P8-01) |
| `directorSessionId` | ChatGPT Director session identifier | Reserved for Phase 9 |
| `projectId` | Target project workspace identifier | Existing Phase 1–7 |
| `taskId` | Target task identifier in the Task DAG | Existing Phase 2 |
| `executionIterationId` | Current iteration cycle counter | Existing Phase 7 |

---

## 5. Security & Policy Enforcement

The MCP boundary prevents any bypass of AIDM security and governance:

1. **No Arbitrary Execution**: No generic command execution, shell execution, or arbitrary file system mutation tools are exposed.
2. **Policy Evaluation**: Tool invocations pass through `PolicyEngine.evaluate()` before dispatch.
3. **Secret Redaction**: All error messages, stack traces, and details are sanitized through `McpErrorNormalizer` and `sanitizeSecrets` to prevent token/credential exfiltration.
4. **Workspace Confinement**: Operations remain bound to the configured `projectRoot`.

---

## 6. Error Normalization Boundary

Errors are normalized into standard JSON-RPC 2.0 error responses with machine-readable application codes:

| Error Type | JSON-RPC Code | Machine Code | Description |
| :--- | :--- | :--- | :--- |
| Parse Error | `-32700` | `ERR_MCP_PARSE_ERROR` | Malformed JSON payload |
| Invalid Request | `-32600` | `ERR_MCP_INVALID_REQUEST` | Missing or invalid JSON-RPC fields |
| Unsupported Operation | `-32601` | `ERR_MCP_UNSUPPORTED_OPERATION` | Unknown method or unregistered tool |
| Orchestrator Unavailable | `-32001` | `ERR_MCP_ORCHESTRATOR_UNAVAILABLE` | AIDM orchestrator uninitialized or offline |
| Policy Blocked | `-32002` | `ERR_MCP_POLICY_BLOCKED` | Action rejected by `PolicyEngine` |
| Human Blocked | `-32003` | `ERR_MCP_HUMAN_BLOCKED` | Action requires human decision/token |
| Internal Failure | `-32603` | `ERR_MCP_INTERNAL_FAILURE` | Unexpected internal exception |

---

## 7. Minimal Health & Discovery: `aidm.health`

In P8-01, the server exposes the minimal read-only tool `aidm.health` to prove server lifecycle and orchestrator connectivity without state mutation:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "aidm.health"
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\n  \"status\": \"healthy\",\n  \"server\": {\n    \"name\": \"aidm-mcp-server\",\n    \"version\": \"0.1.0\",\n    \"foundationVersion\": \"P8-01\",\n    \"protocolVersion\": \"2024-11-05\",\n    \"aidmVersion\": \"0.1.0\"\n  },\n  \"supportedCapabilities\": [\"tools\", \"discovery\", \"health\"],\n  \"orchestrator\": {\n    \"connected\": true,\n    \"initialized\": true,\n    \"currentLifecycleState\": \"IDLE\",\n    \"isBlocked\": false\n  },\n  \"correlationId\": \"aidm-corr-1774400000000-1-x8k2j1\",\n  \"timestamp\": \"2026-09-24T01:05:00.000Z\"\n}"
      }
    ],
    "isError": false
  }
}
```
