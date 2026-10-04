# A — Mevcut Durum Denetimi (A_CURRENT_STATE_AUDIT)

**Denetim Tarihi:** 2026-10-04  
**Kapsam:** OtonomMCP / AIDM Çekirdeği, Güvenlik Sınırları, Mimari Bileşenler, Test Durumları ve Git Durumu  
**Amaç:** Proje A'nın mevcut gerçek durumunu kod, test, dokümantasyon ve Git kanıtlarıyla kesinleştirmek.

---

## 1. Başlangıç Git Durumu ve Doğrulama

Denetim başlangıcında depoda hiçbir yıkıcı işlem (`git reset`, `git checkout`, `git stash`, `git clean`) yapılmamış; branch değiştirilmemiş, commit/push atılmamış ve mevcut dirty/untracked dosyalar aynen korunmuştur.

### 1.1 Git Komut Çıktıları

```bash
$ git status --short --branch
## codespace-upgraded-xylophone-vg6756gx4g4cw779...origin/codespace-upgraded-xylophone-vg6756gx4g4cw779
 M OtonomMCP_Birlikte_Gelistirme_Plani.md
?? DIRECTOR-INTERACTION-01-FEASIBILITY-REPORT.md
?? DIRECTOR-INTERACTION-02-IDENTITY-SEPARATION-REPORT.md
?? OtonomMCP_A_B_Birlesik_Gelistirme_Yol_Haritasi.md
?? TRUST-ROOT-01-FEASIBILITY-REPORT.md
?? TRUST-ROOT-02-WINDOWS-HELLO-POC-REPORT.md
?? TRUST-ROOT-03-TPM-STRONG-KEY-POC-REPORT.md
?? TRUST-ROOT-04-SECURE-COMPANION-THREAT-MODEL.md
?? TRUST-ROOT-05-HUMAN-APPROVAL-ARCHITECTURE-DECISION.md
?? TRUST-ROOT-06-ADVERSARIAL-VALIDATION-REPORT.md
?? TRUST-ROOT-07-INDEPENDENT-APPROVAL-CHANNEL-REPORT.md
?? TRUST-ROOT-08-INDEPENDENT-APPROVAL-TRUST-BOUNDARY-PROOF.md
?? poc/

$ git branch --show-current
codespace-upgraded-xylophone-vg6756gx4g4cw779

$ git rev-parse HEAD
74c496172cc654da5f425f833201b0eea6617c0d

$ git log -10 --oneline
74c4961 fix(auth): resolve P22 regression test failures and preserve cryptographic security boundaries
744f2c2 feat(auth): P22 Trusted IDE Authentication with Ed25519 & DPAPI
97abb01 fix(p21): implement exhaustive security audit fixes for authorization policy
20346d7 feat(p21): implement Authorization Policy Engine and Project Mandate
b093081 docs(roadmap): track collaborative master development plan for OtonomMCP
1b5e00a feat(p20): implement execution bridge with fail-closed anti-spoof security controls
a97f4d1 feat(p19): implement director action protocol, pipeline, and dispatcher
7114870 feat(p18): implement HTTP LLM transport, Director reasoning engine, and token budget manager
862709e fix(storage): harden runtime state lock cleanup and multi-workspace options
ab03fbd fix(mcp): normalize tool names for Antigravity naming specification compliance

$ git diff --stat
 OtonomMCP_Birlikte_Gelistirme_Plani.md | 108 ++++++++++++++++++++++++++++++++-
 1 file changed, 106 insertions(+), 2 deletions(-)

$ git diff --cached --stat
(boş - staged değişiklik yok)
```

---

## 2. Resmi Belgeler ve Görev/Karar Kayıtları İncelemesi

