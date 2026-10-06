# OtonomMCP (AIDM) — Güvenlik Modeli ve Tehdit Sınırları (SECURITY.md)

**Belge Kodu:** AIDM-DOC-SEC
**Sürüm:** 1.2.0
**Tarih:** 2026-10-04
**Kapsam:** OtonomMCP / AIDM Güvenlik Modeli, Tehdit Analizi, Sıfır Uygulayıcı Güveni (Zero Executor Trust), Güvenlik Kapıları ve Fail-Closed Davranışları

---

## 1. Temel Tehdit Modeli ve İşletim Sistemi Güvenlik Sınırları

OtonomMCP'nin güvenlik mimarisi, yerel geliştirici ortamının gerçek fiziksel ve işletim sistemi sınırları göz önüne alınarak tasarlanmıştır:

### 1.1. Same-User DAC Güvenlik Sınırı Yokluğu
Microsoft Windows NT mimarisinde (Discretionary Access Control), aynı yerel kullanıcı hesabı (aynı User SID) ve aynı Bütünlük Düzeyinde (Medium Integrity Level) çalışan süreçler arasında işletim sistemi düzeyinde bir güvenlik sınırı (OS sandbox) bulunmamaktadır.
- Antigravity IDE, AIDM ve AGY uygulayıcısı aynı kullanıcı oturumu altında çalışır. AGY'nin bir çocuk süreç (`child_process`) olarak başlatılması, ayrıcalıklı bir yalıtım sağlamaz; yalnızca süreç yaşam döngüsü kontrolü sağlar.
- Bu nedenle, uygulayıcının kendi yazılımsal beyanına güvenmek bir istemci tarafı güvenlik yanılsamasıdır (Client-Side Trust Fallacy).
- Güvenlik kontrolü, uygulayıcının kısıtlanmasına değil; eylem öncesi katı politika süzgecine ve eylem sonrası bağımsız delil denetimine dayanır.

### 1.2. Kör İmzalama ve Donanım Anahtarı Sınırı
Windows TPM 2.0 veya yerel şifreleme anahtarlarıyla üretilen bir kriptografik imza, donanım anahtarının o veri bloğunu imzaladığını kanıtlar.
- Ancak bu imza tek başına, fiziksel bir insanın ekrandaki işlem detaylarını (hangi dosyaların değişeceğini, hangi komutların çalışacağını veya bütçe etkisini) bizzat görüp onayladığını kanıtlayamaz (Kör İmzalama Riski).
- Dolayısıyla, donanımsal imza tek başına gerçek bir insan iradesi veya işlem onayı kanıtı sayılamaz.

### 1.3. Bant İçi Aracı (In-Band Proxy) Riski
Kullanıcı ile AIDM arasındaki iletişim hattı uygulayıcının kontrolündeki IDE sohbet penceresi veya araçları olduğu sürece, uygulayıcı aradaki bant içi aracı konumundadır.
- Doğal dil modelleri prompt manipülasyonu veya halüsinasyon yoluyla sahte yetkilendirme beyanları (`actor: "USER"`, `isTrustedHumanAuth: true`) üretebilir.
- Bu nedenle IDE içi sohbet veya prompt beyanları insan onayının güven kökü (Root of Trust) kabul edilemez.

---

## 2. Temel Güvenlik Değişmezleri (Hard Architectural Invariants)

OtonomMCP çekirdeğinde aşağıdaki güvenlik değişmezleri mutlak olarak uygulanır:

1. **Sıfır Uygulayıcı Güveni (Zero Executor Trust):**
   - **Sözel Beyanlar Kanıt Değildir:** AGY uygulayıcısının `"Görev tamamlandı"`, `"Tüm testler geçti"` veya `"Değişiklik yapıldı"` şeklindeki metinsel beyanları kanıt sayılmaz.
   - **Tek Başına Exit Code 0 Başarı Kanıtı Sayılmaz:** Bir işletim sistemi sürecinin hatasız sonlanması (`exitCode: 0`), hedeflenen işlevsel sonuca ulaşıldığını veya dosya içeriklerinin doğru güncellendiğini tek başına kanıtlamaz.
   - **RawExecutorOutcome Başarı Belgesi Değildir:** `AntigravityAdapter` tarafından üretilen çıktı yalnızca ham süreç icra telemetrisidir.
   - **Bileşik ve Bağımsız Kanıt Şartı:** Bir eylemin tamamlandığı kararı; bağımsız olarak toplanan dosya SHA-256 hash'leri, Git çalışma ağacı değişiklikleri (`git status` / `git diff`) ve bağımsız test çıkış kodlarının `EvidenceCollector` tarafından doğrulanmasıyla (`SystemExecutionEvidence`) verilir.

2. **Sözel İstemci ve Model Beyanlarının Reddi:**
   İstemci yükünde veya model yanıtında yer alan şu beyanlar doğrudan reddedilir:
   - `actor: "USER"`
   - `isTrustedHumanAuth: true`
   - `authStatus: "VERIFIED_HUMAN"`
   - `hasImplementationAuthority: true`

3. **Stale Context (Bayat Bağlam) Koruması:**
   Her Director eylemi, dayandığı sistem bağlamının SHA-256 parmak izini (`basedOnContextFingerprint`) taşımak zorundadır. Sistem durumu veya dosyalar değiştiğinde eski bağlama dayalı eylemler fail-closed olarak geçersiz kılınır (`STALE_CONTEXT`).

4. **Tek Seferlik İcra ve İdempotency (Single Execution Claim):**
   Her `BridgeExecutionIntent` benzersiz bir `idempotencyKey` taşır ve `ExecutionBridge` tarafından yalnızca bir defa talep edilebilir. Mükerrer çağrılar atomik olarak engellenir (`ALREADY_CLAIMED`).

