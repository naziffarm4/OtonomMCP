# OtonomMCP (Proje A) — Tamamlama Yol Haritası (ROADMAP.md)

**Belge Kodu:** AIDM-DOC-ROADMAP  
**Sürüm:** 1.0.0  
**Tarih:** 2026-10-04  
**Hedef:** Proje B (Bağımsız Onay Sistemi) geliştirilmesine başlanmadan önce, Proje A çekirdeğini güvenli sınırlar içinde çalışan, rutin işleri otonom yürütebilen, onay gerektiren işlerde fail-closed bekleyen eksiksiz bir orkestratör haline getirmek ve dondurmak (FROZEN).

---

## 1. Kritik Yol ve Bağımlılık Hiyerarşisi

Aşamalar kod bağımlılıkları ve mimari önkoşullar doğrultusunda sıralanmıştır:

```
[A1: Denetim & Kabul] ──► [A2: Reasoning Runtime] ──► [A3: Action & Policy Entegrasyonu]
                                                                  │
                                                                  ▼
[A6: Durable Session & Recovery] ◄── [A5: MCP Control Plane] ◄── [A4: Closed-loop Coordinator]
              │
              ▼
[A7: Gerçek Uçtan Uca Doğrulama] ──► [A8: Hardening, Release & A FROZEN]
```

---

## 2. Aşama Bazlı Durum ve İlerleme Tablosu

| Aşama | Kod / Adı | Durum | Önkoşul | Gerekli Bileşenler | Kabul Kriteri |
|:---:|---|:---:|:---:|---|---|
| **A1** | Mevcut Durum ve Kabul Denetimi | `DONE` | — | `docs/DECISIONS.md`, `docs/ARCHITECTURE.md` | Kod değiştirmeden durumun doğrulanması; P22 isim çakışmasının çözülmesi. |
| **A2** | Director Reasoning Runtime | `DONE`<br>*(Canlı Çağrı: `NOT_VERIFIED_IN_PROD`)* | A1 | `DirectorReasoningEngine`<br>`ReferenceLlmAdapter`<br>`HttpLlmTransport`<br>`BudgetManager` | OpenAI wire formatı, structured outputs (`json_schema`), usage token telemetrisi (prompt, completion, cached, reasoning) ve SQLite Nano-USD bütçe settlement hattı kanıtlandı (10/10 test PASS). Canlı ücretli API çağrısı kullanıcı maliyet onayı olmadan yapılmadı. |
| **A3** | Director Action Protocol & Authorization Policy Entegrasyonu | `PARTIAL` *(Sıradaki İş)* | A1, A2 | `DirectorActionBuilder`<br>`DirectorActionDispatcher`<br>`AuthorizationPolicyEngine`<br>`ProjectMandateStore` | Reasoning çıktısının doğrudan doğrulanmış `DirectorActionEnvelope`'a dönüştürülmesi; Mandate ihlallerinde fail-closed `DENY`; onay gereken işlerde `WAITING_FOR_TRUSTED_IDENTITY` fail-closed duruşu; sahte yetki beyanlarının (`actor: "USER"`) reddi. |
| **A4** | Closed-loop Coordinator | `PARTIAL` | A2, A3 | `ExecutionBridge`<br>`DriverEngine`<br>`DirectorLoopEngine`<br>`EvidenceCollector` | Kapalı döngünün (`Director Loop ➔ Action ➔ Bridge ➔ Driver ➔ AGY ➔ Evidence ➔ Loop Refresh`) tek bir koordinatör sınıfında birleştirilmesi. AGY beyanlarının bağımsız kanıtla doğrulanması; timeout/hata durumunda sınırlı düzeltici döngü. |
| **A5** | Director MCP Control Plane (Resmî P22) | `PARTIAL` | A4 | `McpServer`<br>`director-session-tools.ts`<br>`director-loop-tools.ts` | Director odaklı yüksek seviye MCP kontrol araçlarının (`aidm_director_open`, `aidm_director_context`, `aidm_director_act` vb.) stdio JSON-RPC 2.0 üzerinden tip güvenli ve oturum yalıtımlı olarak sunulması. |
| **A6** | Durable Session ve Crash Recovery (Resmî P23) | `PARTIAL` | A4, A5 | `HistoryManager`<br>`DurableStateManager`<br>`RecoveryEngine` | Süreç kesintisi veya çökme sonrası yeniden başlatmada, in-flight görevlerin tespit edilip `EXECUTION_UNKNOWN` olarak işaretlenmesi; durum uzlaştırması (`reconciliation`) ve zombie takeover olmadan güvenli PID kilit temizliği. |
| **A7** | Gerçek Uçtan Uca Doğrulama (Resmî P24) | `NOT_STARTED` | A1–A6 | E2E Entegre Test Süiti | Rutin görev tamamlama, kontrollü düzeltme, süre aşımı uzlaştırması, onay gereksiniminde fail-closed duruş ve kurtarma senaryolarının gerçek akışta kanıtlanması. |
| **A8** | Production Hardening, Release & Proje A Freeze (Resmî P25) | `NOT_STARTED` | A1–A7 | CLI & MCP Dağıtımı, Operasyon Belgeleri | Güvenlik sıkılaştırması, secret sanitization, Proje A'nın dondurulması (FROZEN) ve dış entegrasyon sözleşmesinin sürüm etiketlemesi. |

---

## 3. A8 Aşamasında Proje A Dondurma (FROZEN) Koşulları

Proje A kabul edildiğinde ve dondurulduğunda (FROZEN) aşağıdaki koşullar geçerlidir:

1. **Sürümlenmiş Dış Sözleşme Doğrulaması:** `docs/INTEGRATION.md` içinde tanımlanan sözleşme Semantic Versioning (v1.0.0) ile mühürlenecektir.
2. **Proje B Bağımsızlığı:** Gelecekte geliştirilecek Proje B (veya harici herhangi bir onay uygulaması), Proje A'nın iç TypeScript modüllerine veya kaynak koduna hiçbir şekilde bağımlı olmayacak; yalnızca yayınlanmış genel entegrasyon sözleşmesi (`ApprovalRequestPayload` ve `ApprovalResponsePayload`) üzerinden konuşacaktır.
3. **Release & Git Tag:** Proje A için resmî sürüm etiketi (`v1.0.0-frozen`) oluşturulacak ve kullanıcı kabulü tamamlanacaktır.
4. **Kod Dondurma İlkesi:** Proje B geliştirilirken Proje A'nın çekirdek kod tabanında sürekli refactoring, mimari değişiklik veya özellik eklemesi yapılmayacaktır.
5. **Kullanılabilirlik Garantisi:** Proje A'nın dondurulması sistemin kapatılması veya atıl kalması demek değildir; Proje A, kullanıcı projelerini otonom yönetmeye ve rutin geliştirme görevlerini yürütmeye kesintisiz olarak devam edecektir.