- **`OtonomMCP_Birlikte_Gelistirme_Plani.md`:** Ana geliştirme planıdır. P18-00 mimari denetiminden P25 production hardening'e kadar tüm fazları, Ek A (token bütçesi/model seçimi), Ek B (tasarım kapıları), Ek C (bağlayıcı kararlar) ve Ek D (TRUST-ROOT ve Director-only etkileşimi) içerir.
- **`OtonomMCP_A_B_Birlesik_Gelistirme_Yol_Haritasi.md`:** Proje A ve Proje B ayrımını netleştiren, "Önce A, sonra B, ardından A+B entegrasyonu" kuralını koyan ana yol haritasıdır.
- **`.autoplans/`, `TASKS.md`, `PROGRESS.md`, `DECISIONS.md`:** Bu dosyalar mevcut repoda ayrı kök dosyaları olarak bulunmamaktadır; görev takibi, ilerleme ve bağlayıcı mimari kararlar doğrudan `OtonomMCP_Birlikte_Gelistirme_Plani.md` içindeki güncel durum bölümü, tablolar ve Ek A-D altında kayıt altına alınmıştır.
- **Araştırma Raporları (`TRUST-ROOT-01` .. `TRUST-ROOT-08` ve `DIRECTOR-INTERACTION-01` / `02`):** 
  - `TRUST-ROOT-01`: Aynı Windows kullanıcısı altında süreç izolasyonu sınırlarını belgeler.
  - `TRUST-ROOT-02` & `03`: Windows Hello ve TPM 2.0 CNG KSP donanım sınırlarını, kör imzalama (blind signing) problemini belgeler.
  - `TRUST-ROOT-04`: Secure Companion tehdit modelini belgeler.
  - `TRUST-ROOT-05` & `06`: AGY'nin aracı (courier) olduğu senaryoda soru tahrifatı ve onay aldatmacasını kanıtlar.
  - `TRUST-ROOT-07`: İki kanallı onay ve SAS sınırlamalarını belgeler.
  - `TRUST-ROOT-08`: IDE içi tam bağımsız onay mimarisinin imkansız olduğunu matematiksel ve mimari olarak kanıtlar (**KESİN NO-GO**). AGY'nin IDE içindeki tek kanal (in-band proxy) olması sebebiyle, bant dışı (out-of-band) bağımsız bir yerel Windows onay uygulaması (Proje B) olmadan Check 6'nın açılamayacağını ispatlar.

---

## 3. Mevcut Mimari Bileşenlerin Doğrulanması

Sistemde sıfırdan yeni motorlar yazılmasına gerek olup olmadığını belirlemek için mevcut bileşenler incelenmiştir:

