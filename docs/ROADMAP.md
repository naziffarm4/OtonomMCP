# OtonomMCP — Tamamlama ve Dondurma Yol Haritası (ROADMAP.md)

**Belge Kodu:** AIDM-DOC-ROADMAP
**Sürüm:** 2.0.0
**Tarih:** 2026-10-05
**Kapsam:** OtonomMCP Tamamlama ve Dondurma Aşamaları (OM-01 – OM-10), Bağımlılık Hiyerarşisi, Doğrulama Düzeyleri, Çıkış Kriterleri ve Dondurma Koşulları

---

## 1. Kritik Yol ve Bağımlılık Hiyerarşisi

Aşamalar kod mimarisi, mantıksal önkoşullar ve bağımlılık hiyerarşisi doğrultusunda OM-01'den OM-10'a sıralanmıştır:

```
[OM-01: Kapsam & Git Güvenliği] ──► [OM-02: Mimari & Denetim] ──► [OM-03: Director Reasoning]
                                                                            │
                                                                            ▼
[OM-06: MCP Control Plane] ◄── [OM-05: Closed-loop Coordinator] ◄── [OM-04: Action & Policy]
              │
              ▼
[OM-07: Durable Session & Recovery] ──► [OM-08: Genel Entegrasyon] ──► [OM-09: Gerçek E2E Doğrulama]
                                                                                │
                                                                                ▼
                                                                     [OM-10: Sürümleme & Dondurma]
```

---

## 2. Aşama Durumları ve İlerleme Tablosu

Durum değerleri:
- `DONE`: Kodlanmış ve otomatik testlerle doğrulanmış.
- `PARTIAL`: Kodlama veya modüler testleri kısmen tamamlanmış; canlı kabul veya kalan entegrasyon bekleyen.
- `BLOCKED`: Güvenlik engeli veya teknik bir bağımlılık sebebiyle ilerlemesi duraklatılmış.
- `NOT_STARTED`: Henüz başlanmamış.
- `VERIFIED_IN_PRODUCTION`: Canlı üretim ortamında gerçek harici servislerle uçtan uca kanıtlanmış.

