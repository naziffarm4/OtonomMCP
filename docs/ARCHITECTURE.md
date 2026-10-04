# OtonomMCP (AIDM) — Mimari ve Sistem Tasarımı (ARCHITECTURE.md)

**Belge Kodu:** AIDM-DOC-ARCH  
**Sürüm:** 1.0.0  
**Tarih:** 2026-10-04  
**Kapsam:** OtonomMCP / AI Development Manager (AIDM) Çekirdek Mimarisi, Bileşen Hiyerarşisi, Veri Akışları ve Çalışma Zamanı Modeli

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
                                       │ MCP Araç Çağrıları (stdio)
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
│  │             DriverEngine & DriverRuntime (FSM Durum Makinesi)             │  │
│  └──────────────────────────────────────┬────────────────────────────────────┘  │
└─────────────────────────────────────────┼───────────────────────────────────────┘
                                          │ İzole CLI Komutu
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

## 2. Temel Çekirdek Bileşenler

| Modül Dizin | Temel Sınıflar / Servisler | Sorumluluk ve Mimari Rol |
|---|---|---|
| `packages/core/src/director-reasoning` | `DirectorReasoningEngine`<br>`DirectorPromptBuilder`<br>`DirectorResponseParser` | Context snapshot'ı önceliklendirilmiş bütçeye göre budar (P0..P4 pruning). LLM için yapılandırılmış prompt oluşturur. Model çıktısını Zod şemasıyla doğrular; sahte `actor: "USER"` yetki yükseltmelerini engeller. |
| `packages/core/src/llm-bridge` | `HttpLlmTransport`<br>`ReferenceLlmAdapter`<br>`TransportSecurityRegistry` | OpenAI Chat Completions ve referans protokol wire uyumluluğunu yönetir. Pre-dispatch rezervasyon başlığını ekler. Canlı ağ ve mock taşıyıcıları unforgeable sembollerle birbirinden yalıtır. |
| `packages/core/src/budget` | `BudgetManager`<br>`BudgetReservationEngine`<br>`ReconciliationEngine` | Nano-USD hassasiyetinde SQLite tabanlı atomik harcama kontrolü. İstek öncesi geçici hold rezervasyonu yapar; gerçek token telemetrisi geldikten sonra settlement veya rollback uygular. Overdraft'ı kesinlikle engeller. |
| `packages/core/src/director-action` | `DirectorActionBuilder`<br>`DirectorActionPipeline`<br>`DirectorActionDispatcher` | Director kararlarını tip güvenli eylem zarflarına (`DirectorActionEnvelope`) dönüştürür. Stale context kontrolü ve idempotency anahtarı üretir. |
| `packages/core/src/authorization` | `AuthorizationPolicyEngine`<br>`ProjectMandateStore` | Project Mandate kurallarına göre her eylem için `ALLOW`, `DENY` veya `REQUIRE_HUMAN_APPROVAL` kararı verir. Mandate revizyon takibi yapar. |
| `packages/core/src/execution-bridge` | `ExecutionBridge`<br>`ExecutorGuard` | Stage edilmiş eylemleri Driver'a devretmeden önce 6 katı güvenlik kontrolünden geçirir. İnsan onay kanıtı olmayan eylemleri fail-closed olarak `BLOCKED_ON_AUTH_CONTEXT` durumunda tutar. |
| `packages/core/src/driver` | `DriverEngine`<br>`DriverRuntime`<br>`DriverLock` | Görev yürütme durum makinesi (FSM). Tekil PID kilidi (`.ai-manager/runtime.lock`) ile çoklu süreç çakışmasını engeller. Adım adım yürütme sağlar. |
| `packages/core/src/director-loop` | `DirectorLoopEngine`<br>`DirectorLoopStore` | Kapalı döngü koordinatörü: `ingestInstruction` ➔ `executeCycle` ➔ `getCycleResult` ➔ `evaluateNextAction`. |
| `packages/core/src/evidence` | `EvidenceCollector`<br>`EvidenceValidator`<br>`FileHashCollector` | Uygulayıcının (AGY) sözel başarı beyanlarını reddeder. Değişen dosyaların SHA-256 hash'lerini, Git diff'ini ve bağımsız test çıkış kodlarını toplayarak doğrular. |
| `packages/core/src/storage` | `HistoryManager`<br>`DurableStateManager`<br>`AtomicWriter` | Değişmez (append-only) olay ve denetim günlüğü (`history.jsonl`). Durumların atomik diske yazımı ve crash recovery altyapısı. |
| `packages/core/src/mcp` | `McpServer`<br>`McpTransport` | stdio üzerinden JSON-RPC 2.0 araçlarını sunar. İsim normalizasyonu ve session yalıtımı uygular. |
| `packages/core/src/executor-bridge` | `AntigravityAdapter`<br>`NodeAntigravityProcessRunner` | Antigravity CLI'yı güvenli parametrelerle çocuk süreç olarak başlatır, çıktıları tamponlar ve timeout yönetir. |
| `packages/core/src/recovery` | `RecoveryEngine`<br>`FailureDiagnosisEngine` | Görev başarısızlıklarını sınıflandırır. Sınırlı ve döngüsel olmayan düzeltici görevler (bounded corrective tasks) önerir. |

