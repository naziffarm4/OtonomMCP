# OtonomMCP Revizyon 6 — Nihai Teknik Plan

**Belge Kodu:** AIDM-PLAN-REV6-FINAL  
**Tarih:** 2026-10-10  
**Kapsam:** Dönem Başına 10 USD Bütçe, 7 Günlük Mandate Yetkisi, Dosya/Komut Kotalarının Kaldırılması, Kapsam Denetimi ve Windows Süreç Güvenliği  
**Durum:** Dokümantasyon Tamamlandı / Uygulama Yetkisi Verilmedi (`DOCUMENTATION_COMPLETE_IMPLEMENTATION_NOT_AUTHORIZED`)

---

## 1. Yönetici Özeti ve Amaç

Bu belge, Product Owner'ın nihai bağlayıcı kararları doğrultusunda güncellenmiş kesin Revizyon 6 teknik planıdır. Belgenin amacı:
1. Bütçe politikasını **her yetkilendirilmiş dönem başına 10 USD** tavan olarak yapılandırmak ve geçmiş dönem harcamalarının kalıcı kaydını korumak,
2. Yetki politikasını **mandate başına en fazla 7 günlük geçerlilik** süresi olarak belirlemek ve bütçe ile mandate yenilemelerini birbirinden bağımsız iki güvenlik kapısı hâline getirmek,
3. Oturum başına 100 dosya ve 500 komut adet sınırlarını kaldırarak görevlerin bu sayılar nedeniyle reddedilmesini veya durdurulmasını önlemek; buna karşılık dosya mutasyon kanıtı, SHA-256 temel durum kaydı, çalışma ağacı kapsam denetimi ve komut sınıflandırmasını eksiksiz korumak,
4. Windows süreç ağacı sonlandırma ve bağımsız doğrulama protokolünü fail-closed `PROCESS_ISOLATION_UNCERTAINTY` mimarisi ve iki kademeli kilit açma şartıyla güvenceye almak,
5. Sabit sınırları koruyarak test edilebilir kabul kriterlerini belirlemek ve henüz yazılmamış testleri `UYGULANMADI` olarak işaretlemektir.

> [!IMPORTANT]
> **Kesin İşlem Sınırı:**  
> Bu belge bir **uygulama veya otonom yürütme onayı değildir**. Kaynak kod, test dosyaları, veritabanları, çalışma zamanı kilitleri değiştirilmemiştir. Gerçek mandate, imza, onay veya bütçe kaydı üretilmemiştir.

---

## 2. Etiketleme Metodolojisi

Plan içerisindeki her teknik madde aşağıdaki üç kategoriden biriyle açıkça etiketlenmiştir:
- **[Mevcut Kodla Doğrulandı]**: Mevcut depodaki kaynak kod ve testlerle varlığı ve davranışı teyit edilmiş özellikler.
- **[Uygulanmamış Tasarım]**: Mimarisi ve sözleşmesi belirlenmiş ancak henüz kodu yazılmamış yeni tasarımlar.
- **[Çözülemeyen Risk]**: İşletim sistemi veya mevcut CLI kısıtları nedeniyle tamamen ortadan kaldırılamayan, fail-closed kurallarla sınırlandırılan riskler.

---

## 3. Bütçe Politikası (Dönem Başına 10 USD)

### 3.1 Bütçe Kuralları ve Dönem Ayrımı
* **[Uygulanmamış Tasarım]**: **Dönem Başına 10 USD Tavan:**  
  Her yeni ve açıkça yetkilendirilmiş bütçe dönemi için harcama tavanı 10 USD (`10_000_000_000n` nano-USD, `budget.db`) olarak tahsis edilir.
* **[Uygulanmamış Tasarım]**: **Ayrı Dönem Kayıtları ve Geçmişin Korunması:**  
  Her bütçe dönemi için SQLite veritabanında ayrı dönem kimliği (`budget_period_id`) ile kayıt tutulur. Önceki dönemlerin harcamaları, `HOLD` rezervasyonları, kesinleşmiş `SETTLE` işlemleri ve denetim kayıtları korunur; asla sıfırlanmaz veya silinmez.
