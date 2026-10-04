# OtonomMCP — A ve B Birleşik Geliştirme Yol Haritası

**Belge türü:** Ana geliştirme yol haritası  
**Sıralama:** Önce Proje A, sonra Proje B, ardından A+B entegrasyonu  
**Kullanım:** Tek Windows bilgisayar, tek kullanıcı, kişisel kullanım  
**Dağıtım:** Hedeflenmiyor

## 1. Amaç ve geliştirme sırası

OtonomMCP iki bağımsız proje ve bir entegrasyon aşaması olarak geliştirilecektir:

1. **Proje A — OtonomMCP'nin tamamlanması:** Mevcut AIDM/Orchestrator sistemini B olmadan güvenli sınırlar içinde kullanılabilir hâle getirmek.
2. **Proje B — Bağımsız Yerel Onay Sistemi:** AGY'den bağımsız kullanıcı onayı sağlayan yerel Windows uygulamasını ayrı geliştirmek ve güvenlik testlerini tamamlamak.
3. **A+B — Entegrasyon:** B kabul edildikten sonra AIDM'ye bağlamak ve birleşik sistemi uçtan uca doğrulamak.

**Kesin sıra:** A tamamlanıp kabul edilmeden B'nin uygulama geliştirmesi başlamaz. A geliştirilirken B için yeni uygulama, servis, IPC, API veya güvenlik altyapısı oluşturulmaz. Yalnızca A'nın mevcut mimarisi, ileride B entegrasyonuna engel olmayacak şekilde korunur.

## 2. Sabit ürün ve işletim kararları

- Sistem yalnızca kullanıcının kendi Windows bilgisayarında, tek kullanıcı tarafından kullanılacaktır.
- Ticari dağıtım, genel kullanıma sunma ve çok kullanıcılı işletim hedeflenmemektedir.
- Ayrı sunucu veya bulut hizmeti kullanılmayacaktır.
- Dijital uygulama imzalama sertifikası/hizmeti kullanılmayacaktır.
- Harici donanım güvenlik anahtarı satın alınmayacaktır.
- Ücretli güvenlik denetimi planlanmamaktadır.
- Yerel API (ör. Express.js) ileride değerlendirilebilir; şimdilik kapsam dışıdır.
- Gerçek ücretli LLM/API çağrıları açık kullanıcı izni ve uygun kimlik bilgileri olmadan yapılmayacaktır.
- Ücretsiz yerel bileşenler ve Windows'un mevcut yetenekleri tercih edilecektir.
- Bu kısıtlar güvenlik kontrollerini gevşetmek için gerekçe değildir. Engellenemeyen tehditler ve güven sınırları belgelenmelidir.

## 3. Ortak mimari ilkeler

1. Tek Task DAG.
2. Tek DriverEngine ve tek DirectorLoopEngine.
3. Tek EvidenceCollector/Verifier.
4. İkinci DurableStateManager, EventStore veya görev yürütme motoru oluşturulmaması.
5. Mevcut HistoryManager ve işlem geçmişinin korunması.
6. Director'ın tek kullanıcıya dönük karar ve iletişim sahibi olması.
7. AGY'nin uygulayıcı rolünde kalması; kullanıcı adına karar veya onay üretememesi.
8. AGY'nin kendi raporunun tek başına başarı kanıtı sayılmaması.
9. Bounded retry, timeout, idempotency, stale-context ve güvenli recovery.
10. Proje/workspace/session izolasyonunun korunması.
11. Doğrulanabilir insan onayı yoksa kritik işlemlerde fail-closed davranılması.
12. Dirty ve untracked dosyaların korunması; kullanıcı izni olmadan reset, checkout, stash veya silme yapılmaması.
13. Kullanıcının açık izni olmadan commit veya push yapılmaması.
14. Güvenlik kontrollerinin testleri geçirmek amacıyla gevşetilmemesi.

# 4. Proje A — Mevcut OtonomMCP'yi tamamla

## A'nın hedefi

Director'ın AIDM üzerinden görevleri planlayabildiği, yetkilendirebildiği, AGY'ye gönderebildiği, bağımsız kanıtlarla sonuçları doğrulayabildiği ve gerektiğinde sınırlı düzeltme döngüsü çalıştırabildiği bir sistem elde etmek.

