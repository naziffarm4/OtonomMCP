# OtonomMCP ⇄ External IdP Contract (v1)

Authoritative verifier: `packages/core/src/authorization/trusted-identity-adapters.ts`
(`OidcIdentityProviderAdapter`) + `packages/core/src/autonomous/idp-client.ts` (extra claim checks).
Claim names below are exactly the names the adapter reads. All timestamps in JWT claims are
NumericDate (seconds since epoch). All request/response bodies are JSON (`application/json`).

## 0. Transport / auth
- Base URL: `AIDM_IDP_URL` (default `http://127.0.0.1:7443`).
- Every `/api/*` call from OtonomMCP carries `Authorization: Bearer <AIDM_IDP_CLIENT_TOKEN>`.
  The IdP MUST reject `/api/*` calls without the exact token (401) except the public-key endpoints.
- OtonomMCP never follows redirects from the IdP API.

## 1. Approval requests (aidm_autonomous_start)
`POST /api/approval-requests`
```json
{ "requestId": "<uuid v4, created by OtonomMCP>", "projectId": "...", "packageId": "pkg-autonomous-…",
  "revision": 1, "contextFingerprint": "<64 hex>", "specFingerprint": "<64 hex>",
  "directorSessionId": null, "taskId": null, "operation": "AUTONOMOUS_SPEC_RUN",
  "nonce": "<base64url, >=16 chars, single use>",
  "summary": { "projectName": "...", "specPath": "...", "budgetUsd": 5, "taskCount": 8,
               "allowedPaths": ["src", "tests"], "mandateHours": 8, "text": "<human readable>" },
  "requestedAt": "<ISO-8601>", "expiresAt": "<ISO-8601, <= requestedAt + 15 min>" }
```
→ `201 { "requestId", "status": "PENDING", "approvalUrl": "<absolute URL of the IdP approval page>" }`.
Duplicate `requestId` → `409`. IdP MUST mark the request `EXPIRED` after `expiresAt`.

`GET /api/approval-requests/:requestId`
→ `200 { "requestId", "status": "PENDING"|"APPROVED"|"REJECTED"|"EXPIRED", "token"?: "<JWS>", "reason"?: "..." }`
(`token` only when `APPROVED`; `reason` for REJECTED/EXPIRED). Unknown id → `404`.

`contextFingerprint` = sha256 hex of the canonical JSON (sorted keys) of
`{ operation, projectId, specFingerprint, packageId, revision, budgetUsd, allowedPaths, mandateHours, maxCyclesPerTask }`.
The IdP treats it as opaque but MUST display the summary to the human and echo the binding.

## 2. Decision requests (Director REQUEST_HUMAN_DECISION during a run)
`POST /api/decision-requests`
```json
{ "decisionId": "<uuid v4>", "projectId": "...", "runId": "run-…", "taskId": "TASK-…",
  "packageId": "<approval package id of the run>", "revision": 1, "operation": "AUTONOMOUS_DECISION",
  "contextFingerprint": "<64 hex>", "question": "...",
  "summary": "<optional: Director's reason, <= 4000 chars>",
  "options": [ { "id": "a", "label": "...", "description": "..." } ],   // 2..6 entries
  "allowFreeText": true, "recommendedOptionId": "a" | null,
  "nonce": "<>=16 chars>", "requestedAt": "<ISO>", "expiresAt": "<ISO, <= requestedAt + 15 min>" }
```
→ `201 { "decisionId", "status": "PENDING", "decisionUrl" }`.

`GET /api/decision-requests/:decisionId`
→ `200 { "decisionId", "status": "PENDING"|"ANSWERED"|"EXPIRED", "token"?: "<JWS>" }`.

Decision `contextFingerprint` = sha256 hex of canonical JSON
`{ projectId, runId, taskId, decisionId, question, options }`.

