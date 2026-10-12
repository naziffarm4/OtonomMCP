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

---

### ADR-13: Güvenilir Dış İnsan Kimliği ve Onay Sağlayıcısı Mimarisi (P18-04 / Trusted Identity Context)
- **Aşama:** OM-04 / P18-04 (Trusted Identity Context), ADR-06 ve OM-05 / P20 Check 6.
- **Karar:**
  1. İnsan onayı için gerçek dış kimlik sağlayıcısı sözleşmesi (`ITrustedIdentityProvider`) tanımlanmıştır. OIDC/WebAuthn ana dağıtık standart, mTLS kurumsal sıfır güven standardı olarak belirlenmiştir.
  2. Mevcut yerel DPAPI ve dosya tabanlı anahtar yöneticisi yalnızca `TestDoubleIdentityProviderAdapter` sınıfına atanmış olup üretim güvenlik kanıtı sayılamaz.
  3. Tüm onaylar `projectId`, `packageId`, `revision`, `contextFingerprint`, `operation` ve tek kullanımlık `nonce` ile zorunlu olarak bağlanır. Replay ve süresi dolmuş iddialar anında reddedilir.
  4. Sağlayıcı kesintisinde, eksik yapılandırmada veya doğrulama başarısızlığında fail-closed duruş (`BLOCKED_ON_AUTH_CONTEXT`) korunur.
  5. Gerçek dış IdP yapılandırması bağlanana kadar P18-04 tamamlanmış kabul edilmez, OM-09 genel kabulü verilmez ve OM-10 başlatılmaz.
- **Gerekçe:** Model veya istemci tarafından üretilen sahte onay alanlarının ayrıcalık yükseltme saldırılarını engellemek ve bağımsız bant dışı insan doğrulama sınırını güvenceye almak.
- **Etkisi:** Ayrıntılı mimari karşılaştırma ve adaptör sözleşmesi `docs/ADR-13-TRUSTED-IDENTITY-PROVIDER.md` dosyasında kayıt altına alınmıştır.

---

### ADR-14: Oturum Dosya Kotası Semantiği ve Net Değişen Benzersiz Dosya Sayımı
- **Aşama:** Revizyon 6 / AIDM-PLAN-REV6 (Kaynak Kotası ve Mutasyon Yönetimi).
> [!NOTE]
> **Revizyon Notu (2026-10-10):** Bu kararda yer alan "oturum başına 100 dosya" sayısal sınırı, ADR-16 ile yürürlükten kaldırılmıştır. Dosya bazlı SHA-256 baseline takibi, kanıt toplama ve kapsam denetimi kuralları ise ADR-16 altında korunmaktadır.
- **Karar:**
  1. Oturum başına 100 dosya sınırı (ADR-16 ile kaldırıldı), görev sonunda net değişen benzersiz dosya sayısı olarak tanımlanmıştır. Fiziksel yazma sayısı değildir; bir dosya değiştirilip eski hâline döndürülürse bu değişiklik tespit edilmeyebilir. `fs.watch` kesin güvenlik kanıtı değil, yardımcı telemetridir.
  2. Görev öncesinde `targetFiles` ve izin verilen kapsam (`packages` ve `docs`) doğrulanacaktır.
  3. Çalışma ağacı kapsam denetimi yalnızca hedef dosyaları değil, izin verilen kapsam (`packages` ve `docs`) dışındaki beklenmeyen tüm değişiklikleri kapsayacaktır. Symlink ve path traversal (`..`, mutlak yollar) riskleri kesin olarak reddedilir ve `SCOPE_VIOLATION` üretir.
  4. Görev öncesi ve sonrası dosya varlığı ve SHA-256 özetleri karşılaştırılacaktır (`preHash !== postHash`, yeni oluşturulan veya silinen). Değişen, oluşturulan veya silinen her benzersiz dosya tam bir kez (+1) sayılacaktır. Aynı görevde aynı dosyaya yapılan birden fazla değişiklik tek dosya olarak sayılacaktır.
  5. Önceden mevcut çalışma ağacı değişikliklerini yeni mutasyonlardan ayırmak için görev öncesi temel durum kaydı (Pre-Execution Baseline) oluşturulacaktır.
  6. İptal ve başarısız görevlerde disk üzerinde gerçekleşmiş net mutasyonlar varsa kanıt kaydına alınır.
- **Gerekçe:** Yanıltıcı fiziksel yazma iddialarından kaçınmak, çalışma ağacındaki mevcut değişiklikleri korumak ve matematiksel olarak kanıtlanabilir net kota denetimi sağlamak.
- **Etkisi:** `EvidenceCollector` net hash mutasyonlarını doğrular.

---

