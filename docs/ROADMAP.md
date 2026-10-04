# OtonomMCP (AIDM) — Resmî Tamamlama Yol Haritası (ROADMAP.md)

**Belge Kodu:** AIDM-DOC-ROADMAP
**Sürüm:** 1.2.0
**Tarih:** 2026-10-04
**Kapsam:** OtonomMCP / AI Development Manager (AIDM) Resmî Geliştirme Aşamaları, Bağımlılık Hiyerarşisi, Aşama Durumları ve Güvenlik Engelleri

---

## 1. Kritik Yol ve Bağımlılık Hiyerarşisi

Aşamalar kod mimarisi ve mantıksal önkoşullar doğrultusunda resmi faz adlandırmalarına göre sıralanmıştır:

```
[P18: Director Reasoning Runtime] ──► [P19: Structured Director Action Protocol]
                                                       │
                                                       ▼
[P20: Closed-loop Coordinator] ◄────── [P21: Autonomous Authorization Policy]
              │
              ▼
[P22: Director MCP Control Plane] ──► [P23: Durable Session & Recovery]
                                                       │
                                                       ▼
[P25: Production Hardening] ◄──────── [P24: Real End-to-End Validation]
```

---

## 2. Aşama Durumları ve İlerleme Tablosu

Durum değerleri:
- `DONE`: Kodlanmış ve otomatik testlerle doğrulanmış.
- `PARTIAL`: Kodlama veya modüler testleri kısmen tamamlanmış; canlı kabul veya kalan entegrasyon bekleyen.
- `BLOCKED`: Güvenlik engeli veya teknik bir bağımlılık sebebiyle ilerlemesi duraklatılmış.
- `NOT_STARTED`: Henüz başlanmamış.
- `VERIFIED_IN_PRODUCTION`: Canlı üretim ortamında gerçek harici servislerle uçtan uca kanıtlanmış.