A, B olmadan da rutin ve açıkça yetkilendirilmiş geliştirme görevlerini güvenli biçimde yürütebilmelidir. Gerçek ve güvenilir insan onayı gerektiren işlemler, bu yetki sağlanana kadar bekletilmelidir.

## A1 — Mevcut durum ve kabul denetimi

- Repository, resmi ana yol haritası, görev kayıtları, karar kayıtları, testler ve Git durumu incelenir.
- Her iş paketi `DONE`, `PARTIAL`, `BLOCKED`, `NOT STARTED` veya `NEEDS VERIFICATION` olarak sınıflandırılır.
- Raporlarda tamamlandı denilen işler kod ve test kanıtıyla doğrulanır.
- Tamamlanmış işler somut kusur olmadan yeniden açılmaz.
- Açık bağımlılıklar ve gerçek kritik yol belirlenir.
- Resmi P22 adlandırma çakışması düzeltilir: resmi ana planda P22 Director MCP Control Plane'dir. Trusted IDE Authentication/güven kökü araştırmaları B için ayrı önkoşul olarak izlenir.

**Çıktılar:** `PROJECT_A_COMPLETION_ROADMAP.md`, `PROJECT_B_INDEPENDENT_APPROVAL_ROADMAP.md`, `A_B_INTEGRATION_CONTRACT.md`, `A_CURRENT_STATE_AUDIT.md`.

**Kabul:** A'nın kalan işleri, bağımlılıkları ve kabul koşulları kanıta dayalı biçimde belirlenmiş olmalıdır. Bu aşamada üretim kodu değiştirilmez.

## A2 — Director Reasoning Runtime

- P18-01, P18-02 ve P18-03 mevcut uygulamaları denetlenir; kabul edilmiş işler gereksiz yere tekrarlanmaz.
- Gerçek LLM sağlayıcı bağlantısı ve yanıt işleme yolu doğrulanır.
- Mock, fixture ve gerçek sağlayıcı testleri birbirinden ayrılır.
- Token/cost budget, reservation, settlement, timeout ve belirsiz sonuç davranışları doğrulanır.
- Gerçek ücretli API çağrısı yalnızca kullanıcı açıkça izin verirse yapılır.
- API anahtarları kaynak kodu, Git, log veya komut satırı argümanlarında tutulmaz.

**Kabul:** Gerçek sağlayıcı entegrasyonu izinli bir testle kanıtlanır. Ücretli test yapılmadıysa `NOT VERIFIED` denir; mock testi gerçek entegrasyon yerine sunulmaz.

## A3 — Director Action Protocol ve Authorization Policy

- P19 ve P21 entegrasyonu doğrulanır.
- Action ID, idempotency key, context fingerprint ve requirements revision kontrolleri korunur.
- Proje, session, görev ve mandate kapsamı doğrulanır.
- Yetki kapsamı dışındaki eylemler reddedilir.
- İnsan onayı gerektiren eylemler doğrulanabilir onay yoksa bekletilir.
- Client/model payload içindeki `verified`, `PRODUCT_OWNER` veya benzeri iddialar güvenilir kimlik kanıtı sayılmaz.

**Kabul:** Her eylem AIDM tarafından yeniden doğrulanır; yetkisiz veya eski bağlama dayanan eylemler yürütülmez.

## A4 — Closed-loop Coordinator

Hedef akış:

`Context → Reasoning → Action Validation → Authorization → Existing Driver → AGY → Evidence Collection → Independent Verification → State Integration → Context Refresh`

- Mevcut DriverEngine, DirectorLoopEngine ve EvidenceCollector yeniden kullanılır.
- AGY'ye görev gönderme ve gerçek yürütme sonucu toplama tamamlanır.
- AGY'nin başarı beyanı tek başına kabul edilmez.
- Bağımsız kanıt toplanır ve doğrulanır.
- Başarısız veya eksik sonuçlar Director'a geri verilir.
- Director gerektiğinde düzeltici görev oluşturabilir.
- Döngü sayısı, süre, bütçe ve tekrar koşulları sınırlandırılır.
- Timeout veya belirsiz yürütme sonucu otomatik ve körlemesine yeniden gönderilmez.
- İnsan onayı bekleyen işler güvenli bekleme durumunda kalır.