---

## 3. Kapalı Döngü Veri Akışı (Closed-Loop Workflow)

1. **Talimat & Kontekst Senkronizasyonu:** Kullanıcı ChatGPT Director'a talimat verir. Director, MCP aracılığıyla AIDM context snapshot'ını alır.
2. **Muhakeme (Reasoning):** `DirectorReasoningEngine`, snapshot verisini bütçe kısıtlarına göre budar ve LLM'den karar üretir.
3. **Eylem Zarfı (Action Envelope):** Karar, `DirectorActionBuilder` tarafından benzersiz `actionId`, `idempotencyKey` ve `contextFingerprint` ile mühürlenir.
4. **Politika ve Kapsam Denetimi:** `AuthorizationPolicyEngine`, eylemi Project Mandate kurallarına göre değerlendirir:
   - `ALLOW`: Doğrudan yürütme kuyruğuna alınır.
   - `DENY`: Fail-closed iptal edilir, history günlüğüne işlenir.
   - `REQUIRE_HUMAN_APPROVAL`: Bağımsız güvenilir onay kanıtı yoksa `WAITING_FOR_TRUSTED_IDENTITY` durumunda bekletilir.
5. **ExecutionBridge Kapıları:** Yürütme öncesi 6 güvenlik kontrolü çalıştırılır (Context tazeliği, bütçe rezervasyonu, mandate uyumu, anti-spoofing).
6. **Driver ve Uygulayıcı Devri:** Eylem izole parametrelerle AGY CLI sürecine devredilir (`AntigravityAdapter`).
7. **Bağımsız Kanıt Doğrulama:** AGY işlemi tamamladığında `EvidenceCollector` devreye girer. Dosya bütünlüğü, Git durumu ve test sonuçları bağımsız doğrulanır.
8. **Durum Bütünleştirme ve Döngü Sonu:** Sonuçlar `DurableState` ve `HistoryManager`'a kaydedilir, Director döngüsü bir sonraki döngü için güncellenir.

---

## 4. Çalışma Zamanı Modeli ve Kısıtlar

1. **Tek Çalışma Ortamı:** AIDM, yalnızca Antigravity IDE içinde MCP eklentisi/aracı olarak çalışır. Harici bağımsız CLI modu veya ayrı arka plan servisi bulunmaz.
2. **Tek Windows Çalışma Alanı (Single Workspace):** Sistem, tek bir geliştirici makinesindeki tekil çalışma dizini için tasarlanmıştır. Eşzamanlı iki AIDM sürecinin aynı dizine yazması PID kilidiyle engellenir.
3. **Sıfır Dış Çalışma Bağımlılığı:** Çekirdek motorlar, harici veritabanı veya bulut servisi gerektirmez; yerel Node.js 18+ ve yerleşik SQLite altyapısıyla çalışır.
