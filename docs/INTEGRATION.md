# OtonomMCP (AIDM) — Entegrasyon ve MCP Sözleşmesi (INTEGRATION.md)

**Belge Kodu:** AIDM-DOC-INTEG
**Sürüm:** 1.2.0
**Tarih:** 2026-10-04
**Kapsam:** OtonomMCP / AIDM Model Context Protocol (MCP) JSON-RPC 2.0 Arayüzü, Gerçek Veri Şemaları, Araç Sözleşmeleri, Yetkilendirme Sınırları ve Hata Kodları

---

## 1. Protokol Genel Bakışı ve İletişim Modeli

OtonomMCP (AIDM), Antigravity IDE ve harici karar vericiler (ChatGPT Director) ile iletişimini **Model Context Protocol (MCP) `2024-11-05`** standardı ve **JSON-RPC 2.0** protokolü üzerinden yürütür.

- **Taşıyıcı (Transport):** Standart Girdi/Çıktı boruları (`stdio`) üzerinden satır sonu ayrılmış JSON (`NDJSON` framing) veya bellek içi test taşıyıcısı (`InMemoryMcpTransport`).
- **Giriş Noktası:** `node packages/core/bin/aidm.js mcp` (Operasyonel CLI üzerinden `mcp` alt komutu ile authoritative MCP sunucusu başlatılır).
- **Rolü:** MCP katmanı, AIDM Orkestratörü üzerinde bir kontrol düzlemidir (Control Plane). İkinci bir orkestratör değildir; doğrudan FSM durumunu değiştiremez veya yetkilendirme kurallarını atlatamaz.

