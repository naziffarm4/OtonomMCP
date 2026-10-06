# OtonomMCP (AIDM) — Mimari ve Sistem Tasarımı (ARCHITECTURE.md)

**Belge Kodu:** AIDM-DOC-ARCH
**Sürüm:** 1.2.0
**Tarih:** 2026-10-04
**Kapsam:** OtonomMCP / AI Development Manager (AIDM) Çekirdek Mimarisi, Bileşen Hiyerarşisi, Aktör İlişkileri, 4 Seviyeli Doğrulama Modeli ve Çalışma Zamanı Mimarisi

---

## 1. Sisteme Genel Bakış

OtonomMCP (AIDM), yazılım projelerinde otonom geliştirme döngüsünü (Director ↔ Orkestratör ↔ Uygulayıcı) güvenli sınırlar, deterministik bütçe kontrolleri ve bağımsız kanıt doğrulaması altında yöneten kurumsal düzeyde bir otonom proje yöneticisidir.

Sistem, Antigravity IDE çalışma ortamında yerel bir Model Context Protocol (MCP) sunucusu (`stdio` JSON-RPC 2.0) olarak çalışır. Harici bir web sunucusu, arka plan daemon'u veya ikinci bir kullanıcı arayüzü gerektirmez.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              KULLANICI (Product Owner)                          │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │ (Yalnızca Director ile etkileşim)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           CHATGPT DIRECTOR (Karar Verici)                       │
│                     (Doğal dil muhakemesi, görev tanımları)                     │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │ MCP Araç Çağrıları (stdio JSON-RPC 2.0)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    OTONOMMCP / AIDM ORCHESTRATION ÇEKİRDEĞİ                     │
│  ┌─────────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐  │
│  │ DirectorReasoningEngine │ │ AuthorizationPolicy  │ │ BudgetManager (Nano) │  │
│  │ (Context Pruning, Zod)  │ │ (ProjectMandate)     │ │ (SQLite Atomic Hold) │  │
│  └────────────┬────────────┘ └──────────┬───────────┘ └──────────┬───────────┘  │
│               │                         │                        │              │
│               ▼                         ▼                        ▼              │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │          ExecutionBridge (Fail-Closed Check 1..6 Güvenlik Kapıları)       │  │
│  └──────────────────────────────────────┬────────────────────────────────────┘  │
│                                         │ Güvenli Devir                         │
│                                         ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │      DriverEngine & ClosedLoopCoordinator (FSM Durum Makinesi / Döngü)    │  │
│  └──────────────────────────────────────┬────────────────────────────────────┘  │
└─────────────────────────────────────────┼───────────────────────────────────────┘
                                          │ İzole CLI Parametreleri
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                  UYGULAYICI: ANTIGRAVITY (AGY) CLI PROSESİ                      │
│                    (Dosya düzenleme, terminal komutları)                        │
└─────────────────────────────────────────┬───────────────────────────────────────┘
                                          │ Çıktı & Dosya Değişiklikleri
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│               BAĞIMSIZ DOĞRULAMA (EvidenceCollector & Git Observer)             │
│        (SHA-256 Dosya Hash'leri, Git Status, Test/Build Doğrulaması)            │
│                     *AGY Sözel Beyanları Asla Kabul Edilmez*                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Aktörler Arası İlişkiler ve Mimari Sorumluluk Dağılımı

Sistem içerisindeki 7 temel katmanın birbirleriyle olan ilişkileri ve yetki sınırları kesin çizgilerle tanımlanmıştır:

1. **Director (ChatGPT Director):**
   - Kullanıcının doğrudan doğal dil ile konuştuğu tek muhataptır.
   - Projenin hedeflerini, gereksinimlerini ve mimari yönelimini değerlendirir.
   - AIDM'den aldığı taze kontekst ile bir sonraki eyleme (`DirectorAction`) karar verir.
   - Kendisi doğrudan dosya yazamaz veya sistem komutu çalıştıramaz; taleplerini MCP üzerinden AIDM'e iletir.

2. **Orchestrator (AIDM Çekirdeği):**
   - Sistemin tek durum otoritesidir (State Authority).
   - Proje Mandate kurallarını, görev çizgesini (Task DAG), bütçe defterini (Nano-USD SQLite) ve olay geçmişini (`history.jsonl`) yönetir.
   - Director'dan gelen eylem taleplerini yetkilendirme süzgecinden geçirir; yetkisiz veya bütçesiz eylemleri engeller.

3. **MCP (Model Context Protocol Sunucusu):**
   - `stdio` üzerinden JSON-RPC 2.0 protokolü ile dış istemcilere ve Director'a sunulan kontrol düzlemidir.
   - İkinci bir orkestratör **değildir**; FSM durumunu doğrudan değiştiremez, kendi başına görev oluşturamaz veya politika kurallarını atlatamaz. Tüm çağrıları AIDM servislerine ve politika motoruna delege eder.

4. **AGY (Antigravity CLI Uygulayıcısı):**
   - Kod yazma, dosya düzenleme ve yerel komut çalıştırma işlerini yapan uygulayıcı işçidir.
   - Node.js `child_process` (`stdio`) üzerinden AIDM tarafından başlatılan yerel bir alt süreçtir.
   - **Child Process Sınırı ve Güvenlik İzolasyonu:** AGY'nin bir çocuk süreç olarak başlatılması işletim sistemi düzeyinde izole bir güvenlik sınırı (OS sandbox, AppContainer veya container) oluşturmaz. Windows NT DAC modelinde AGY, AIDM ve kullanıcıyla aynı User SID ve Medium Integrity Level altında çalışır. Dolayısıyla çocuk süreç sınırı yalnızca süreç yaşam döngüsü (PID, stdout/stderr tamponlama, timeout) yönetimi sağlar; ayrıcalıklı bir güvenlik izolasyonu sağlamaz.
   - Güvenlik kontrolü AGY sürecinin kısıtlanmasına değil; AIDM PolicyEngine ve ExecutionBridge kapılarının yetkisiz işlemleri engellemesine ve eylem sonrasında bağımsız `EvidenceCollector` denetimine dayanır.
   - Kendi durumunu "tamamlandı" olarak ilan etme yetkisi yoktur. Sözel başarı beyanları kesinlikle delil sayılmaz.

5. **Execution (ExecutionBridge, DriverEngine, ClosedLoopCoordinator):**
   - Görevlerin güvenli icrasını sağlayan yürütme katmanıdır.
   - `ExecutionBridge`: 6 katı güvenlik kontrolünü (Context tazeliği, bütçe hold rezervasyonu, mandate uyumu, sahte yetki kontrolü, anti-replay, dış onay kanıtı) uygular.
   - `DriverEngine`: Tekil PID kilidi (`.ai-manager/runtime.lock`) altında FSM durum makinesi geçişlerini yönetir.
   - `ClosedLoopCoordinator`: Director kararı ile AGY icrasını ve kanıt toplama döngüsünü koordine eder.

6. **Evidence (EvidenceCollector, FileHashCollector, Git Observer):**
   - AGY'nin çalıştığı dizindeki gerçek değişiklikleri işletim sistemi ve Git seviyesinde denetleyen tarafsız hakemdir.
   - SHA-256 dosya hash'leri, Git diff çıktıları, bağımsız test exit code'ları toplayarak `SystemExecutionEvidence` üretir.
   - AGY "başardım" dese bile bağımsız kanıt üretilmemişse eylem başarısız kabul edilir (Sıfır Uygulayıcı Güveni / Zero Executor Trust).

7. **Context Synchronization (DirectorContextSynchronizer):**
   - Sistem durumunun, görevlerin, bütçenin ve gereksinimlerin anlık görüntüsünü (snapshot) alır.
   - `contextFingerprint` üreterek kararların taze bağlam üzerinde alınmasını garanti eder; bayat kontekst ile gelen eylemleri fail-closed reddeder.

---

## 3. Doğrulama Düzeyleri ve Mimari Bileşen Durumu

Sistem bileşenlerinin ve iş akışlarının olgunluk seviyesi aşağıdaki **4 kesin kategoriye** ayrılarak değerlendirilir:

1. **Seviye 1 — Kaynak Kodda Uygulanmış (Implemented in Code):** Sınıf, metot, veri yapıları ve tip tanımları `packages/core/src/` altında eksiksiz olarak yazılmıştır.
2. **Seviye 2 — Otomatik Testlerle Doğrulanmış (Verified by Automated Tests):** Birim testler (unit tests) ve mock/in-memory nesnelerle çalışan modüler entegrasyon testleri (`packages/core/tests/`) ile iş mantığı ve durum geçişleri otomatik olarak test edilip onaylanmıştır.
3. **Seviye 3 — Gerçek IDE / Windows Ortamında Doğrulanmış (Verified in Real IDE / Windows Environment):** Windows işletim sisteminde yerel dosya sistemi, yerleşik SQLite, gerçek Git CLI ve Antigravity IDE stdio bağlantısı üzerinde doğrulanmıştır.
4. **Seviye 4 — Canlı Üretim Ortamında Doğrulanmış (Verified in Live Production):** Gerçek ücretli harici LLM sağlayıcısı API'si ve gerçek AGY CLI ile canlı ortamda uçtan uca çalıştırılarak kanıtlanmıştır.

> [!IMPORTANT]
> Birinci veya ikinci seviye kanıt (kod veya modüler test), üçüncü veya dördüncü seviye (canlı üretim) kanıt gibi sunulamaz.

### Bileşen Doğrulama Tablosu

| Bileşen | Kaynak Kod Konumu | Temel Sınıflar ve Fonksiyonlar | Doğrulama Düzeyi | Gerçek Durum ve Açıklama |
|---|---|---|:---:|---|
| **Director Reasoning Runtime (OM-03 / P18)** | `packages/core/src/director-reasoning/` | `DirectorReasoningEngine`<br>`DirectorPromptBuilder`<br>`DirectorResponseParser` | **Seviye 2** | Context snapshot budama (P0..P4) ve structured output (`json_schema`) testleri PASS. Canlı API çağrısı Seviye 4 kapsamında OM-09'da doğrulanacaktır. |
| **LLM Transport & Provider Adapter (OM-03)** | `packages/core/src/llm-bridge/` | `HttpLlmTransport`<br>`ReferenceLlmAdapter`<br>`TransportSecurityRegistry` | **Seviye 2** | OpenAI wire formatı, reasoning/cached token telemetrisi modüler testlerde PASS. Canlı ücretli ağ çağrısı henüz yapılmadı (OM-09). |
| **Token Budget Engine (OM-03 / P18-03)** | `packages/core/src/budget/` | `BudgetManager`<br>`BudgetDatabase`<br>`BudgetReservationEngine`<br>`ReconciliationEngine` | **Seviye 3** | P18-03 (Token & Cost Budget Management): Yerleşik SQLite `BigInt` Nano-USD atomik hold/settle mekanizması yerel Windows ortamında PASS. |
| **Director Action Protocol (OM-04 / P19)** | `packages/core/src/director-action/` | `DirectorActionBuilder`<br>`DirectorActionDispatcher`<br>`DirectorActionPipeline` | **Seviye 2** | `DirectorActionEnvelope`, tip denetimi, `contextFingerprint` ve idempotency testleri PASS. |
| **Authorization Policy (OM-04 / P21)** | `packages/core/src/authorization/` | `AuthorizationPolicyEngine`<br>`ProjectMandateStore`<br>`AuthContextValidator` | **Seviye 2** | Project Mandate kuralları (`ALLOW`, `DENY`, `REQUIRE_HUMAN_APPROVAL`), sahte yetki engeli PASS. P18-04 (Trusted Identity Context): Güvenilir dış insan kimliği olmadan fail-closed `BLOCKED_ON_AUTH_CONTEXT`. |
| **ClosedLoopCoordinator (OM-05 / P20)** | `packages/core/src/director-loop/` | `ClosedLoopCoordinator`<br>`DirectorLoopEngine`<br>`DirectorLoopStore` | **Seviye 2** | `Loop ➔ Action ➔ Policy ➔ Bridge ➔ Driver ➔ Evidence ➔ Refresh` akışı modüler entegrasyonda PASS (10/10 test). Gerçek IDE kabulü OM-09'da bekleniyor. |
| **ExecutionBridge (OM-05 / P20)** | `packages/core/src/execution-bridge/` | `ExecutionBridge`<br>`BridgeExecutionIntentZodSchema` | **Seviye 2** | 6 pre-execution güvenlik kontrolü, tekil icra iddiası (single execution claim), `EXECUTION_UNKNOWN` izolasyonu PASS. Check 6 fail-closed aktif. |
| **DriverEngine & Runtime (OM-05)** | `packages/core/src/driver/` | `DriverEngine`<br>`DriverRuntime`<br>`DriverLock` | **Seviye 3** | FSM durum makinesi, tekil PID kilitleme (`.ai-manager/runtime.lock`) ve canlı süreç kontrolü Windows üzerinde PASS. |
| **AntigravityAdapter (OM-05)** | `packages/core/src/executor-bridge/` | `AntigravityAdapter`<br>`AntigravityProcessRunner`<br>`ExecutorGuard` | **Seviye 2** | Alt süreç başlatma, argüman sanitization ve timeout mantığı mock testlerle PASS. Gerçek AGY CLI ikilisiyle canlı E2E kabulü OM-09'da bekleniyor. |
| **EvidenceCollector & Validator (OM-05)** | `packages/core/src/evidence/` | `EvidenceCollector`<br>`EvidenceValidator`<br>`FileHashCollector`<br>`SystemExecutionEvidence` | **Seviye 3** | Dosya SHA-256 hash'leri, Git diff ve bağımsız test çıkış kodu doğrulama Windows yerel dosya sisteminde PASS. |
| **MCP Server (OM-06 / P22)** | `packages/core/src/mcp/` | `McpServer`<br>`McpTransport`<br>`tools/` | **Seviye 3** | stdio JSON-RPC 2.0 sunucusu, araç kayıtları, session yalıtımı ve hata normalizasyonu Antigravity IDE stdio ortamında çalışır durumda. |
| **History & Durable State (OM-07 / P23)** | `packages/core/src/storage/` | `HistoryManager`<br>`DurableStateManager`<br>`AtomicWriter` | **Seviye 3** | Append-only `history.jsonl`, atomik durum yazımı ve çökme sonrası disk kurtarma Windows üzerinde PASS. |
| **Recovery Engine (OM-07 / P23)** | `packages/core/src/recovery/` | `RecoveryEngine`<br>`FailureDiagnosisEngine`<br>`RecoveryPolicyEngine` | **Seviye 2** | Görev hata sınıflandırması ve bounded corrective task mekanizması testlerle PASS. |
| **Context Synchronization (OM-03 / OM-04)** | `packages/core/src/director/` | `DirectorContextSynchronizer`<br>`director-context-types.ts` | **Seviye 2** | Snapshot çıkarma, fingerprint mühürleme ve bayat bağlam geçersiz kılma testlerle PASS. |

---

## 4. Kapalı Döngü Veri Akışı (Closed-Loop Workflow)

Kapalı döngü iş akışı, mimari olarak tasarlanmış, kodlanmış ve Seviye 2 modüler test süitleriyle doğrulanmıştır:

1. **Talimat & Kontekst Senkronizasyonu:** Kullanıcı ChatGPT Director'a doğal dilde talimat verir. Director, MCP aracılığıyla güncel context snapshot'ını alır (`DirectorContextSynchronizer`).
2. **Muhakeme (Reasoning):** `DirectorReasoningEngine`, snapshot verisini bütçe kısıtlarına göre budar ve LLM'den yapılandırılmış karar üretir.
3. **Eylem Zarfı (Action Envelope):** Karar, `DirectorActionBuilder` tarafından benzersiz `actionId`, `idempotencyKey` ve `contextFingerprint` ile mühürlenir.
4. **Politika ve Kapsam Denetimi:** `AuthorizationPolicyEngine`, eylemi Project Mandate kurallarına göre değerlendirir:
   - `ALLOW`: Doğrudan yürütme kuyruğuna alınır.
   - `DENY`: Fail-closed iptal edilir, `history.jsonl` günlüğüne işlenir.
   - `REQUIRE_HUMAN_APPROVAL`: Bağımsız güvenilir onay kanıtı yoksa `BLOCKED_ON_AUTH_CONTEXT` durumunda bekletilir.
5. **ExecutionBridge Kapıları:** Yürütme öncesi 6 güvenlik kontrolü çalıştırılır (Context tazeliği, bütçe hold rezervasyonu, mandate uyumu, sahte yetki kontrolü, anti-replay, dış onay kanıtı).
6. **Driver ve Uygulayıcı Devri:** Eylem güvenli parametrelerle AGY CLI sürecine devredilir (`AntigravityAdapter`).
7. **Bağımsız Kanıt Doğrulama:** AGY işlemi tamamladığında `EvidenceCollector` devreye girer. Dosya SHA-256 bütünlüğü, Git durumu ve test sonuçları bağımsız doğrulanır.
8. **Durum Bütünleştirme ve Döngü Sonu:** Sonuçlar `DurableStateManager` ve `HistoryManager`'a kaydedilir, Director döngüsü bir sonraki döngü için güncellenir.

---

## 5. Çalışma Zamanı Modeli ve Kısıtlar

1. **Operasyonel CLI ve MCP Sunucusu Mimarisi:**
   - **Operasyonel CLI Giriş Noktası:** `packages/core/bin/aidm.js` sistemin operasyonel CLI giriş noktasıdır. `aidm init`, `aidm status`, `aidm checkpoint`, `aidm driver`, `aidm run` ve `aidm mcp` komutlarını barındırır.
   - **İnteraktif Sohbet İstemcisi Değildir:** `aidm` interaktif bir doğal dil sohbet istemcisi veya terminal kabuğu değildir. Doğal dil etkileşimi, muhakeme ve kullanıcı iletişimi yalnızca ChatGPT Director tarafından yürütülür; Director ise sisteme MCP araçları üzerinden bağlanır.
   - **MCP Sunucusunu Başlatma:** Antigravity IDE ile entegrasyonu sağlayan authoritative stdio JSON-RPC 2.0 MCP sunucusunu başlatmak için `mcp` alt komutu gereklidir:
     ```bash
     node packages/core/bin/aidm.js mcp
     ```
   - **Antigravity IDE Yapılandırması:** Sistem Antigravity IDE'ye `mcp_config.json` üzerinden şu biçimde bağlanır:
     ```json
     {
       "mcpServers": {
         "OtonomMCP": {
           "command": "node",
           "args": [
             "packages/core/bin/aidm.js",
             "mcp"
           ],
           "env": {},
           "disabled": false,
           "disabledTools": []
         }
       }
     }
     ```
2. **Tek Windows Çalışma Alanı (Single Workspace):** Sistem, tek bir geliştirici makinesindeki tekil çalışma dizini için tasarlanmıştır. Eşzamanlı iki sürecin aynı dizine yazması PID kilidiyle (`.ai-manager/runtime.lock`) kesin olarak engellenir.
3. **Sıfır Dış Altyapı Bağımlılığı:** Çekirdek motorlar; harici veritabanı (PostgreSQL, Redis vb.), harici bulut servisi veya ağ soketi gerektirmez. Yerel Node.js 18+ ve yerleşik SQLite altyapısıyla çalışır.
4. **Fail-Closed İnsan Onayı Sınırı:** Güvenilir bir insan onay kanıtı bulunmadığında korumalı eylemler kesinlikle icra edilmez; sistem `BLOCKED_ON_AUTH_CONTEXT` durumunda güvenli şekilde bekler.