### ADR-15: Windows Süreç Ağacı Güvenliği, Bağımsız Doğrulama ve Fail-Closed İzolasyon Blokajı
- **Aşama:** Revizyon 6 / AIDM-PLAN-REV6 (Süreç Güvenliği ve İzolasyon).
- **Karar:**
  1. Zaman aşımı veya iptal durumunda `taskkill /PID <pid> /T /F` ile süreç ağacının sonlandırılması denenecektir; ancak bu komut tek başına mutlak izolasyon garantisi sayılmayacaktır.
  2. Süreç ağacının tamamen sonlandığı bağımsız biçimde işletim sistemi süreç tablosu üzerinden (`Win32_Process` / `tasklist`) doğrulanacaktır.
  3. Sonlandırma veya doğrulama belirsizliğinde sistem derhal `BLOCKED` durumuna geçecek ve blokaj nedeni `PROCESS_ISOLATION_UNCERTAINTY` olarak kaydedilecektir.
  4. **Yürütmenin Devam Şartı:** Yalnızca insan onayı yeterli değildir; işletim sistemi düzeyinde yetim/zombi alt süreç kalmadığı **bağımsız olarak yeniden doğrulanmadan** yürütme kesinlikle devam edemez (`DISPATCH_BLOCKED`). Blokaj otomatik yeniden deneme (auto-retry) ile aşılamaz.
  5. Mevcut CLI tabanlı yürütme mimarisi (`agy.exe`) korunacaktır.
- **Gerekçe:** Windows ortamında yetim kalan torun süreçlerin geç yazma (late write) yaparak çalışma ağacını bozmasını veya yetki sınırlarını aşmasını fail-closed duruşla engellemek.
- **Etkisi:** Süreç belirsizliği durumunda sistem insan kontrolüne ve yeniden izolasyon doğrulamasına devredilerek kilitlenir.

---

### ADR-16: Dönem Başına 10 USD Bütçe, 7 Günlük Mandate Geçerliliği ve Kotaların Kaldırılması
- **Aşama:** Revizyon 6 Nihai Kararlar (AIDM-PLAN-REV6-FINAL).
- **Tarih:** 2026-10-10.
- **Karar:**
  1. **Dönem Başına 10 USD Bütçe:** Her yeni ve açıkça yetkilendirilmiş bütçe dönemi için harcama tavanı 10 USD (`10_000_000_000n` nano-USD) olarak belirlenmiştir. Her bütçe dönemi için `budget.db` içinde ayrı kayıt tutulur. Önceki dönemlerin harcamaları, rezervasyonları ve denetim kayıtları korunur, asla silinmez veya sıfırlanmaz. Kullanılmamış bütçe sonraki döneme aktarılmaz. Bütçe tükenince yeni API harcamaları durur. Yeni dönem, gerçek yetkili insan onayı ve bütçe tahsisi tamamlanmadan başlayamaz. 10 USD, dönem başına tavan anlamına gelir; proje toplam harcaması zaman içinde 10 USD'yi aşabilir. Mükerrer tahsis ve yarış koşulları engellenir.
  2. **Mandate Başına En Fazla 7 Gün Geçerlilik:** Her mandate en fazla 7 günlük geçerlilik dönemine sahiptir. Süre dolduğunda mevcut mandate otomatik olarak uzatılmaz. Sonraki dönem için yeni geçerlilik aralığı, gerçek Ed25519 Trusted IDE imzası ve zorunlu insan yetkilendirmesi gerekir.
  3. **İki Bağımsız Yetkilendirme Kapısı:** Yeni bütçe tahsisi tek başına yürütme yetkisi vermez; yeni mandate tek başına bütçe yetkisi vermez. Bütçe ve mandate yenilemeleri birbirinden bağımsız doğrulanır; her iki koşul sağlanmadan yürütme başlamaz. Süre veya bütçe dolduğunda yenileme tamamlanana kadar yürütme kapalı kalır. Sahte imza, otomatik onay veya sessiz uzatma yasaktır.
  4. **Dosya ve Komut Kotalarının Kaldırılması:** Oturum başına 100 dosya ve 500 komut sınırları kaldırılmıştır. Görevler dosya sayısı veya komut adedi nedeniyle reddedilmeyecek veya durdurulmayacaktır.
  5. **Korunan Güvenlik Sınırları:** Dosya değişikliği kanıtı, SHA-256 pre/post temel durum kaydı, `packages` ve `docs` çalışma ağacı kapsam denetimi, symlink / traversal koruması ve komut güvenlik sınıflandırması aynen korunur. Yürütme yalnızca bütçe tükenmesi, mandate süresinin dolması, güvenlik ihlali veya süreç izolasyon belirsizliği (`PROCESS_ISOLATION_UNCERTAINTY`) nedeniyle durdurulabilir.
  6. **Korunan Sabitler:** İzinli dizinler (`packages` ve `docs`), 4 otomatik görev sınıfı (`ROUTINE_BUG_FIX`, `TEST_MODIFICATION`, `FEATURE_IMPLEMENTATION`, `REFACTORING`), `UNCLASSIFIED` fail-closed kuralı, yasaklı eylemler (`PUSH`, `RESET_HARD`, `PUBLISH`, `GIT_FORCE_PUSH`, `WORKSPACE_ESCAPE`, `BULK_DELETION`), Product Owner insan onayı, Ed25519 Trusted IDE imzası, `D:\ÇALIŞMALAR-D\OtonomMCP-External-IdP` izolasyonu ve CLI tabanlı yürütme mimarisi aynen korunur.
- **Gerekçe:** Proje toplam harcamasını ve uzun vadeli gelişimini tek bir 10 USD oturuma veya yapay 100 dosya / 500 komut sınırına sıkıştırmadan, her dönemi bağımsız insan onayı ve Ed25519 imzasıyla denetlenen güvenli bir periyodik yaşam döngüsü kurmak.
- **Etkisi:** Dosya ve komut kotaları kaldırılmış; bütçe ve yetki süreleri dönem bazlı bağımsız iki kapı olarak yapılandırılmıştır.