* **[Uygulanmamış Tasarım]**: **Aktarım Yapılmaması:**  
  Kullanılmamış bütçe, açıkça tanımlanmış bir politika olmadıkça sonraki döneme aktarılmaz.
* **[Uygulanmamış Tasarım]**: **Bütçe Tükenme Davranışı:**  
  Dönem bütçesi tükendiğinde (`BUDGET_EXCEEDED`) tüm yeni LLM ve API harcamaları fail-closed durur. Yeni dönem, gerçek yetkili insan onayı ve yeni bütçe tahsisi tamamlanmadan kesinlikle başlayamaz.
* **[Uygulanmamış Tasarım]**: **Kümülatif Harcama Esnekliği:**  
  10 USD, *dönem başına tavan* anlamına gelir. Proje toplam harcaması zaman içinde birden fazla yetkilendirilmiş dönem boyunca 10 USD'yi aşabilir.
* **[Uygulanmamış Tasarım]**: **Mükerrerlik ve Yarış Koşulu Koruması:**  
  SQLite `BEGIN IMMEDIATE` transaction'ı ve bakiye kilitleri kullanılarak mükerrer bütçe tahsisi, yarış koşulları veya dönemler arasında aynı bütçenin iki kez kullanılması engellenir.

---

## 4. Yetki Politikası (Mandate Başına En Fazla 7 Gün)

### 4.1 Yetki Kuralları ve İki Bağımsız Güvenlik Kapısı
* **[Uygulanmamış Tasarım]**: **Mandate Başına En Fazla 7 Gün:**  
  Her Project Mandate en fazla 7 günlük geçerlilik dönemine (`authorizationStartTime` $\rightarrow$ `authorizationEndTime`, azami 7 gün) sahip olur.
* **[Uygulanmamış Tasarım]**: **Otomatik Uzatma Yasağı:**  
  Süre dolduğunda mevcut mandate otomatik olarak uzatılmaz. Süre bittiğinde yürütme derhal durdurulur (`MANDATE_EXPIRED`).
* **[Uygulanmamış Tasarım]**: **Yenileme Önkoşulları:**  
  Sonraki dönem için yeni geçerlilik aralığı, gerçek Ed25519 Trusted IDE imzası ve zorunlu Product Owner insan yetkilendirmesi (`aidm_approval_package_approve`) gerekir.
* **[Uygulanmamış Tasarım]**: **İki Bağımsız Yetkilendirme Kapısı:**
  1. Yeni bütçe tahsisi tek başına yürütme yetkisi vermez (`BUDGET_ALONE_INSUFFICIENT`).
  2. Yeni mandate tek başına bütçe harcama yetkisi vermez (`MANDATE_ALONE_INSUFFICIENT`).
  3. Bütçe ve mandate yenilemeleri birbirinden tamamen bağımsız olarak doğrulanır. Yürütmenin başlayabilmesi veya devam edebilmesi için **her iki koşulun da aynı anda geçerli olması zorunludur**.
  4. Bütçe tükendiğinde veya yetki süresi dolduğunda, yenileme tamamlanana kadar yürütme kapalı kalır.
* **[Uygulanmamış Tasarım]**: **Yasaklı Yetkilendirme Eylemleri:**  
  Sahte imza, yapay insan onayı, otomatik onay veya mevcut mandate'in sessizce uzatılması kesinlikle yasaktır ve fail-closed reddedilir.

---

## 5. Dosya ve Komut Politikası (Kotaların Kaldırılması, Kapsam ve Kanıt Koruması)

### 5.1 Kaldırılan Kotalar
* **[Uygulanmamış Tasarım]**: **100 Dosya Sınırının Kaldırılması:**  
  Önceki revizyonlarda yer alan oturum başına 100 dosya sınırı tamamen kaldırılmıştır. Görevler toplam dosya sayısı nedeniyle reddedilmeyecek veya durdurulmayacaktır.
* **[Uygulanmamış Tasarım]**: **500 Komut Sınırının Kaldırılması:**  
  Önceki revizyonlarda yer alan oturum başına 500 komut sınırı tamamen kaldırılmıştır. Görevler komut adedi nedeniyle durdurulmayacaktır.

