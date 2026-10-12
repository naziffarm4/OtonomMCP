# Live instruction contract v1 (Nazif -> IdP -> OtonomMCP Director)

Purpose: while a run is active, Nazif writes an instruction in the IdP run monitor page ("Director'a talimat ver"), signs it with a passkey step-up (Windows Hello, UV required, challenge bound to the instructionId), and OtonomMCP delivers it to the Director as a binding Product Owner instruction. Only a verified ES256 token counts; monitor data never does.

## 1. OtonomMCP registers the channel (bearer client token)
PUT /api/runs/:runId/instruction-channel
{ runId, projectId (<=128), packageId (<=128), revision (int>=1), contextFingerprint (<=200), openedAt: ISO }
-> 200 { runId, open: true }
Re-PUT updates revision/contextFingerprint (e.g. after replan). DELETE /api/runs/:runId/instruction-channel closes it (run finished). UI shows the instruction form only when a channel is open and run status is not terminal.

## 2. Nazif creates an instruction in the UI (session + CSRF + passkey step-up bound to instructionId)
Fields: mode: 'NOTE' | 'PAUSE_AND_APPLY' | 'STOP'; text (1..2000 chars, required unless mode STOP where optional); optional taskId (<=128) to target.
IdP stores it as PENDING_DELIVERY and issues an ES256 token (same key/kid/iss/aud, header typ JWT), lifetime <= 15 min, claims:
iss, aud, sub, preferred_username, actorRole:'PRODUCT_OWNER', nonce (fresh, >=16), jti, iat, nbf, exp,
instructionId (uuid), runId, projectId, packageId, revision, contextFingerprint, operation:'AUTONOMOUS_INSTRUCTION',
mode, text, taskId?: string|null, amr:['webauthn'], uv:true

## 3. OtonomMCP polls (bearer)
GET /api/runs/:runId/instructions?status=PENDING_DELIVERY -> 200 { instructions: [ { instructionId, createdAt, mode, token } ] } (oldest first, max 20)
OtonomMCP verifies each token (signature, iss/aud, exp, uv, amr, nonce replay, runId/projectId/packageId match the channel, operation). Revision/contextFingerprint mismatch -> reject with reason (Nazif can resend).
POST /api/runs/:runId/instructions/:instructionId/ack { status: 'RECEIVED'|'APPLIED'|'REJECTED', note?: string(<=1000) } -> 200
States: PENDING_DELIVERY -> RECEIVED -> APPLIED | REJECTED; EXPIRED if not received before exp. Each instruction delivered/acked once (409 on invalid transition).
UI shows each instruction with its state and note in the run detail page and timeline.

## 4. OtonomMCP semantics
- Poll interval: AIDM_IDP_POLL_INTERVAL_MS (existing) or every cycle boundary, whichever first; only while a run is active.
- NOTE: appended to Director context as binding Product Owner guidance from the next Director call; run continues.
- PAUSE_AND_APPLY: finish the current AGY step (never kill mid-write unless STOP), pause dispatching, give the Director the instruction; Director may update/replan remaining tasks or add new tasks WITHIN the sealed mandate (allowed paths, budget cap, operation types). Then resume.
- STOP: stop gracefully after the current step; status STOPPED; report written; ack APPLIED.
- If following the instruction needs anything outside the mandate (new paths, budget increase, network, dependency install, policy change), the Director must NOT do it; runner opens an approval/decision request in the IdP for exactly that change (existing human-approval flow); without approval the instruction is ACKed REJECTED with the reason, or partially applied within scope with a note.
- Instruction text is data from the PO, never raises privileges by itself.
- Monitor events: INFO/REPLAN etc. with short message 'Talimat alındı/uygulandı/reddedildi'.

## IdP notes (IdP worker, implementation of v1)
- Implemented as specified: migration 4 (`instruction_channels`, `instructions`; `webauthn_challenges` rebuilt to add purpose `instruct` — only short-lived challenges are lost), bearer channel/poll/ack endpoints, UI form + list on `#/runs/:runId`.
- UI creation is two calls: `POST /api/ui/runs/:runId/instructions/options {mode,text,taskId?}` -> `{instructionId, options}` (validates, binds the draft + new instructionId to a single-use UV-required challenge), then `POST /api/ui/runs/:runId/instructions/:instructionId {assertion}`. The token content is the draft bound at options time.
- Token: exp - iat = 900 s, nbf = iat. `text` is `""` for STOP without text (never null/absent). `taskId` is always present (`null` if untargeted). revision/contextFingerprint/projectId/packageId are taken from the channel at signing time.
- `?status` on the poll accepts only `PENDING_DELIVERY` (other values 400; omitted = same). Polling does not change state; OtonomMCP's RECEIVED ack does.
- Transitions: PENDING_DELIVERY -> RECEIVED | REJECTED (REJECTED directly allowed so a token OtonomMCP refuses — e.g. revision mismatch — can be acked with a reason); RECEIVED -> APPLIED | REJECTED; everything else 409. EXPIRED applied lazily (on poll/ack/UI read) when exp passes before RECEIVED. Ack note <= 1000 chars, control chars rejected.
- Creation returns 409 CHANNEL_CLOSED if no open channel or run status terminal (checked at options time and again at submit).
- Tokens are never returned to the browser.
- Instructions are shown in their own list on the run detail page (state + note); they are not merged into the event timeline (OtonomMCP's 'Talimat alındı/uygulandı' monitor events appear there).
- **Interop finding (OtonomMCP side):** `InstructionChannel.verify` passes the token to `verifyIdpToken`, whose adapter treats the `taskId` claim as a task binding -> a targeted instruction (taskId set) is rejected `BINDING_MISMATCH: token bound to task 'TASK-002', expected '<none>'`. Per this contract taskId is the target, not a binding; OtonomMCP should ignore/strip taskId from binding checks for AUTONOMOUS_INSTRUCTION. Untargeted instructions verify fine (contract-check).