**Kabul:** Bir görev AGY'ye gönderilebilir, sonucu bağımsız doğrulanabilir ve gerekiyorsa kontrollü düzeltme döngüsü çalıştırılabilir.

## A5 — Director MCP Control Plane

- Mevcut MCP sunucusu ve taşıma altyapısı yeniden kullanılır.
- Director için şeması tanımlı yüksek seviyeli kontrol araçları sunulur.
- Gerekli yetenekler: `open`, `context`, `act`, `cycle`, `result`, `status`, `decisions`, `resolve`, `pause`, `resume`, `stop`.
- MCP initialize/list/call protokol testleri yapılır.
- Sınırsız shell erişimi yeni kontrol yüzeyi olarak eklenmez.
- Her çağrı proje/session/authorization kapsamına göre doğrulanır.

**Kabul:** Director AIDM'yi tanımlı MCP sözleşmesi üzerinden yönetebilir; yetkisiz çağrılar fail-closed reddedilir.

## A6 — Durable Session ve Recovery

- Mevcut HistoryManager, DurableStateManager ve event mimarisi kullanılır.
- İkinci kalıcı durum veya olay deposu oluşturulmaz.
- Oturum devamlılığı ve yeniden başlatma sonrası recovery doğrulanır.
- Yarım kalmış, belirsiz veya sonucu bilinmeyen AGY işlemleri güvenli biçimde ele alınır.
- Idempotency ve execution claim bilgileri korunur.
- Proje/session izolasyonu ve geçmiş kayıtları korunur.
- Tek instance kilidi ve sahiplik kuralları doğrulanır; otomatik zombie takeover veya Force Unlock eklenmez.

**Kabul:** AIDM yeniden başlatıldığında önceki işlemleri güvenli biçimde tanıyabilir; belirsiz işlemleri izinsiz tekrarlamaz.

## A7 — Gerçek uçtan uca doğrulama

Gerçek çalışma akışı:

`Director → AIDM → MCP → Existing Driver → AGY → EvidenceCollector → Verification → State Integration → Director`

Senaryolar:
- Başarılı görev.
- Başarısız görev ve düzeltme.
- AGY timeout.
- Eksik veya çelişkili kanıt.
- Stale context/fingerprint.
- Yinelenen action/idempotency.
- İnsan onayı bekleme ve ret.
- Süreç kapanması ve recovery.
- Bileşen/sağlayıcı kullanılamazlığı.
- Bütçe yetersizliği ve belirsiz maliyet sonucu.

**Kabul:** Başarılı ve başarısız akışlar, kanıtları ve beklenen güvenli duruşlarıyla raporlanır.

## A8 — Production Hardening ve A kabulü

- Process ve workspace izolasyonu.
- Dosya yolu ve komut kapsamı.
- Secret ve API anahtarı koruması.
- Bütçe, rate limit ve timeout.
- Eşzamanlılık ve tek instance.
- Windows ortamında kurulum/çalıştırma.
- Loglama, hata raporlama ve geçmiş.
- Yedekleme ve recovery.
- Teknik dokümantasyon ve operasyon talimatları.

**A'nın nihai kabul kriterleri:**
1. A1–A8 kabul koşulları karşılanmıştır.
2. Gerçek Director → AIDM → AGY → Evidence → Director döngüsü kanıtlanmıştır.
3. Rutin ve yetkilendirilmiş görevler B olmadan çalışabilmektedir.
4. Gerçek insan onayı gerektiren işlemler doğrulanabilir onay yoksa fail-closed beklemektedir.
5. Test/build sonuçları ve kalan sınırlamalar açıkça raporlanmıştır.
6. Kirli/untracked kullanıcı çalışmaları korunmuştur.
7. Kullanıcı onayı olmadan commit/push yapılmamıştır.

**A kabul edilmeden Proje B uygulama geliştirmesine başlanmaz.**

# 5. Proje B — Bağımsız Yerel Onay Sistemi

## B'nin hedefi

AGY'nin kontrol ettiği IDE chat/modal kanalından bağımsız bir Windows yerel arayüzü üzerinden kullanıcıya işlem detaylarını göstermek ve kullanıcı kararını AIDM'ye doğrulanabilir biçimde iletmek.

B yalnızca kişisel kullanım içindir. Ticari dağıtım, çok kullanıcılı işletim veya bulut mimarisi hedeflenmez.

