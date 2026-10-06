# OtonomMCP — MCP Modülü Teknik Şartnamesi (MCP Server)

**Modül Yolu:** `packages/core/src/mcp/`
**Protokol:** Model Context Protocol (MCP `2024-11-05`), JSON-RPC 2.0
**Amaç:** OtonomMCP çekirdeği için dış karar vericilere (ChatGPT Director) ve IDE istemcilerine standart JSON-RPC 2.0 kontrol arayüzü sunmak.

---

## 1. Mimari İlke: MCP İkinci Bir Orkestratör Değildir

MCP katmanı, AIDM Orkestrasyon Çekirdeği üzerinde yer alan bir **protokol adaptörü ve kontrol düzlemidir (Control Plane)**.

MCP Sunucusu kesinlikle:
- FSM durum makinesini doğrudan değiştiremez,
- `TaskDagEngine` kurallarını baypas edemez,
- `PolicyEngine` yetkilendirme denetimini atlatamaz,
- Uygulayıcının sözel başarı iddialarını delil kabul edemez,
- Doğrudan Git veya kabuk komutları çalıştıramaz,
- Kendi başına bağımsız bir görev planlayıcı veya yeniden deneme mekanizması işletemez.

Tüm işlemler, `McpOrchestratorDelegate` ve politika süzgeci üzerinden yetkili AIDM servislerine iletilir.

---

## 2. Desteklenen Taşıyıcılar (Transports)

MCP sunucusu taşıyıcıdan bağımsız (transport-agnostic) olarak tasarlanmıştır ve `McpTransport` arayüzünü uygular:

1. **`StdioMcpTransport`:** Antigravity IDE ile canlı entegrasyonda kullanılan, standart girdi/çıktı boruları üzerinden satır sonu ayrılmış JSON (`NDJSON`) framing taşıyıcısı.
2. **`StreamMcpTransport`:** Herhangi bir Node.js `Duplex` stream üzerinden NDJSON framing ile çalışan genel akış taşıyıcısı.
3. **`InMemoryMcpTransport`:** Birim testler, alt süreç döngüleri ve performans ölçümleri için sıfır maliyetli bellek içi süreç içi taşıyıcı.

---

## 3. İstek İzleme ve Bağlam (Request Correlation)

Her MCP isteği çekirdek motorlara iletilirken `McpRequestCorrelation` nesnesi ile izlenir (`packages/core/src/mcp/mcp-correlation.ts`):

- `correlationId`: AIDM günlük kaydı ve telemetri için benzersiz izleme kimliği (`aidm-corr-...`).
- `mcpRequestId`: İstemcinin JSON-RPC istek zarfındaki `id` değeri.
- `directorSessionId`: İlgili Director oturum kimliği.
- `projectId`: Çalışma alanı / proje kimliği.
- `taskId`: Hedef Task DAG görev kimliği.

---

## 4. Kayıtlı MCP Araçları

MCP sunucusu yapılandırılan modüllere göre aşağıdaki araçları kaydeder:

### 4.1. Sağlık ve Durum
- `aidm_health`: Sunucu çalışma durumu, orkestratör bağlantısı ve yetenekleri.
- `aidm_project_status`: Proje yaşam döngüsü durumu ve aktif faz.
- `aidm_project_requirements`: Kayıtlı gereksinimler listesi.
- `aidm_project_decisions`: Kayıtlı mimari kararlar.
- `aidm_tasks_list`: Task DAG görev listesi.
- `aidm_tasks_current`: Mevcut aktif veya yürütülmeye hazır görevler.
- `aidm_context_get`: Taze sistem context snapshot'ı ve parmak izi.
- `aidm_git_status`: Yerel Git durumu ve çalışma ağacı diff'i.

### 4.2. Keşif, Kapsam ve Şartname
- `aidm_project_discover`: Çalışma alanı keşfi başlatma.
- `aidm_specification_completeness_evaluate`: Şartname tamlık değerlendirmesi.
- `aidm_requirements_scope_define` / `aidm_requirements_scope_get`: Kapsam yönetimi.
- `aidm_architecture_technology_define` / `aidm_architecture_technology_get`: Mimari tanımları.
- `aidm_business-rules_define` / `aidm_business-rules_get`: İş kuralları.
- `aidm_acceptance-criteria_define` / `aidm_acceptance-criteria_get`: Kabul kriterleri.
- `aidm_risks_define` / `aidm_risks_get`: Risk tanımları.
- `aidm_project-spec_generate` / `aidm_project-spec_get`: Proje şartname projeksiyonu.

### 4.3. Onay Paketi Yönetimi
- `aidm_approval_package_create`: Yeni onay paketi üretimi.
- `aidm_approval_package_get`: Onay paketi sorgulama.
- `aidm_approval_package_readiness`: Onaya hazır olma kontrolü.
- `aidm_approval_package_approve`: Açık insan onayı kaydı (`ProjectApprovalRecord`).
- `aidm_approval_package_reject`: Açık ret kaydı (`ProjectRejectionRecord`).

### 4.4. Director Oturum ve Eylem Yönetimi
- `aidm_director_session_create` / `get` / `suspend` / `resume` / `close`: Director oturum yaşam döngüsü.
- `aidm_director_context_sync`: Context snapshot senkronizasyonu ve parmak izi mühürleme.
- `aidm_director_decision_create` / `validate` / `list`: Director kararlarının kaydedilmesi ve doğrulanması.

### 4.5. Yürütme ve Delil Doğrulama
- `aidm_execution_intent_validate`: İcra niyetinin 6 güvenlik kontrolünden geçirilmesi.
- `aidm_execution_request_build` / `aidm_execution_request_create`: İcra isteği oluşturma.
- `aidm_executor_execute`: Eylemi Driver ve uygulayıcıya devretme.
- `aidm_evidence_verify`: Eylem tamamlandığında bağımsız delilleri (`SystemExecutionEvidence`) doğrulama.

### 4.6. Kapalı Döngü ve Driver
- `director_ingestInstruction`: Kullanıcı doğal dil talimatı alma.
- `director_executeCycle`: Kapalı döngü adımı icra etme.
- `director_getCycleResult`: Döngü sonuçlarını alma.
- `driver_start` / `driver_status` / `driver_pause` / `driver_resume` / `driver_stop`: FSM durum makinesi sürücüsü.

---

## 5. Hata Normalizasyonu ve Güvenlik

Sunucu tüm hataları standart JSON-RPC 2.0 hata formatına ve makine kodlarına dönüştürür:

| JSON-RPC Kodu | Makine Kodu | Açıklama |
|---|---|---|
| `-32700` | `ERR_MCP_PARSE_ERROR` | Geçersiz veya bozuk JSON yükü. |
| `-32600` | `ERR_MCP_INVALID_REQUEST` | Eksik veya hatalı istek alanları. |
| `-32601` | `ERR_MCP_UNSUPPORTED_OPERATION` | Tanımsız metot veya araç. |
| `-32603` | `ERR_MCP_INTERNAL_FAILURE` | İç sistem hatası. |
| `-32001` | `ERR_MCP_ORCHESTRATOR_UNAVAILABLE` | Orkestratör erişilemez. |
| `-32002` | `ERR_MCP_POLICY_BLOCKED` | `PolicyEngine` tarafından reddedildi (`DENY`). |
| `-32003` | `ERR_MCP_HUMAN_BLOCKED` | Güvenilir insan onayı gerekiyor (`BLOCKED_ON_AUTH_CONTEXT`). |

Tüm hata yanıtları ve loglar, sırlar ve token'lardan deterministik regex ile arındırılır (`sanitizeSecrets`).