| Aşama Kodu | Aşama Adı | Durum | Önkoşul | Kapsanan Bileşenler | Gerçek Durum, Amaç ve Kabul / Çıkış Kriteri |
|:---:|---|:---:|:---:|---|---|
| **OM-01** | Kapsam, Git ve Mevcut Durum Güvenliği | `DONE` | — | Git çalışma alanı, branch ve commit geçmişi, test suite bütünlüğü, `.gitignore` ve çalışma alanı izolasyonu (`.ai-manager/runtime.lock`). | **Amaç:** Çalışma alanındaki Git durumunun, dalın ve commit geçmişinin korunması; test ve kaynak kod bütünlüğünün doğrulanması; istenmeyen dosyaların izole edilmesi.<br>**Çıkış Kriteri:** Bütünlük doğrulandı, 382 dosyalık CRLF satır sonu farkları ayıklandı, kaynak/test kodları ve commit geçmişi korundu. |
| **OM-02** | Mimari ve Uygulama Denetimi | `DONE` | OM-01 | `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, aktör sınırları, P22 MCP adlandırma netleştirmesi, 4 seviyeli doğrulama modeli. | **Amaç:** Mevcut kod tabanı ile mimari aktörlerin (Director, Orchestrator, MCP, Driver, AGY, Evidence) incelenmesi, P22 çakışmasının çözülmesi, Seviye 1–4 doğrulama seviyelerinin tesis edilmesi.<br>**Çıkış Kriteri:** Kod değiştirmeden durum doğrulandı; mimari kararlar ve doğrulama seviyeleri mühürlendi. |
| **OM-03** | Director Reasoning Runtime | `PARTIAL` | OM-02 | `DirectorReasoningEngine`<br>`ReferenceLlmAdapter`<br>`HttpLlmTransport`<br>`BudgetManager` | **Kod Durumu:** OpenAI wire formatı, structured outputs (`json_schema`), usage token telemetrisi (reasoning/cached) kodlandı.<br>**P18-03:** Token & Cost Budget Management — SQLite Nano-USD atomik bütçe rezervasyonu (`HOLD`) ve uzlaştırma (`SETTLE`) kontrolü kodlandı ve doğrulandı (10/10 test PASS).<br>**Kalan İş:** Gerçek harici LLM sağlayıcısı ile canlı ücretli API çağrısı yapılmamıştır; canlı doğrulama OM-09'da gerçekleştirilecektir. |
| **OM-04** | Action Protocol ve Authorization Policy | `DONE` | OM-02, OM-03 | `DirectorActionBuilder`<br>`DirectorActionDispatcher`<br>`DirectorActionPipeline`<br>`AuthorizationPolicyEngine`<br>`ProjectMandateStore` | **Kod Durumu:** Muhakeme çıktısını tip güvenli eylem zarflarına (`DirectorActionEnvelope`) dönüştürme, Zod şema doğrulaması, `contextFingerprint` ve idempotency mühürleme eksiksiz uygulandı.<br>**Güvenlik Sınırı:** Project Mandate kuralları (`ALLOW`, `DENY`), sahte yetki yükseltme engeli (`actor: "USER"`) ve fail-closed `BLOCKED_ON_AUTH_CONTEXT` (P18-04 / Check 6) entegrasyon testleriyle doğrulandı (PASS). |
| **OM-05** | Closed-loop Coordinator | `PARTIAL` | OM-03, OM-04 | `ClosedLoopCoordinator`<br>`ExecutionBridge`<br>`DriverEngine`<br>`EvidenceCollector` | **Kod Durumu:** Kapalı döngü koordinatörü (`Director Loop ➔ Action ➔ Policy Gate ➔ Bridge ➔ Driver ➔ AGY ➔ Evidence ➔ Loop Refresh`) ve 6 pre-execution güvenlik kontrolü kodlandı.<br>**Test Durumu:** Modüler entegrasyon testleri (10/10 PASS) ile döngü adımları, timeout `EXECUTION_UNKNOWN` ve bounded recovery doğrulandı.<br>**Kalan İş:** Gerçek Antigravity IDE çalışma zamanında, canlı AGY CLI ikilisiyle uçtan uca döngü kabulü OM-09'da yapılacaktır. |
| **OM-06** | Director MCP Control Plane | `PARTIAL` | OM-05 | `McpServer`<br>`director-session-tools.ts`<br>`director-loop-tools.ts`<br>`driver-tools.ts` | **Açıklama:** Resmî P22 yalnızca Director MCP Control Plane anlamına gelir.<br>**Kod Durumu:** Director oturum ve döngü yönetimi araçları (`director_ingestInstruction`, `director_executeCycle`, `driver_start` vb.) stdio JSON-RPC 2.0 üzerinden sunuldu.<br>**Test Durumu:** MCP araç şemaları ve oturum yalıtım testleri kısmi olarak doğrulandı.<br>**Kalan İş:** Tam kontrol düzlemi uçtan uca akışı tamamlanacaktır. |
| **OM-07** | Durable Session ve Recovery | `PARTIAL` | OM-05, OM-06 | `HistoryManager`<br>`DurableStateManager`<br>`RecoveryEngine`<br>`DriverLock` | **Kod Durumu:** Disk kalıcılığı (`history.jsonl`, `DurableStateManager`), PID kilit doğrulaması (`runtime.lock`), hata sınıflandırması ve bounded corrective task mekanizması kodlandı.<br>**Kalan İş:** Çökme sonrası in-flight işlemlerin `EXECUTION_UNKNOWN` olarak izole edilmesi ve zombi devralma olmaksızın tam toparlanma orkestrasyonu tamamlanacaktır. |
| **OM-08** | Genel Entegrasyon Hazırlığı ve Hata Kapatma | `DONE` | OM-05, OM-06, OM-07 | `docs/INTEGRATION.md`, genel stdio MCP JSON-RPC 2.0 arayüzü, domain veri tipleri (`ApprovalPackage`, `ProjectApprovalRecord`, `BridgeExecutionIntent`), standart hata kodları (`packages/core/src/mcp/mcp-errors.ts`), P33 MCP entegrasyon sözleşmesi sıkılaştırması, P34 Yetkilendirme Fail-Closed açıkları kapatılması. | **Amaç:** OtonomMCP'nin sunduğu yeniden kullanılabilir genel entegrasyon yüzeyinin sözleşmeye bağlanması, eksik araç ve tip tanımlarının giderilmesi, regresyon açıklarının ve bilinen kusurların kapatılması.<br>**Çıkış Kriteri:** P33 ile MCP entegrasyon sözleşmesi sıkılaştırıldı; P34 ile `REVIEW_EVIDENCE` için `evidenceStore` ve icra yetkilendirmesi için `SpecStore` otoriter bağımlılık zorunluluğu getirilerek fail-closed garantisi mühürlendi. |
| **OM-09** | Gerçek Uçtan Uca Doğrulama | `PARTIAL` | OM-03 – OM-08 | E2E Entegre Test Süiti, P35 OM-09 Canlı Hazırlık Denetimi (Readiness Audit), Canlı IDE ve Model Testleri | **Amaç:** Antigravity IDE içinde gerçek AGY CLI, gerçek LLM sağlayıcısı ile rutin görevlerin otonom icrası (`ALLOW`), kontrollü hata toparlanması, süre aşımı uzlaştırması, insan onayında fail-closed duruş (`BLOCKED_ON_AUTH_CONTEXT`) ve bağımsız delil denetiminin canlı ortamda uçtan uca kanıtlanması.<br>**P35 Denetim Durumu:** 23 bileşenin ve Git entegrasyonunun hazırlık matrisi tamamlandı. Deterministic Dry Run ve F01–F16 arıza matrisi (`packages/core/tests/p35-om09-readiness.test.ts`) eksiksiz doğrulandı (17/17 test PASS).<br>**Doğrulama Düzeyi:** `CODE VERIFIED` ve `TEST VERIFIED` sağlandı. Gerçek ücretli harici LLM ve gerçek AGY CLI henüz canlı çalıştırılmadığından `LIVE E2E VERIFIED` henüz verilmemiştir. İnsan onayı sınırı güvenilir dış kimlik kanıtı mekanizması mevcut olmadığından `BLOCKED_ON_AUTH_CONTEXT` olarak korunmaktadır. |
| **OM-10** | Sürümleme, Kabul ve Dondurma | `NOT_STARTED` | OM-01 – OM-09 | CLI & MCP Dağıtımı, Operasyon Belgeleri, Güvenlik Sıkılaştırması | **Amaç:** Güvenlik sıkılaştırması (hardening), secret sanitization, dokümantasyon mühürlemesi, Semantic Versioning (`v1.0.0`) etiketlemesi ve OtonomMCP çekirdeğinin dondurulması (FROZEN). |

---

## 3. Korunan Güvenlik Engelleri (Safety Gates)

Aşağıdaki güvenlik engelleri mimarinin ayrılmaz parçasıdır ve hiçbir aşamada gevşetilemez:

1. **P18-03 Bütçe Kilidi:** SQLite veritabanında Nano-USD cinsinden atomik hold rezervasyonu yapılmadan hiçbir harcama gerektiren eylem ağa gönderilemez.
2. **P18-04 ve P20 Check 6 Güvenilir İnsan Onayı Kilidi:**
   - **P18-04 Trusted Identity Context:** Güvenilir insan kimliği ve onay bağlamını ifade eder. P18-04 tamamlanmış değildir; gerçek güvenilir insan kimliği doğrulaması mevcut olmadığı sürece fail-closed davranışı korunur.
   - İnsan onayı gerektiren tüm eylemlerde sistem fail-closed olarak `BLOCKED_ON_AUTH_CONTEXT` durumunda bekler.
   - İstemci veya dil modeli tarafından üretilen sahte onay beyanları (`isTrustedHumanAuth: true`, `actor: "USER"`) kesinlikle reddedilir.
   - Project Mandate kapsamında yetkilendirilmiş rutin görevler (`ALLOW`) ise harici onay gerekmeksizin otonom yürütülür.
3. **Zero Executor Trust:** AGY uygulayıcısının sözel başarı beyanları kesinlikle delil sayılmaz; yalnızca `EvidenceCollector` tarafından toplanan bağımsız dosya SHA-256 hash'leri ve Git durumu başarı kanıtıdır.
4. **P34 Otoriter Bağımlılık Kilidi (Authoritative Dependency Fail-Closed Gate):**
   - `REVIEW_EVIDENCE` işleminde `evidenceStore` bulunmadığında, delil doğrulanamadığında veya sonuç belirsiz (`UNKNOWN`) olduğunda fail-closed (`DENY`) durulur; asla `ALLOW` verilmez.
   - Görev yürütme yetkilendirmesinde `taskClass` yalnızca otoriter `SpecStore`'dan çözülür; `SpecStore` eksikliğinde veya çözülemeyen görev sınıfında varsayılan `'IMPLEMENTATION'` fallback'i asla kullanılmaz, sistem fail-closed (`DENY`) durur.

---

## 4. OM-10 Aşamasında OtonomMCP Dondurma (FROZEN) Koşulları

OtonomMCP kabul edildiğinde ve dondurulduğunda (FROZEN) aşağıdaki koşullar geçerlidir:

1. **Sürümlenmiş Genel Entegrasyon Sözleşmesi:** `docs/INTEGRATION.md` içinde tanımlanan genel sözleşme Semantic Versioning (v1.0.0) ile mühürlenecektir.
2. **Dış Entegrasyon Bağımsızlığı:** Harici karar vericiler veya onay araçları, OtonomMCP'nin iç TypeScript modüllerine veya kaynak koduna hiçbir şekilde bağımlı olmayacak; yalnızca yayınlanmış genel MCP arayüzü ve domain veri şemaları üzerinden konuşacaktır.
3. **Release & Git Tag:** OtonomMCP için resmî sürüm etiketi (`v1.0.0`) oluşturulacak ve kullanıcı kabulü tamamlanacaktır.
4. **Kod Dondurma İlkesi:** Dondurma sonrasında OtonomMCP'nin çekirdek kod tabanında sürekli refactoring, mimari değişiklik veya plansız özellik eklemesi yapılmayacaktır.
5. **Kullanılabilirlik Garantisi:** OtonomMCP'nin dondurulması sistemin kapatılması veya atıl kalması demek değildir; OtonomMCP, kullanıcı projelerini otonom yönetmeye ve yetkilendirilmiş rutin geliştirme görevlerini yürütmeye kesintisiz olarak devam edecektir.