## B1 — Gereksinim ve güvenlik mimarisi

- TRUST-ROOT-01–08 bulguları yeniden değerlendirilir.
- Başarısız olduğu gösterilen AGY courier, aynı-kanal SAS ve blind TPM signing tasarımları güvenilir çözüm gibi tekrar kullanılmaz.
- Güven sınırları, tehdit modeli ve güvenlik iddiaları tanımlanır.
- Aynı Windows kullanıcısı altındaki süreçlere karşı gerçek sınırlar abartılmadan belgelenir.
- AIDM ile entegrasyon sözleşmesi kesinleştirilir.
- Engellenemeyen tehditler ve residual risk açıkça belirtilir.

**Kabul:** Tasarımın hangi tehditleri hangi varsayımlarla engellediği ve hangilerini engelleyemediği açıklanır.

## B2 — Bağımsız yerel Windows onay uygulaması

- Ayrı yerel süreç olarak çalışır.
- İşlem türü, proje/workspace, görev, değişiklik özeti, etki ve risk bilgilerini gösterir.
- Onayla, reddet ve iptal seçenekleri sunar.
- İşlem kimliği ve bağlamı ekranda açıkça gösterilir.
- Onay geçmişi tutulur.
- Uygulama kapalı veya erişilemez olduğunda onay verilmiş varsayılmaz.

**Kabul:** Onay arayüzü AGY'nin kontrol ettiği IDE chat/modal kanalına bağlı değildir.

## B3 — Güvenli yerel iletişim

- AIDM ile B arasında yerel IPC tasarlanır.
- Windows erişim denetimleri uygulanır.
- İstek/yanıt bütünlüğü ve kimlik doğrulama tasarlanır.
- Proje, workspace, session ve task bağlamı doğrulanır.
- Nonce, expiry ve replay koruması uygulanır.
- Sahte istemci, sahte yanıt ve IPC taklidi test edilir.

**Kabul:** Yetkisiz veya değiştirilmiş mesajlar onay olarak kabul edilmez.

## B4 — İnsan onayı ve işlem bütünlüğü

- Kullanıcı onayı belirli ve değişmez işlem içeriğine bağlanır.
- İmzalanan/doğrulanan veri; project/workspace/session/task/action, fingerprint, policy revision, nonce ve expiry gibi gerekli bağlamı içerir.
- Anahtar üretimi, saklama, erişim ve iptal modeli belgelenir.
- Windows CNG/TPM gibi yerleşik yetenekler yalnızca kanıtlayabildikleri güvenlik özellikleri için kullanılır.
- TPM imzası tek başına bilgilendirilmiş insan onayı veya WYSIWYS kanıtı sayılmaz.

**Kabul:** Onay, genel bir `true` değerine değil, tam olarak gösterilen ve yürütülecek işlem içeriğine bağlanır.

## B5 — Güvenlik saldırı testleri

- AGY'nin sahte onay üretmesi.
- Onay talebi içeriğinin değiştirilmesi.
- Ekranda gösterilen içerik ile doğrulanan içeriğin farklı olması.
- Kullanıcı cevabının değiştirilmesi.
- IPC istemci taklidi.
- Replay ve eski nonce.
- Başka workspace/session/task için onay kullanılması.
- Süre aşımı, iptal ve ret.
- Uygulama/AIDM çökmesi ve yeniden başlatma.
- Aynı kullanıcı altındaki kötü niyetli süreç ve UI otomasyonu tehditleri.
- Anahtarın okunması/kullanılması ve güven sınırı ihlalleri.

**Kabul:** Testler gerçek güvenlik iddialarını doğrulamalı; başarısız veya test edilemeyen senaryolar açıkça raporlanmalıdır.

## B6 — AIDM entegrasyon adaptörü

- B ile AIDM arasında sürümlenmiş protokol.
- ExecutionBridge Check 6 entegrasyonu.
- AuthorizationPolicyEngine entegrasyonu.
- Mevcut ApprovalStore ve HistoryManager kullanımı.
- Pending approval, approve, reject, cancel, timeout ve recovery akışları.
- B kullanılamıyorsa fail-closed davranışı.
- A'nın B olmadan rutin görevlerde çalışması korunur.

**Kabul:** AIDM yalnızca B'nin doğruladığı ve tam işlem bağlamına bağlı onayları kabul eder.