### Standart JSON-RPC 2.0 İstek Zarfi
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "aidm_health",
    "arguments": {}
  }
}
```

---

## 2. İstek İzleme ve Bağlam Yönetimi (Request Correlation)

Her MCP isteği çekirdek motorlara iletilirken `McpRequestCorrelation` nesnesi ile izlenir (`packages/core/src/mcp/mcp-correlation.ts`):

| Alan | Tip | Açıklama |
|---|---|---|
| `correlationId` | `string` | Her istek için üretilen benzersiz AIDM denetim ve telemetri izleme kimliği (`aidm-corr-...`). |
| `mcpRequestId` | `string \| number` | İstemci JSON-RPC istek zarfındaki `id` değeri. |
| `projectId` | `string` (opsiyonel) | İşlemin ait olduğu çalışma alanı / proje kimliği. |
| `directorSessionId` | `string` (opsiyonel) | Etkin Director oturum kimliği. |
| `taskId` | `string` (opsiyonel) | İlgili Task DAG görev kimliği. |

---

## 3. Gerçek Kaynak Kod Domain Şemaları

OtonomMCP çekirdeğinde uygulanan ve Zod ile doğrulanan gerçek veri yapıları aşağıda belgelenmiştir:

### 3.1. Proje Onay Paketi (`ApprovalPackage`)
Kaynak: `packages/core/src/approval/approval-types.ts` (`ApprovalPackageZodSchema`)

Projenin anlaşılmasını, gereksinimlerini ve önerilen geliştirme planını donduran ve Product Owner onayına sunulan immutable veri paketidir:

```typescript
export interface ApprovalPackage {
  readonly packageId: string;
  readonly revision: number;
  readonly approvalPackageRevision?: number;
  readonly projectId: string;
  readonly projectUnderstanding: InitialProjectUnderstanding;
  readonly proposedDevelopmentPlan: ProposedDevelopmentPlan;
  readonly status: ProjectApprovalStatus; // 'NOT_READY' | 'READY_FOR_APPROVAL' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED' | 'STALE' | 'BLOCKED_ON_HUMAN'
  readonly specRevision?: number;
  readonly sourceBindings?: ApprovalSourceBindings;
  readonly completenessResult?: CompletenessGateResult;
  readonly approvalRecord?: ProjectApprovalRecord;
  readonly rejectionRecord?: ProjectRejectionRecord;
  readonly packageFingerprint?: string;
  readonly provenance?: ApprovalProvenance;
  readonly history?: readonly ApprovalHistoryEntry[];
  readonly isStale?: boolean;
  readonly staleReport?: ApprovalStaleReport;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

### 3.2. Proje Onay Kaydı (`ProjectApprovalRecord`)
Kaynak: `packages/core/src/approval/approval-types.ts` (`ProjectApprovalRecordZodSchema`)

Yetkili bir aktör tarafından verilen açık onayı temsil eder:

```typescript
export interface ProjectApprovalRecord {
  readonly packageId: string;
  readonly revision: number;
  readonly actor: string;
  readonly actorRole: 'PRODUCT_OWNER' | 'USER';
  readonly intent: 'EXPLICIT_APPROVAL';
  readonly comment?: string;
  readonly approvedAt: string;
  readonly packageHash: string;
  readonly directorSessionId?: string;
  readonly contextFingerprint?: string;
  readonly understandingRevision?: number | null;
  readonly isTrustedHumanAuth?: boolean;
  readonly authStatus?: 'VERIFIED_HUMAN' | 'UNVERIFIED_CLIENT_INPUT' | 'MOCK_TEST';
  readonly authContext?: {
    readonly isTrusted: boolean;
    readonly authSource?: string;
    readonly token?: string;
    readonly actorId?: string;
    readonly verifiedAt?: string;
  };
}
```

> [!WARNING]
> `actorRole` yalnızca `PRODUCT_OWNER` veya `USER` olabilir. `EXECUTOR`, `ANTIGRAVITY`, `DIRECTOR` veya `SYSTEM` aktörlerinin onay vermesi şema ve motor düzeyinde engellenmiştir.

### 3.3. Köprü Yürütme Amacı (`BridgeExecutionIntent`)
Kaynak: `packages/core/src/execution-bridge/execution-bridge-types.ts` (`BridgeExecutionIntentZodSchema`)

Bir görevin Driver ve AGY uygulayıcısına devredilmeden önce yetkilendirilmesini sağlayan mühürlü icra niyetidir:

```typescript
export interface BridgeExecutionIntent {
  readonly executionIntentId: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly directorSessionId: string;
  readonly taskId: string;
  readonly taskRevision?: number;
  readonly basedOnContextFingerprint: string;
  readonly understandingRevision: number;
  readonly authorizationReference: {
    readonly packageId?: string;
    readonly packageRevision: number;
    readonly isDevelopmentAuthorized: boolean;
    readonly authorizedAt?: string;
    readonly authorizedByRole?: 'PRODUCT_OWNER' | 'USER';
    readonly authContext?: {
      readonly verified: boolean;
      readonly authSource?: string;
      readonly token?: string;
      readonly actorId?: string;
      readonly verifiedAt?: string;
      readonly signature?: string;
      readonly nonce?: string;
    };
  };
  readonly createdAt: string;
  readonly executionPlan: string;
  readonly metadata?: Record<string, unknown>;
}
```

---

## 4. Kayıtlı MCP Araçları (MCP Tools)

Sunucu tarafından kaydedilen ve `stdio` üzerinden çağrılabilen temel araçlar şunlardır:

### 4.1. Durum ve Sağlık Araçları
- **`aidm_health`**: Sunucunun, FSM'in ve orkestratörün çalışma durumunu döner.
- **`aidm_project_status`**: Projenin güncel yaşam döngüsü durumunu (`lifecycleState`), aktif fazı ve varsa engelleyicileri döner.
- **`aidm_project_requirements`**: Kayıtlı proje gereksinimlerini listeler.
- **`aidm_project_decisions`**: Sistemde kayıtlı mimari kararları döner.
- **`aidm_tasks_list`**: Task DAG'daki görevleri, durumlarını ve bağımlılıklarını listeler.
- **`aidm_tasks_current`**: Şu an yürütülmekte olan veya yürütülmeye hazır sıradaki görevleri döner.
- **`aidm_context_get`**: Taze sistem bağlamını (snapshot) ve `contextFingerprint` değerini döner.
- **`aidm_git_status`**: Yerel çalışma alanının Git durumunu (değişen dosyalar, diff) döner.

### 4.2. Onay Paketi Yönetimi
- **`aidm_approval_package_create`**: Keşif ve gereksinim verilerinden yeni bir `ApprovalPackage` üretir.
- **`aidm_approval_package_get`**: Belirtilen `packageId` ve revizyona ait onay paketini getirir.
- **`aidm_approval_package_readiness`**: Paketin onaya hazır olup olmadığını (`ApprovalReadiness`) kontrol eder.
- **`aidm_approval_package_approve`**: Onay paketine açık `ProjectApprovalRecord` ekler.
- **`aidm_approval_package_reject`**: Paketi gerekçesiyle reddeder (`ProjectRejectionRecord`).

### 4.3. Director Oturumu ve Karar Araçları
- **`aidm_director_session_create` / `get` / `resume` / `close`**: Director oturum yaşam döngüsünü yönetir.
- **`aidm_director_context_sync`**: Sistem bağlamını Director ile senkronize eder ve parmak izini mühürler.
- **`aidm_director_decision_create`**: Director'ın yapılandırılmış eylem kararını sisteme kaydeder.
- **`aidm_director_decision_validate`**: Kararın şema ve bütçe kurallarına uygunluğunu doğrular.

### 4.4. Yürütme ve Köprü Araçları
- **`aidm_execution_intent_validate`**: Bir `BridgeExecutionIntent`'i 6 pre-execution güvenlik kontrolünden geçirir.
- **`aidm_execution_request_build`**: Yürütme talebini yapılandırır.
- **`aidm_executor_execute`**: Eylemi Driver ve AGY uygulayıcısına devreder.
- **`aidm_evidence_verify`**: Eylem tamamlandığında bağımsız delilleri (`SystemExecutionEvidence`) doğrular.

### 4.5. Kapalı Döngü ve Sürücü (Driver) Araçları
- **`director_ingestInstruction`**: Kullanıcıdan gelen doğal dil talimatını alır.
- **`director_executeCycle`**: Tek bir muhakeme, eylem, yetkilendirme ve yürütme döngüsünü çalıştırır.
- **`driver_start` / `driver_status` / `driver_pause` / `driver_resume` / `driver_stop`**: Durum makinesi sürücüsünü yönetir.

---

## 5. Yetkilendirme Sınırları ve İnsan Onayı

OtonomMCP'de yetkilendirme motoru (`AuthorizationPolicyEngine`) her eylem için üç sonuçtan birini üretir:

1. **`ALLOW`**: Project Mandate sınırları içindeki rutin geliştirme görevleri (dosya okuma/yazma, derleme, test çalıştırma). Bu görevler harici insan onayı gerekmeksizin tam otonom olarak icra edilir.
2. **`DENY`**: Proje hedeflerine veya güvenlik sınırlarına aykırı eylemler fail-closed olarak iptal edilir.
3. **`REQUIRE_HUMAN_APPROVAL`**: Güvenlik açısından kritik eylemler (politika değişikliği, bütçe tavanı aşımı vb.).

### Mevcut İnsan Onayı Güvenlik Sınırı
- OtonomMCP çekirdeğinde, bağımsız ve güvenilir bir bant dışı (out-of-band) insan kimlik doğrulama mekanizması henüz mevcut **değildir**.
- İstemci payload'ında veya model çıktısında yer alan `isTrustedHumanAuth: true`, `actor: "USER"` veya `authStatus: "VERIFIED_HUMAN"` gibi sözel beyanlar sıfır güven (zero-trust) ilkesi gereği **doğrudan reddedilir**.
- Bu nedenle, insan onayı gerektiren bir durum oluştuğunda OtonomMCP eylemi **kesin olarak engeller ve fail-closed olarak `BLOCKED_ON_AUTH_CONTEXT` durumunda bekletir**.

---

## 6. Hata Kodları

Standart JSON-RPC 2.0 ve OtonomMCP'ye özgü hata kodları (`packages/core/src/mcp/mcp-errors.ts`):

| JSON-RPC Kodu | Makine Kodu | Açıklama |
|---|---|---|
| `-32700` | `ERR_MCP_PARSE_ERROR` | Ayrıştırılamayan bozuk JSON yükü. |
| `-32600` | `ERR_MCP_INVALID_REQUEST` | Eksik veya geçersiz JSON-RPC alanları. |
| `-32601` | `ERR_MCP_UNSUPPORTED_OPERATION` | Bilinmeyen metot veya kayıtlı olmayan araç adı. |
| `-32603` | `ERR_MCP_INTERNAL_FAILURE` | Beklenmeyen iç sistem hatası. |
| `-32001` | `ERR_MCP_ORCHESTRATOR_UNAVAILABLE` | Orkestratör çevrimdışı veya başlatılamamış. |
| `-32002` | `ERR_MCP_POLICY_BLOCKED` | Eylem `PolicyEngine` tarafından reddedildi (`DENY`). |
| `-32003` | `ERR_MCP_HUMAN_BLOCKED` | Eylem güvenilir insan onayı gerektiriyor (`BLOCKED_ON_AUTH_CONTEXT`). |

Tüm hata yanıtlarında sırlar, token'lar ve özel anahtarlar deterministik regex ile arındırılır (`***REDACTED***`).

---

## 7. Yaşam Döngüsü ve İdempotency (Tekillik)

- **Tek Seferlik İcra (Single Execution Claim):** Her `BridgeExecutionIntent` yalnızca bir defa talep edilip çalıştırılabilir (`ExecutionBridgeStatus.EXECUTION_CLAIMED`). Mükerrer çağrılar atomik olarak engellenir.
- **İdempotency:** Her eylem benzersiz bir `idempotencyKey` taşır.
- **Sürümleme:**
  - MCP Protokol Sürümü: `2024-11-05`
  - Execution Bridge Protokol Sürümü: `P20-01`
  - Sunucu Temel Sürümü: `0.1.0`