5. **Bilinmeyen Durumda Kesin Durma (Strict Unknown-State Safety):**
   Yürütme sırasında uygulayıcı süreç çökerse, zaman aşımına uğrarsa veya sonuç belirsiz kalırsa durum `EXECUTION_UNKNOWN` olur ve sistem bu eylemi asla otomatik olarak tekrar çalıştırmaz.

6. **Ön-Rezervasyonlu Bütçe Koruması (OM-03 / P18-03):**
   Hiçbir LLM isteği veya harcama gerektiren eylem, SQLite veritabanında Nano-USD cinsinden atomik hold rezervasyonu yapılmadan (`claimReservationForDispatch`) ağa gönderilemez. Bütçe yetersizliğinde sistem fail-closed durur (`BUDGET_EXCEEDED`).

7. **Sırların Arındırılması (Secret Sanitization):**
   Bearer token'lar, API anahtarları ve şifreler; URL'lerden, başlıklardan, hata mesajlarından ve loglardan deterministik regex ile arındırılır (`***REDACTED***`).

8. **Çalışma Alanı ve Oturum İzolasyonu:**
   Sistem `.ai-manager/runtime.lock` dosyası ile tekil PID kilidi uygular; eşzamanlı iki sürecin çalışma alanına müdahalesi engellenir.

9. **Otoriter Bağımlılık Eksikliğinde Kesin Kapanma (P34 Fail-Closed Boundaries):**
   - **`REVIEW_EVIDENCE` Güvenlik Sınırı:** İnceleme eylemlerinde `evidenceStore` tanımlı değilse, otoriter delil mevcut değilse veya delil doğrulama kararı belirsiz (`UNKNOWN`) ise sistem hiçbir koşulda `ALLOW` üretmez; doğrudan `DENY` ile fail-closed kapanır. Uygulayıcı veya istemci tarafından enjekte edilen bant içi deliller (`payload.evidence`, `executorEvidence`, `agyEvidence`) doğrudan sahtecilik girişimi sayılarak reddedilir.
   - **Otoriter `taskClass` Çözümlemesi:** Yürütme yetkilendirmesinde (`autoExecutableTaskClasses`), görev sınıfı yalnızca otoriter `SpecStore`'daki kayıtlı görev tanımından çözümlenir. `SpecStore` eksikse, görev bulunamıyorsa veya görevin `taskClass` değeri tanımsız/belirsizse sistem asla varsayılan `'IMPLEMENTATION'` fallback'ine sığınmaz; kesin olarak fail-closed (`DENY`) üretir. İstemci veya Director tarafından sunulan sözel `taskClass` yükleri yetkilendirme kanıtı sayılamaz.

---

## 3. Güvenilir İnsan Onayı ve Check 6 Güvenlik Engeli (OM-04 / P18-04 ve OM-05 / P20)

- **Aşama Tanımı:** OM-04 / P18-04 (Trusted Identity Context), güvenilir insan kimliği ve onay bağlamını temsil eder. Bütçe yönetimi (OM-03 / P18-03) ile karıştırılmamalıdır.
- **Mevcut Durum:** `BLOCKED_ON_AUTH_CONTEXT` (OM-04 / P18-04 henüz tamamlanmamış olup, gerçek güvenilir insan kimliği doğrulaması mevcut olmadığı sürece fail-closed davranışı korunur).
- **Fail-Closed Kuralı:** İnsan onayı gerektiren bir durum (`REQUIRE_HUMAN_APPROVAL`) oluştuğunda, henüz bağımsız ve güvenilir bir dış kimlik kanıtı doğrulanmadığı için yürütme kesin olarak engellenir.
- **Güvenlik Taahhüdü:** TPM veya yazılımsal imzalar tek başına insan onayının kanıtı sayılmaz. Sistem hiçbir koşulda sahte onay üretmez, bu kapıyı gevşetmez veya testlerde mocklayarak bypass etmez. Mevcut olmayan bir güvenlik özelliği uygulanmış gibi gösterilemez.

---

## 4. Tehdit Matrisi ve Mevcut Korumalar

| Tehdit / Risk | Mevcut Koruma | Güvenlik Sınırı |
|---|---|---|
| **Same-User Süreç Müdahalesi** | PID kilidi (`runtime.lock`), fail-closed kontroller | Aynı kullanıcı oturumundaki süreçlerin yerel disk dosyalarını okuma riski Windows DAC sınırları gereğidir. |
| **Kör İmzalamayla Onay Taklidi** | Donanım imzaları tek başına onay sayılmaz; kanonik veri doğrulaması şarttır | İşletim sisteminde bağımsız, tahrif edilemez bir onay sunumu mevcut değildir; fail-closed bekler. |
| **Bant İçi Proxy / Prompt Manipülasyonu** | IDE içi insan onayı kabul edilmez; sahte yetki rolleri engellenir | İnsan onayı gerektiren işlemlerde sistem `BLOCKED_ON_AUTH_CONTEXT` olarak durur. |
| **Bütçe Aşımı ve Fatura Şoku** | SQLite Nano-USD atomik hold rezervasyonu ve reconciler | Harcama öncesi bütçe rezerve edilir; yetersiz bakiyede çağrı engellenir. |
| **Uygulayıcı Halüsinasyonu / Sahte Başarı** | Sıfır Uygulayıcı Güveni (Zero Executor Trust), bağımsız dosya SHA-256 hash'leri, Git diff ve bağımsız test çıkış kodu | Sözel beyanlar reddedilir; kanıt yoksa eylem başarısız sayılır. |