| Bileşen | Kaynak Dosyaları | Sorumluluk | Bağlantılar | Test Dosyaları | Durum ve Kanıtlar | Eksik / Şüpheli Noktalar |
|---|---|---|---|---|---|---|
| **DirectorReasoningEngine** | `packages/core/src/director-reasoning/director-reasoning-engine.ts`, `director-prompt-builder.ts`, `director-response-parser.ts` | Context ve snapshot'tan prompt oluşturma, deterministik budama (pruning), LLM çağrısı, JSON yanıt ayrıştırma ve şema doğrulama. | `ILlmAdapter`, `TokenBudgetEngine`, `TransportSecurityRegistry` | `tests/director-reasoning.test.ts` | 63/63 test başarılı. Taşma koruması, Zod şema zorlaması ve sahte rol engelleme çalışıyor. | Harici gerçek API (OpenAI) ile canlı ağ testi opt-in olduğundan henüz çalıştırılmadı. |
| **LLM HTTP Bridge & Transport** | `packages/core/src/llm-bridge/http-llm-transport.ts`, `base-llm-adapter.ts`, `reference-llm-adapter.ts`, `transport-security-registry.ts` | Bearer token, correlation ID, timeout (AbortSignal), HTTP durum kodları eşlemesi ve token maskeleme ile HTTP taşıması. | `ILlmTransport`, `BudgetManager` | `tests/http-llm-transport.test.ts` | 18/18 test başarılı. Yerel HTTP soket üzerinden gerçek gidiş-dönüş, hata ve timeout kanıtlandı. | Canlı ücretli sağlayıcı uç noktası henüz test edilmedi (ücretsiz yerel HTTP fixture kullanıldı). |
| **BudgetManager & Reservation** | `packages/core/src/budget/budget-manager.ts`, `budget-database.ts`, `budget-reservation-engine.ts`, `reconciliation-engine.ts` | SQLite atomik veritabanı, pre-dispatch hold rezervasyonu, settlement, overdraft koruması, Nano-USD BigInt hesaplama. | `HistoryManager`, `BaseLlmAdapter` | `tests/budget-manager.test.ts`, `tests/budget-llm-integration.test.ts` | 53/53 test başarılı. Bütçe yetersizliğinde fail-closed, mükerrer idempotency, crash recovery tam. | Yok. Tamamlanmış ve kabul edilmiştir. |
| **DirectorActionBuilder / Validator / Dispatcher** | `packages/core/src/director-action/director-action-builder.ts`, `director-action-validator.ts`, `director-action-dispatcher.ts` | Eylem zarfı (envelope) üretimi, Zod doğrulama, context fingerprint ve mandate kapsam denetimi, execution staging. | `AuthorizationPolicyEngine`, `ProjectMandateStore`, `HistoryManager` | `tests/director-action-protocol.test.ts`, `tests/p19-02-*.test.ts`, `tests/p19-03-*.test.ts` | 48/48 test başarılı. Stale context engelleme, duplicate idempotency, yetkisiz eylemlerin PENDING_AUTHORIZATION'da tutulması kanıtlandı. | Yok. P19 tam olarak çalışmaktadır. |
| **AuthorizationPolicyEngine & ProjectMandateStore** | `packages/core/src/authorization/authorization-policy-engine.ts`, `project-mandate-store.ts` | ProjectMandate kurallarına göre ALLOW, DENY veya REQUIRE_HUMAN_APPROVAL kararları üretme, mandate revizyon kontrolü. | `DirectorActionDispatcher`, `ExecutionBridge`, `HistoryManager` | `tests/p21-authorization-policy.test.ts` | 25/25 test başarılı. Yıkıcı operasyonlar ve yetkisiz dizinler engelleniyor, Product Owner taklidi fail-closed reddediliyor. | Yok. P21 kabul edilmiştir. |
| **ExecutionBridge** | `packages/core/src/execution-bridge/execution-bridge.ts`, `execution-bridge-types.ts` | 6 güvenlik kontrolüyle stage edilmiş intent'leri Driver'a devretme; AGY timeout/unknown uzlaştırması. | `DriverEngine`, `AuthorizationPolicyEngine`, `BudgetManager`, `AuthContextValidator` | `tests/p20-01-execution-bridge.test.ts`, `tests/p20-01a-d.test.ts` | 55/55 test başarılı. Check 1-5 eksiksiz çalışıyor. Check 6 fail-closed olarak `BLOCKED_ON_AUTH_CONTEXT` veriyor. | Check 6, bağımsız güvenilir insan kimliği olmadan fail-closed beklemektedir (tasarım gereği doğru duruş). |
| **DriverEngine & DriverRuntime** | `packages/core/src/driver/driver-engine.ts`, `driver-runtime.ts`, `driver-lock.ts` | FSM görev yürütme durum makinesi, adım koordinasyonu, PID kilitlenme, duraklatma ve devam ettirme. | `AntigravityAdapter`, `EvidenceCollector`, `TaskDagEngine` | `tests/autonomous-driver.test.ts` | Temel FSM ve adım yönetimi kanıtlanmış. | A4 seviyesinde DirectorLoopEngine ve ExecutionBridge ile tek kesintisiz kapalı döngü entegrasyonu tamamlanmalıdır. |
| **DirectorLoopEngine** | `packages/core/src/director-loop/director-loop-engine.ts`, `director-loop-store.ts` | `ingestInstruction`, `executeCycle`, `getCycleResult`, `evaluateNextAction` döngüsü. | `DirectorReasoningEngine`, `DirectorActionDispatcher`, `DriverEngine` | `tests/director-executor-loop.test.ts` | Döngü mantığı mevcut. | P19/P20/P21 ile tam otomatik koordinasyon hattı A4'te kesinleştirilecektir. |
| **EvidenceCollector / Verifier** | `packages/core/src/evidence/evidence-collector.ts`, `evidence-validator.ts`, `file-hash-collector.ts` | Dosya hash (SHA-256), Git durumu ve test/build kanıtlarını bağımsız toplama ve doğrulama. | `EvidenceStore`, `ExecutionBridge` | `tests/evidence-collector.test.ts`, `tests/real-evidence-integration.test.ts` | Bağımsız kanıt doğrulama çalışıyor; AGY sözel beyanları reddediliyor. | Yok. Mevcut altyapı yeterlidir. |
| **HistoryManager** | `packages/core/src/storage/history-manager.ts` | Değişmez (immutable) append-only JSONL olay ve denetim kaydı. | Tüm bileşenler | `tests/storage.test.ts`, `tests/p19-03-hardening.test.ts` | Idempotency key commit denetimi ve olay serileştirme doğrulanmıştır. | Yok. Stabil. |
| **DurableStateManager & RuntimeState** | `packages/core/src/storage/durable-state.ts`, `runtime-state.ts`, `atomic-writer.ts` | Durumların atomik diske yazımı, PID tabanlı process lock (`.ai-manager/runtime.lock`). | Tüm CLI ve çekirdek servisler | `tests/storage.test.ts`, `tests/p19-03-hardening.test.ts` | Tekil instance koruması, zombie process engelleme, güvenli kapanma doğrulanmıştır. | Yok. İkinci bir DurableStateManager ihtiyacı yoktur. |
| **MCP Server & Stdio Transport** | `packages/core/src/mcp/mcp-server.ts`, `mcp-transport.ts`, `mcp-delegate.ts` | JSON-RPC stdio protokolü üzerinden araç sunumu, isim normalizasyonu, session izolasyonu. | MCP Tool sınıfları | `tests/p18-01-mcp-real-bootstrap.test.ts`, `tests/p18-02-target-project-binding.test.ts` | 7/7 ve 7/7 test başarılı. Harici süreçten stdio ile araç çağırma doğrulanmıştır. | Resmî P22 kapsamında Director için yüksek seviyeli kontrol araçları (A5) olarak finalize edilmelidir. |
| **AGY Process Runner** | `packages/core/src/executor-bridge/antigravity-process-runner.ts` | Antigravity CLI'yı çocuk süreç olarak başlatma, stdout/stderr tamponlama ve timeout yönetimi. | `DriverRuntime`, `ExecutionBridge` | `tests/antigravity-adapter-boundary.test.ts` | İzole süreç çalıştırma ve çıktı yakalama kanıtlanmıştır. | AGY'nin tek başına Product Owner olamaması kuralı ExecutionBridge tarafından korunmaktadır. |
| **Session & Recovery Bileşenleri** | `packages/core/src/director/director-session-engine.ts`, `packages/core/src/recovery/*` | Director oturum yönetimi, hata teşhisi, sınırlı retry ve düzeltici görev oluşturma. | `DirectorDecisionEngine`, `HistoryManager` | `tests/director-session.test.ts`, `tests/recovery.test.ts`, `tests/corrective-task-lineage.test.ts` | Oturum yaşam döngüsü ve lineage takibi doğrulanmıştır. | Süreç kesintisi sonrası in-flight AGY görevlerinin uzlaştırması A6'da netleştirilecektir. |