## B7 — Birleşik uçtan uca doğrulama

`Director → AIDM → B → User Decision → AIDM Verification → ExecutionBridge → AGY → EvidenceCollector → Director`

Senaryolar:
- Onaylı işlem.
- Reddedilmiş işlem.
- İptal edilmiş işlem.
- Timeout.
- Değiştirilmiş işlem içeriği.
- Sahte onay.
- Replay.
- B'nin kapalı olması.
- AIDM/B yeniden başlatılması.
- Cross-project/session denemeleri.

**Kabul:** Onay akışı gerçek AIDM/AGY yürütmesine bağlanmış ve bağımsız kanıtlarla doğrulanmış olmalıdır.

## B8 — Birleşik sistem kabulü

- A+B regresyon testleri.
- Check 6 yalnızca doğrulanmış B onayında ilerler.
- B yok/kapalı/bozuk olduğunda fail-closed davranır.
- B devre dışıyken A'nın rutin çalışma kabiliyeti korunur.
- Güvenlik sınırlamaları ve kalan riskler raporlanır.
- Kullanım ve recovery dokümantasyonu hazırlanır.

**B'nin nihai kabul kriteri:** B, AIDM'nin kritik işlemler için insan onayını güvenli biçimde alıp doğrulayabildiğini kanıtlamalıdır. Kanıtlanamayan bir güvenlik özelliği varmış gibi raporlanmamalıdır.

# 6. A+B birleşik çalışma akışı

1. Director görev veya işlem önerisi oluşturur.
2. AIDM context, action, policy ve yetki kontrollerini yapar.
3. İşlem rutin ve mandate kapsamındaysa mevcut Driver/AGY akışı yürütülür.
4. İşlem insan onayı gerektiriyorsa AIDM işlemi beklemeye alır.
5. B bağımsız yerel arayüzünde tam işlem detaylarını gösterir.
6. Kullanıcı karar verir.
7. B, kararı işlem içeriğine bağlı doğrulanabilir kanıtla AIDM'ye iletir.
8. AIDM Check 6 ve policy kontrollerini tekrar yapar.
9. Onay geçerliyse mevcut ExecutionBridge/Driver/AGY akışı devam eder.
10. EvidenceCollector sonucu bağımsız doğrular.
11. Director'a sonuç ve kanıtlar döner.

# 7. Değişiklik ve Git kuralları

- Her aşama önce incelenir, sonra uygulanır.
- Her görev için kapsam, dosyalar, kabul kriterleri ve testler belirtilir.
- Dirty/untracked kullanıcı çalışmaları korunur.
- `reset`, `checkout`, `stash`, toplu silme veya yıkıcı işlem kullanıcı izni olmadan yapılmaz.
- Commit/push yalnızca kullanıcının açık onayıyla yapılır.
- Onay verilirse mevcut feature branch kullanılır; main'e merge yapılmaz.
- Raporlardaki başarı iddiaları bağımsız komut çıktıları/test kanıtlarıyla desteklenir.

# 8. İlk yürütülecek görev — A1

İlk görev A1 Mevcut Durum ve Kabul Denetimi'dir.

1. Repository ve belgeler incelenir.
2. A iş paketlerinin gerçek kod/test durumu kanıtla sınıflandırılır.
3. B ayrı ve sonraki proje olarak belgelenir.
4. P22 adlandırma çakışması düzeltilir: resmi P22 Director MCP Control Plane'dir; Trusted IDE Authentication araştırmaları B önkoşulu olarak ayrı tutulur.
5. A'nın kesin kritik yolu ve kabul kriterleri çıkarılır.

İlk denetimde üretim kodu, test, fixture, package veya güvenlik kontrolü değiştirilmez. API çağrısı yapılmaz. Commit/push, reset, checkout ve stash yapılmaz.

İlk görev çıktıları:
- `PROJECT_A_COMPLETION_ROADMAP.md`
- `PROJECT_B_INDEPENDENT_APPROVAL_ROADMAP.md`
- `A_B_INTEGRATION_CONTRACT.md`
- `A_CURRENT_STATE_AUDIT.md`

Önce raporlar hazırlanır ve kullanıcı incelemesine sunulur. Sonraki A geliştirme görevine kullanıcı onayıyla geçilir.