### 5.2 Korunan Dosya Kanıtı ve Kapsam Denetimi
* **[Uygulanmamış Tasarım]**: **Pre-Execution Baseline (Temel Durum Kaydı):**  
  Kirli çalışma ağacındaki mevcut değişiklikleri (`feat/openai-director-runtime`) yeni görev mutasyonlarından ayırmak için görev öncesinde tüm dosyaların varlık durumu ve SHA-256 özetleri kaydedilir.
* **[Uygulanmamış Tasarım]**: **Net Dosya Mutasyonu Doğrulaması:**  
  Görev sonucunda yalnızca `preHash !== postHash` olan veya yeni oluşturulan/silinen dosyalar kanıt paketine işlenir.
* **[Çözülemeyen Risk]**: Bu mekanizma görev sonunda gözlemlenen net değişiklikleri ölçer; fiziksel disk I/O yazmalarını yakalayamaz. Bir dosya değiştirilip aynı görev içinde eski hâline döndürülürse tespit edilmeyebilir. `fs.watch` yalnızca yardımcı telemetridir; kesin güvenlik kanıtı olarak sunulamaz.
* **[Uygulanmamış Tasarım]**: **Çalışma Ağacı Kapsam Denetimi:**  
  Kapsam denetimi yalnızca `targetFiles` ile sınırlı kalmayıp, izin verilen `packages/` ve `docs/` dışındaki tüm beklenmeyen değişiklikleri (`SCOPE_LEAK`) denetler. Dışarıya yapılan herhangi bir yazma görevi reddeder ve döngüyü kilitler.
* **[Uygulanmamış Tasarım]**: **Symlink ve Path Traversal Koruması:**  
  Göreli yollarda `..` veya mutlak yollar engellenir. Windows Junction / Symlink üzerinden çalışma alanı kökü dışına taşma girişimleri (`WORKSPACE_ESCAPE`) engellenir.
* **[Uygulanmamış Tasarım]**: **Komut Güvenlik Sınıflandırması:**  
  Çalıştırılan komutlar kategorilerine (`TEST`, `BUILD`, `TYPECHECK`, `READ_ONLY`, `LINT`) göre denetlenir; tehlikeli/yasaklı komutlar engellenir.
* **[Uygulanmamış Tasarım]**: **Yürütmeyi Durdurma Nedenleri:**  
  Yürütme; kota adetleri nedeniyle değil, yalnızca **bütçe tükenmesi, mandate süresinin dolması, güvenlik ihlali (kapsam sızıntısı/symlink) veya süreç izolasyon belirsizliği** durumlarında durdurulur.

---

## 6. Windows Süreç Güvenliği ve İki Kademeli Kilit