**Sonuç:** Sistemde yeni bir DriverEngine, DirectorLoopEngine, Task DAG, EvidenceCollector, DurableStateManager veya EventStore ihtiyacı YOKTUR. Mevcut çekirdek mimari tamdır ve yeniden kullanılmalıdır.

---

## 4. Önceki İş Paketlerinin Ayrı Ayrı Değerlendirilmesi

| İş Paketi | Durum | Kanıt Dosyaları ve Testler | Değerlendirme ve Bulgular |
|---|:---:|---|---|
| **P18-00** | `DONE` | `OtonomMCP_Birlikte_Gelistirme_Plani.md` (Ek A-D) | Mimari ve entegrasyon denetimi tamamlanmış, bağlayıcı kararlar plana işlenmiştir. |
| **P18-01** | `DONE` | `packages/core/tests/p18-01-mcp-real-bootstrap.test.ts` (7/7 test PASS)<br>`packages/core/tests/http-llm-transport.test.ts` (18/18 test PASS) | Gerçek stdio üzerinden MCP server bootstrap ve yerel HTTP soket üzerinden transport başarıyla kanıtlanmıştır. |
| **P18-02** | `PARTIAL` | `packages/core/tests/p18-02-target-project-binding.test.ts` (7/7 test PASS)<br>`packages/core/tests/director-reasoning.test.ts` (63/63 test PASS) | Hedef proje bağlama ve Director reasoning runtime mimarisi tamamdır. Ancak **gerçek harici LLM sağlayıcısı (OpenAI API vb.) ile canlı ağ çağrısı henüz yapılmamıştır**. Mock/local HTTP fixture gerçek provider testi değildir. Kullanıcı izinli canlı test yapılana kadar bu yönüyle `PARTIAL` kalmalıdır. |
| **P18-03** | `DONE` | `packages/core/tests/budget-manager.test.ts` (15/15 test PASS)<br>`packages/core/tests/budget-llm-integration.test.ts` (38/38 test PASS) | Persistent Token & Cost Budget sistemi eksiksiz çalışmaktadır. SQLite Nano-USD hesaplama, reservation ve reconciliation kanıtlanmıştır. Somut kusur olmadığından **yeniden açılmayacaktır**. |
| **P18-04** | `BLOCKED` | `packages/core/tests/p18-04-real-project-approval.test.ts` (9/9 test PASS)<br>`TRUST-ROOT-08-INDEPENDENT-APPROVAL-TRUST-BOUNDARY-PROOF.md` | Specification completeness gate ve onay gereksinimleri kanıtlanmıştır. Ancak bağımsız insan kimliği kökü bulunmadığı için gerçek insan onayı kapısı fail-closed olarak **BLOCKED** durumdadır. |
| **P19** | `DONE` | `packages/core/tests/director-action-protocol.test.ts`<br>`packages/core/tests/p19-02-director-action-pipeline.test.ts`<br>`packages/core/tests/p19-03-director-action-dispatcher.test.ts`<br>`packages/core/tests/p19-03-hardening.test.ts` (Toplam 48/48 test PASS) | Director Action Protocol, pipeline, dispatcher ve idempotency sertleştirmesi tamamlanmış ve kabul edilmiştir. Somut kusur bulunmadığından **yeniden açılmayacaktır**. |
| **P20-01 (ve P20-01A..D)** | `PARTIAL / BLOCKED_ON_AUTH_CONTEXT` | `packages/core/tests/p20-01-execution-bridge.test.ts`<br>`packages/core/tests/p20-01a-security-verification.test.ts`<br>`packages/core/tests/p20-01b-consistency-hardening.test.ts`<br>`packages/core/tests/p20-01c-trust-boundary.test.ts`<br>`packages/core/tests/p20-01d-anti-spoof.test.ts` (Toplam 55/55 test PASS) | ExecutionBridge 1-5 güvenlik kontrolleri tam çalışmaktadır. Check 6 fail-closed durumdadır. İstemci payload'ındaki sahte onaylar reddedilmektedir. Güvenilir onay gerektirmeyen işler geçebilirken, onay gerektirenler fail-closed beklemektedir. |
| **P21** | `DONE` | `packages/core/tests/p21-authorization-policy.test.ts` (25/25 test PASS) | AuthorizationPolicyEngine ve ProjectMandateStore tamamlanmış ve kabul edilmiştir. Somut kusur olmadığından **yeniden açılmayacaktır**. |