| Faz Kodu | Faz Adı | Durum | Önkoşul | Kapsanan Bileşenler | Gerçek Durum ve Kabul Kriteri |
|:---:|---|:---:|:---:|---|---|
| **P18** | Director Reasoning Runtime | `PARTIAL` | — | `DirectorReasoningEngine`<br>`ReferenceLlmAdapter`<br>`HttpLlmTransport`<br>`BudgetManager` | **Kod Durumu:** OpenAI wire formatı, structured outputs (`json_schema`), usage token telemetrisi (reasoning/cached) kodlandı.<br>**P18-03:** Token & Cost Budget Management — SQLite Nano-USD atomik bütçe rezervasyonu ve harcama kontrolü kodlandı ve doğrulandı (10/10 PASS).<br>**P18-04:** Trusted Identity Context — güvenilir insan kimliği ve onay bağlamı; tamamlanmamıştır, fail-closed `BLOCKED_ON_AUTH_CONTEXT` sınırında korunmaktadır.<br>**Kalan İş:** Gerçek harici LLM sağlayıcısı ile canlı ücretli API çağrısı yapılmamıştır; canlı doğrulama P24'te gerçekleştirilecektir. |
| **P19** | Structured Director Action Protocol | `DONE` | P18 | `DirectorActionBuilder`<br>`DirectorActionDispatcher`<br>`DirectorActionPipeline`<br>`DirectorActionValidator` | **Kod Durumu:** Muhakeme çıktısını tip güvenli eylem zarflarına (`DirectorActionEnvelope`) dönüştürme, Zod şema doğrulaması, `contextFingerprint` ve idempotency mühürleme eksiksiz uygulandı.<br>**Test Durumu:** Otomatik entegrasyon testleri ile doğrulandı (PASS). |
| **P21** | Autonomous Authorization Policy | `DONE` | P19 | `AuthorizationPolicyEngine`<br>`ProjectMandateStore`<br>`AuthContextValidator` | **Kod Durumu:** Project Mandate kuralları (`ALLOW`, `DENY`, `REQUIRE_HUMAN_APPROVAL`), sahte yetki yükseltme engeli (`actor: "USER"`) ve mandata aykırı işlemlerin fail-closed reddi kodlandı.<br>**Güvenlik Engeli:** Bağımsız ve güvenilir bir dış insan kimlik kanıtı bulunmadığı sürece insan onayı gerektiren işlemler kesin olarak `BLOCKED_ON_AUTH_CONTEXT` durumunda duraklar. |
| **P20** | Closed-loop Coordinator | `PARTIAL` | P19, P21 | `ClosedLoopCoordinator`<br>`ExecutionBridge`<br>`DriverEngine`<br>`EvidenceCollector` | **Kod Durumu:** Kapalı döngü koordinatörü (`Director Loop ➔ Action ➔ Policy Gate ➔ Bridge ➔ Driver ➔ AGY ➔ Evidence ➔ Loop Refresh`) ve 6 pre-execution güvenlik kontrolü kodlandı.<br>**Test Durumu:** Modüler entegrasyon testleri (10/10 PASS) ile döngü adımları, timeout `EXECUTION_UNKNOWN` ve bounded recovery doğrulandı.<br>**Kalan İş:** Gerçek Antigravity IDE çalışma zamanında, canlı AGY CLI ikilisiyle uçtan uca döngü kabulü P24'te yapılacaktır. |
| **P22** | Director MCP Control Plane | `PARTIAL` | P20 | `McpServer`<br>`director-session-tools.ts`<br>`director-loop-tools.ts`<br>`driver-tools.ts` | **Açıklama:** P22 yalnızca Director MCP Control Plane anlamına gelir.<br>**Kod Durumu:** Director oturum ve döngü yönetimi araçları (`director_ingestInstruction`, `director_executeCycle`, `driver_start` vb.) stdio JSON-RPC 2.0 üzerinden sunuldu.<br>**Test Durumu:** MCP araç şemaları ve oturum yalıtım testleri kısmi olarak doğrulandı.<br>**Kalan İş:** Tam kontrol düzlemi uçtan uca akışı tamamlanacaktır. |
| **P23** | Durable Session & Recovery | `PARTIAL` | P20, P22 | `HistoryManager`<br>`DurableStateManager`<br>`RecoveryEngine`<br>`DriverLock` | **Kod Durumu:** Disk kalıcılığı (`history.jsonl`, `DurableStateManager`), PID kilit doğrulaması (`runtime.lock`), hata sınıflandırması ve bounded corrective task mekanizması kodlandı.<br>**Kalan İş:** Çökme sonrası in-flight işlemlerin `EXECUTION_UNKNOWN` olarak izole edilmesi ve zombi devralma olmaksızın tam toparlanma orkestrasyonu tamamlanacaktır. |
| **P24** | Real End-to-End Validation | `NOT_STARTED` | P18–P23 | E2E Entegre Test Süiti, Canlı IDE ve Model Testleri | Antigravity IDE içinde gerçek AGY CLI, gerçek LLM sağlayıcısı, bağımsız delil toplama ve hata toparlanma senaryolarının canlı ortamda uçtan uca kanıtlanması. |
| **P25** | Production Hardening | `NOT_STARTED` | P24 | Güvenlik sıkılaştırması, secret sanitization, paketleme ve sürümleme | Üretim seviyesinde güvenlik denetimi, telemetri optimizasyonu ve resmî sürümleme mühürlemesi. |

---

## 3. Korunan Güvenlik Engelleri (Safety Gates)

Aşağıdaki güvenlik engelleri mimarinin ayrılmaz parçasıdır ve hiçbir aşamada gevşetilemez:

1. **P18-03 Bütçe Kilidi:** SQLite veritabanında Nano-USD cinsinden atomik hold rezervasyonu yapılmadan hiçbir harcama gerektiren eylem gönderilemez.
2. **P18-04 ve P20 Check 6 Güvenilir İnsan Onayı Kilidi:**
   - **P18-04 Trusted Identity Context:** Güvenilir insan kimliği ve onay bağlamını ifade eder. P18-04 tamamlanmış değildir; gerçek güvenilir insan kimliği doğrulaması mevcut olmadığı sürece fail-closed davranışı korunur.
   - İnsan onayı gerektiren tüm eylemlerde sistem fail-closed olarak `BLOCKED_ON_AUTH_CONTEXT` durumunda bekler.
   - İstemci veya dil modeli tarafından üretilen sahte onay beyanları (`isTrustedHumanAuth: true`, `actor: "USER"`) kesinlikle reddedilir.
   - Project Mandate kapsamında yetkilendirilmiş rutin görevler (`ALLOW`) ise harici onay gerekmeksizin otonom yürütülür.
3. **Zero Executor Trust:** AGY uygulayıcısının sözel başarı beyanları kesinlikle delil sayılmaz; yalnızca `EvidenceCollector` tarafından toplanan bağımsız dosya SHA-256 hash'leri ve Git durumu başarı kanıtıdır.
