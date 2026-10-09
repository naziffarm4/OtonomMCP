# OtonomMCP (AIDM) — Bağlayıcı Mimari Karar Kayıtları (DECISIONS.md)

**Belge Kodu:** AIDM-DOC-ADR
**Sürüm:** 1.2.0
**Tarih:** 2026-10-04
**Kapsam:** OtonomMCP Geliştirme Sürecinde Alınmış ve Halen Bağlayıcı Olan Temel Mimari Kararlar (ADR)

---

## Kesinleşmiş Mimari Kararlar

### ADR-01: Tek Director Otoritesi
- **Karar:** Kullanıcının doğal dil ile yazılım hedeflerini, geliştirme talimatlarını ve mimari yönelimini ileteceği tek planlama ve diyalog muhatabı ChatGPT Director'dır. AIDM çekirdeği veya uygulayıcı için IDE içinde ikinci bir sohbet penceresi, ayrı bir geliştirici arayüzü veya bağımsız interaktif CLI açılmayacaktır.
- **Gerekçe:** Kullanıcı kafa karışıklığını önlemek, karar hiyerarşisini korumak ve bant içi sahte yetki yükseltmelerini engellemek.
- **Etkisi:** AIDM, yalnızca Antigravity IDE içinde bir MCP sunucusu olarak çalışır.

---

### ADR-02: Tek Durum ve Task DAG Otoritesi
- **Karar:** AIDM Orkestrasyon Çekirdeği, projenin tek durum otoritesidir (Single State Authority). Görevler, bağımlılıklar ve durum geçişleri yalnızca `TaskDagEngine` ve FSM üzerinden yürütülür.
- **Gerekçe:** Birden fazla aktörün durum tanımlaması veya çakışan görev çizgesi üretmesini engellemek.
- **Etkisi:** Hiçbir dış aktör veya alt süreç görev durumunu doğrudan değiştiremez.

---

### ADR-03: MCP'nin İkinci Orkestratör Olmaması
- **Karar:** Model Context Protocol (MCP) katmanı, Orkestratör üzerinde yer alan bir protokol adaptörü ve kontrol düzlemidir (Control Plane).
- **Gerekçe:** MCP araçlarının kendi başına durum makinesi çalıştırmasını, FSM'i baypas etmesini veya bağımsız görev mantığı yürütmesini engellemek.
- **Etkisi:** Tüm araç çağrıları yetkilendirme süzgecinden ve çekirdek servis delegelerinden geçmek zorundadır.

---

### ADR-04: Tek Evidence Collector ve Sıfır Uygulayıcı Güveni (Zero Executor Trust)
- **Karar:** Uygulayıcının (AGY) sözel başarı beyanları (`"tamamlandı"`, `"testler geçti"` vb.) veya tek başına süreç çıkış kodları (`exitCode: 0`) başarı kanıtı sayılamaz. Görev tamamlanma kararı yalnızca bağımsız `EvidenceCollector` tarafından toplanan dosya SHA-256 hash'leri, Git diff ve bağımsız test çıkış kodlarıyla verilir.
- **Gerekçe:** Dil modellerinin halüsinasyon veya eksik icra riskine karşı objektif sistem doğrulaması sağlamak.
- **Etkisi:** Kanıt üretilmemişse eylem başarısız kabul edilir.

---

### ADR-05: Yerel SQLite Bütçe Yönetimi ve Nano-USD Hassasiyeti (OM-03 / P18-03)
- **Aşama:** OM-03 / P18-03 (Token & Cost Budget Management).
- **Karar:** Token harcama ve maliyet bütçesi yerel SQLite veritabanında `BigInt` (Nano-USD, $1 = 1.000.000.000 nUSD) cinsinden tutulacaktır. Her LLM çağrısından önce zorunlu `HOLD` rezervasyonu yapılacak, yanıt sonrası `SETTLE` edilecek; yetersiz bakiyede `BUDGET_EXCEEDED` hatasıyla çağrı fail-closed engellenecektir.
- **Gerekçe:** Kayan nokta (float) yuvarlama hatalarını önlemek ve modelin bütçeyi aşmasını kesin olarak durdurmak.
- **Etkisi:** Pre-dispatch hold rezervasyonu yapılmadan hiçbir ağ çağrısı gönderilemez. Atomik bütçe rezervasyonu ve harcama kontrolü garanti edilir.

---

### ADR-06: Fail-Closed Güvenlik ve Güvenilir İnsan Onayı Sınırı (OM-04 / P18-04 ve OM-05 / P20 Check 6)
- **Aşama:** OM-04 / P18-04 (Trusted Identity Context) ve OM-05 / P20 Check 6.
- **Karar:** Antigravity IDE içindeki sohbet veya istemci beyanları (`isTrustedHumanAuth: true`, `actor: "USER"`) güvenilir insan onayı kanıtı sayılamaz. Bağımsız ve güvenilir bir dış kimlik doğrulaması bulunmadığı sürece insan onayı gerektiren tüm işlemler fail-closed olarak `BLOCKED_ON_AUTH_CONTEXT` durumunda bekletilecektir.
- **Gerekçe:** Uygulayıcının aradaki bant içi proxy konumunda olması sebebiyle onay taklidini matematiksel olarak engellemek.
- **Etkisi:** P18-04 henüz tamamlanmamış olup, gerçek güvenilir insan kimliği doğrulaması sağlanana kadar fail-closed davranışı korunur; P20 Check 6 güvenlik kapısı kesin olarak kapalı tutulur.