---

## 5. P22 Adlandırma Çakışmasının Çözümü

Git geçmişinde `744f2c2` nolu commit (`feat(auth): P22 Trusted IDE Authentication with Ed25519 & DPAPI`) ve `74c4961` nolu commit'te "P22" ismi Trusted IDE Authentication için kullanılmıştır.

**Düzeltme ve Hüküm:**
- Resmî ana geliştirme planında (`OtonomMCP_Birlikte_Gelistirme_Plani.md`, Satır 52 ve Satır 367):  
  **`P22 = Director MCP Control Plane`** (Faz 5 / A5).
- Trusted IDE Authentication ve güven kökü çalışmaları ise resmî planda P22 değil, bir araştırma/önkoşul hattıdır ve TRUST-ROOT-08 bulguları uyarınca gelecekteki **Proje B** kapsamına devredilmiştir.
- Bu iki kavram kesin olarak ayrılmıştır:
  - **P22 (Proje A kapsamı - A5):** Director MCP Control Plane (6-11 temel Director kontrol aracı, stdio transport, session/project isolation).
  - **Güven Kökü / Bağımsız Onay (Proje B kapsamı):** Harici Windows yerel onay uygulaması ve güvenli yerel IPC.

---

## 6. Güvenlik ve Onay Sınırları Durumu

Aşağıdaki güvenlik ilkeleri repoda doğrulanmış ve aynen korunmaktadır:
1. AGY tek başına `PRODUCT_OWNER` rolü veya insan onayı üretemez.
2. İstemci/model payload'ındaki `verified: true`, `isTrustedHumanAuth: true` veya `authStatus: VERIFIED_HUMAN` beyanları ExecutionBridge ve PolicyEngine tarafından doğrudan reddedilir.
3. AGY'nin kendi raporu bağımsız kanıt sayılmaz; dosya hash'i ve Git durumu EvidenceCollector tarafından bağımsız doğrulanır.
4. P20 Check 6 kapısı asla gevşetilmeyecek, mocklanmayacak veya bypass edilmeyecektir.
5. Trusted IDE Authentication araştırmaları Proje A içinde tamamlanmış sayılamaz (TRUST-ROOT-08 NO-GO kararı geçerlidir).
6. Proje B geliştirilmeden önce Proje A tamamlanacak ve kabul edilecektir.