### 6.1 Süreç Ağacı Sonlandırma ve Bağımsız Doğrulama
* **[Mevcut Kodla Doğrulandı]**: Mevcut kodda süreç sonlandırma yalnızca Node.js `child.kill()` ile yapılmaktadır ([antigravity-process-runner.ts:367-375](file:///d:/ÇALIŞMALAR-D/OtonomMCP/packages/core/src/executor-bridge/antigravity-process-runner.ts#L367-L375)). Windows üzerinde bu çağrı torun süreçleri yetim bırakabilir.
* **[Mevcut Kodla Doğrulandı]**: Mevcut CLI tabanlı yürütme mimarisi `agy.exe` çalıştırılabilir dosyasını doğrudan çağırmaktadır ([antigravity-process-runner.ts:336-342](file:///d:/ÇALIŞMALAR-D/OtonomMCP/packages/core/src/executor-bridge/antigravity-process-runner.ts#L336-L342)). Bu mimari korunacaktır.
* **[Uygulanmamış Tasarım]**: İptal veya zaman aşımı durumunda `taskkill.exe /PID <pid> /T /F` çalıştırılır. `taskkill` tek başına mutlak izolasyon garantisi kabul edilmez.
* **[Uygulanmamış Tasarım]**: Süreç ağacının tamamen kapandığı bağımsız olarak işletim sistemi süreç tablosu (`Win32_Process` / `tasklist`) taranarak doğrulanır.

### 6.2 Fail-Closed Blokaj ve İki Kademeli Devam Şartı
* **[Uygulanmamış Tasarım]**: Süreç ağacının sonlandığı doğrulanamazsa veya doğrulama sorgusu belirsiz kalırsa sistem derhal `BLOCKED` durumuna geçer ve blokaj nedeni `PROCESS_ISOLATION_UNCERTAINTY` olarak kaydedilir.
* **[Uygulanmamış Tasarım]**: Blokaj durumu otomatik yeniden deneme (auto-retry) ile aşılamaz.
* **[Uygulanmamış Tasarım]**: **İki Kademeli Devam Şartı:**  
  Yürütmenin devam edebilmesi için:
  1. Product Owner'ın açık insan incelemesi ve onayı verilmiş olmalı, **VE**
  2. İşletim sistemi düzeyinde yetim/zombi alt süreç kalmadığı **bağımsız olarak yeniden doğrulanmış (re-verified)** olmalıdır. İzolasyon doğrulanmadan yürütme kesinlikle devam edemez (`DISPATCH_BLOCKED`).

---

## 7. Korunması Zorunlu Sabit Sınırlar ve Güvenlik Kapıları

Aşağıdaki sınırlar ve güvenlik kapıları hiçbir koşulda esnetilemez veya değiştirilemez:

| Parametre | Zorunlu Değer / Kural | Durum |
| :--- | :--- | :--- |
| **API Bütçe Tavanı** | **Yetkilendirilmiş dönem başına 10 USD** (`10_000_000_000n` nano-USD, `budget.db`) | **[Uygulanmamış Tasarım]** / Korundu |
| **Yetki Belgesi Süresi** | **Mandate başına en fazla 7 gün** (Otomatik uzatma kesinlikle yasak) | **[Uygulanmamış Tasarım]** / Korundu |
| **İki Bağımsız Kapı** | Bütçe ve Mandate bağımsız doğrulanır; her ikisi de geçerli olmalıdır | **[Uygulanmamış Tasarım]** / Korundu |
| **Dosya ve Komut Kotası**| Sayısal kotalar (100 dosya, 500 komut) kaldırıldı; kanıt ve kapsam korundu | **[Uygulanmamış Tasarım]** / Kaldırıldı |
| **İzinli Dizinler** | Yalnızca `packages` altındaki tüm paketler ve `docs` (Kök ve `.ai-manager` yasak) | **[Mevcut Kodla Doğrulandı]** / Korundu |
| **Otomatik Görev Sınıfları**| Yalnızca 4 sınıf: `ROUTINE_BUG_FIX`, `TEST_MODIFICATION`, `FEATURE_IMPLEMENTATION`, `REFACTORING` | **[Mevcut Kodla Doğrulandı]** / Korundu |
| **Belirsiz Sınıflandırma**| Çakışan veya eşleşmeyen görevler $\rightarrow$ `UNCLASSIFIED` (Fail-closed blokaj) | **[Mevcut Kodla Doğrulandı]** / Korundu |
| **Yasaklı Eylemler** | `PUSH`, `RESET_HARD`, `PUBLISH`, `GIT_FORCE_PUSH`, `WORKSPACE_ESCAPE`, `BULK_DELETION` | **[Mevcut Kodla Doğrulandı]** / Korundu |
| **İnsan Onayı** | Product Owner gerçek insan onayı zorunluluğu (`aidm_approval_package_approve`) | **[Mevcut Kodla Doğrulandı]** / Korundu |
| **İmza Doğrulama** | Gerçek Ed25519 Trusted IDE imza doğrulaması | **[Mevcut Kodla Doğrulandı]** / Korundu |
| **İzolasyon Koruması** | `D:\ÇALIŞMALAR-D\OtonomMCP-External-IdP` projesine hiçbir şekilde dokunulmayacak | **[Mevcut Kodla Doğrulandı]** / Korundu |
| **Yürütme Mimarisi** | Mevcut CLI tabanlı yürütme mimarisi (`agy.exe`) aynen korunacak | **[Mevcut Kodla Doğrulandı]** / Korundu |

> [!CAUTION]
> **Yasak Eylemler:**  
> Sahte onay, taklit imza, varsayılan yetki belgesi veya yapay bütçe kaydı oluşturulamaz. Güvenlik kapıları devre dışı bırakılamaz. Genel `IMPLEMENTATION` veya `TEST` görev sınıfları otomatik yürütme izin listesine eklenemez.

---

## 8. Güvenlik Şartları, Bileşenler, Hata Davranışları ve Test Edilebilir Kabul Kriterleri

Aşağıdaki tabloda yer alan kabul testlerinin tamamı tasarım aşamasındadır; hiçbiri mevcut kaynak kodda henüz yazılmamıştır ve çalıştırılmamıştır.

| No | Güvenlik Şartı | İlgili Bileşen | Hata Kodu / Durumu | Davranış | Kabul Kriteri Durumu |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **G-1** | Bütçe Dönemi Aşımı | `BudgetManager` | `BUDGET_EXCEEDED` | 10 USD tavanına ulaşıldığında yeni API çağrıları durdurulur. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-2** | Mandate Süresi Dolumu | `AuthorizationPolicyEngine` | `MANDATE_EXPIRED` | 7 günlük süre aşıldığında yürütme durdurulur, otomatik uzatılmaz. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-3** | İki Bağımsız Kapı Doğrulaması | `ClosedLoopCoordinator` | `AUTH_GATE_INCOMPLETE` | Bütçe var mandate yoksa veya mandate var bütçe yoksa yürütme başlamaz. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-4** | Kapsam Dışı Beklenmeyen Değişiklik | `EvidenceCollector` | `SCOPE_LEAK` | `packages` ve `docs` dışına yazılan her dosya görevi reddeder. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-5** | Symlink / Traversal Koruması | `EvidenceCollector` | `WORKSPACE_ESCAPE` | `..` veya symlink ile kapsam dışına çıkan eylemler blokaj üretir. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-6** | Kirli Ağaç İzolasyonu | `PreExecutionBaseline` | `SCOPE_VIOLATION` | Önceden var olan değişiklikler yeni mutasyon sayılmaz. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-7** | Süreç Ağacı Sonlandırma | `AntigravityProcessRunner` | `PROCESS_TIMEOUT` / `CANCELLED` | Ağaç sonlandırılır, bağımsız doğrulama yapılır. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-8** | Sonlandırılamayan Alt Süreç | `ClosedLoopCoordinator` | `PROCESS_ISOLATION_UNCERTAINTY` | Otonom döngü derhal `BLOCKED` durumuna geçer. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-9** | Durum Doğrulama Belirsizliği | `ClosedLoopCoordinator` | `PROCESS_ISOLATION_UNCERTAINTY` | Süreç sorgusu belirsiz dönerse sistem fail-closed blokaja girer. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-10**| Blokajdan Çıkışta İki Kademeli Kilit | `ClosedLoopCoordinator` | `DISPATCH_BLOCKED` | İnsan onayı VE bağımsız izolasyon yeniden doğrulaması olmadan devam edilmez. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-11**| Görev Sınıflandırma Belirsizliği | `TaskDecompositionEngine` | `TASK_CLASS_NOT_AUTO_EXECUTABLE` | Görev `UNCLASSIFIED` olur, otomatik çalıştırılmaz. | **UYGULANMADI (NOT IMPLEMENTED)** |
| **G-12**| Çoklu Süreç Bütçe Eşzamanlılığı | `SQLiteBudgetLedger` | `BUDGET_LOCK_TIMEOUT` | SQLite OS kilidiyle güvenli yarış yönetimi (`BEGIN IMMEDIATE`). | **UYGULANMADI (NOT IMPLEMENTED)** |

---

## 9. Nihai Kapanış Durumu

Revizyon 6 dokümantasyon aşaması güncel bağlayıcı kararlarla eksiksiz olarak tamamlanmıştır.

* **Nihai Durum:** `DOCUMENTATION_COMPLETE_IMPLEMENTATION_NOT_AUTHORIZED`
* **Sonraki Adım:** Kaynak kod, test veya veritabanı uygulamasına geçilmeyecektir. Açık Product Owner uygulama onayı beklenmektedir.