---

### ADR-07: Tek Çalışma Alanı PID Kilitlenmesi ve Zombi Önleme
- **Karar:** `.ai-manager/runtime.lock` dosyası üzerinden PID tabanlı kilit uygulanacaktır. Canlı bir süreç varken ikinci bir instance başlatılamaz. Zombie process devralması (takeover) yapılmaz; kilit ancak sürecin işletim sistemi düzeyinde öldüğü (`process.kill(pid, 0)`) teyit edildikten sonra temizlenir.
- **Gerekçe:** Eşzamanlı iki AIDM sürecinin dosya sistemini ve SQLite bütçe tabanını bozmasını engellemek.
- **Etkisi:** Tekil çalışma alanı güvenliği garanti edilir.

---

### ADR-08: Sağlayıcıdan Bağımsız LLM Wire Formatı ve Telemetri Ayrıştırması
- **Karar:** `ReferenceLlmAdapter`, OpenAI Chat Completions API formatı ile iç referans formatını dinamik olarak yönetecektir. OpenAI uç noktasına kök düzeyinde fazlalık metaveri gönderilmeyecek; `prompt_tokens_details.cached_tokens` ve `completion_tokens_details.reasoning_tokens` alanları telemetriye dahil edilecektir.
- **Gerekçe:** Canlı LLM sağlayıcılarında HTTP 400 hatalarını önlemek ve muhakeme/önbellek maliyet uzlaştırmasını kuruşu kuruşuna doğru yapmak.
- **Etkisi:** Bütçe motoru gerçek harcanan token türlerini doğru fiyatlandırır.

---

### ADR-09: Rutin Mandate Görevlerinin Otonom Yürütülmesi
- **Karar:** Project Mandate kapsamındaki yetkilendirilmiş rutin geliştirme görevleri (`ALLOW`), harici onay gerekmeksizin tam otonom olarak icra edilmeye devam edecektir. Yalnızca korumalı eylemlerde fail-closed duruş uygulanır.
- **Gerekçe:** Rutin kod geliştirme ve test çalıştırma kabiliyetlerinin gereksiz yere kilitlenmesini önlemek.
- **Etkisi:** Otonom geliştirme döngüsü güvenli sınırlar içinde kesintisiz çalışır.

---

### ADR-10: Gerçek Provider ve Mock Taşıyıcı Ayrımı
- **Karar:** Otomatik birim ve entegrasyon testlerinde `InMemoryMcpTransport` ve mock LLM adaptörleri kullanılacaktır. Canlı ağ ortamında ise unforgeable güvenlik sembolleri ile yalıtılmış `HttpLlmTransport` ve `StdioMcpTransport` kullanılacaktır.
- **Gerekçe:** Testlerin deterministik, hızlı ve maliyetsiz çalışmasını sağlarken; üretim ortamında gerçek ağ güvenliği sınırlarını korumak.
- **Etkisi:** Test kodları ve üretim kodları arasında taşıyıcı sızıntısı engellenir.

---

### ADR-11: Commit ve Değişiklik Güvenliği
- **Karar:** Otonom eylemler yalnızca yerel çalışma ağacında adım adım yürütülür ve bağımsız delil denetimine tabi tutulur. Kontrolsüz veya otomatik `git push` ya da hedef dala körlemesine merge işlemleri yasaktır.
- **Gerekçe:** Geliştiricinin yerel Git deposunun ve uzak deposunun tahrif edilmesini önlemek.
- **Etkisi:** Değişiklikler yerel checkpoint'lerle izlenir ve güvenli sınırda tutulur.

---

### ADR-12: Modül Sahipliği, Çakışma Yönetimi ve Dışa Aktarma Politikası
- **Karar:**
  1. `src/budget/` (finansal Nano-USD bütçesi, SQLite defteri, faturalandırma uç nokta denetimi) ile `src/token-budget/` (LLM context window token bütçesi, P0-P4 öncelikli budama) iki bağımsız alt sistemdir ve kesinlikle birleştirilmeyecektir.
  2. `src/director/` (Director oturumu, insan onayı ve alan eylemleri) ile `src/director-action/` (tel protokolü zarfı `DirectorActionEnvelope`, Zod şeması ve dağıtım hattı) katman ayrımı korunacaktır.
  3. Kök `@aidm/core` paketinden içe aktarılan canonical `DirectorPromptBuilder`, `director-reasoning` modülünden sağlanır; runtime eylem istemi oluşturucu `DirectorActionPromptBuilder` olarak sunulur.
  4. `packages/core/package.json` içindeki `exports` haritası eksiksiz tutulacak; `./authorization` ve `./execution-integration` dahil tüm 32 alt sistem resmi subpath olarak korunacaktır.
- **Gerekçe:** Tek Sorumluluk İlkesi'ni korumak, kavram karmaşasını gidermek, kök dışa aktarım çakışmalarını derleme zamanında önlemek ve geriye dönük uyumluluğu %100 muhafaza etmek.
- **Etkisi:** Ayrıntılı mimari gerekçe, karşılaştırma matrisleri ve geçiş güvencesi `docs/ADR-12-MODULE-OWNERSHIP.md` dokümanında kayıt altına alınmıştır.