**v1.1 change (required by the OtonomMCP adapter):** `packageId`, `revision` and `operation`
(`AUTONOMOUS_DECISION`) are REQUIRED in the decision request and MUST be echoed as top-level
claims in the decision answer token. `OidcIdentityProviderAdapter` rejects any token whose
binding lacks `projectId`, `packageId`, `revision` or `contextFingerprint`. The earlier text
("decision token MUST NOT contain packageId/operation") is withdrawn. `reason` is not sent;
the Director's reason travels in the optional `summary` string.

## 3. Keys
- `GET /.well-known/jwks.json` → `{ "keys": [ { "kty":"EC","crv":"P-256","x":"…","y":"…","kid":"…","alg":"ES256","use":"sig" } ] }`
- `GET /api/public-key.pem` → SPKI PEM (`-----BEGIN PUBLIC KEY-----`). Both public, no bearer.
- Recommended for localhost: copy the PEM once and pin it via `AIDM_IDP_PUBLIC_KEY_FILE`.

## 4. Tokens (compact JWS)
Header: `{ "alg": "ES256", "typ": "JWT", "kid": "<kid>" }`. Signature: **raw R||S (64 bytes,
JWS standard / IEEE-P1363)**, base64url. (`none` and `HS*` are always rejected.)

Approval token claims (all required unless marked optional):
| claim | value |
|---|---|
| iss | `AIDM_IDP_ISSUER` (default `otonommcp-external-idp`) |
| aud | `AIDM_IDP_AUDIENCE` (default `otonommcp`) — string or array containing it |
| sub | IdP user id |
| actorRole | `PRODUCT_OWNER` |
| nonce | echo of the request nonce (single use; OtonomMCP stores it durably) |
| jti | unique id |
| iat, nbf, exp | NumericDate; `exp - iat <= 300` |
| requestId | echo |
| decision | `APPROVED` |
| amr | array containing `webauthn` |
| uv | `true` (WebAuthn user verification performed) |
| projectId, packageId, revision (number), contextFingerprint, operation | echo of the request (top-level) |
| directorSessionId, taskId | optional; if present must equal the request values (omit when request had null) |

Decision answer token claims: `iss, aud, sub, actorRole=PRODUCT_OWNER, nonce, jti, iat, nbf, exp (<=300s),
decisionId, selectedOptionId?, freeText? (<= 2000 chars; at least one of the two), projectId, packageId,
revision (number), operation=AUTONOMOUS_DECISION, runId, taskId, contextFingerprint, amr ['webauthn'], uv true`.
`selectedOptionId` must be one of the request option ids; `freeText` only when `allowFreeText`.
OtonomMCP verifies without consuming the nonce first, validates the answer, then consumes the nonce,
so a signed-but-invalid answer does not burn the decision. A replayed nonce ends the wait (FAILED).

Rejections produce no token. Clock skew tolerance on OtonomMCP side: 60 s.

## OtonomMCP implementation notes (feat/external-idp-approval)
- Verification: `createTrustedIdentityProvider()` (env factory) → `OidcIdentityProviderAdapter`; ES256 accepts
  raw P1363 (standard JWS) and legacy DER. Extra claims (`specFingerprint`, `preferred_username`) are ignored.
- Approval: the binding is persisted in `.ai-manager/state/external-approvals/<requestId>.json` BEFORE the POST.
  On resume the record is re-derived (contextFingerprint recomputed, spec file re-hashed, allowed paths re-read);
  any drift → `BINDING_MISMATCH`, nothing runs. The token is verified dry-run, then the mandate store re-verifies
  and consumes the nonce while sealing the mandate (authSource `EXTERNAL_IDP`). Single use via a `.claim` file.
- Approval tokens never contain `directorSessionId`/`taskId` (request sends null).
- Decisions: records in `.ai-manager/state/decisions/<decisionId>.json`; OtonomMCP polls every 3 s; TTL 15 min.
  A token can also be handed in via MCP `aidm_autonomous_resume { decisionId, token }`.
- **Open for the IdP side:** accept + echo `packageId`, `revision`, `operation` for decisions (v1.1 above);
  without it every decision answer fails closed (task stays BLOCKED_ON_HUMAN).
