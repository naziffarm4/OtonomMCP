# OtonomMCP (AIDM) — Güvenlik Modeli ve Güven Sınırları (SECURITY.md)

**Belge Kodu:** AIDM-DOC-SEC  
**Sürüm:** 1.0.0  
**Tarih:** 2026-10-04  
**Kapsam:** TRUST-ROOT-01..08 ve DIRECTOR-INTERACTION-01/02 Araştırmalarının Bağlayıcı Güvenlik Bulguları, Tehdit Modeli, Saldırı Yüzeyi ve Fail-Closed Kapıları

---

## 1. Temel Tehdit Modeli ve İşletim Sistemi Sınırları

### 1.1. Same-User DAC Güvenlik Sınırı Yokluğu (TRUST-ROOT-01)
Microsoft Windows NT mimarisinde (Discretionary Access Control), aynı yerel kullanıcı hesabı (User SID) ve aynı Bütünlük Düzeyinde (Medium Integrity Level) çalışan süreçler arasında işletim sistemi düzeyinde bir güvenlik sınırı (security boundary) **bulunmamaktadır**.
- Aynı kullanıcı hesabında çalışan herhangi bir arka plan süreci (PowerShell, Python, kötü niyetli komut dosyası), Antigravity IDE'nin ortam değişkenlerini, dosya sistemini ve stdio borularını okuyabilir veya taklit edebilir.
- Bu nedenle, "Antigravity IDE'nin yazılımsal sürecine güvenmek" bir istemci tarafı güvenlik yanılsamasıdır (Client-Side Trust Fallacy).

### 1.2. Kurye Aldatmacası ve Bant İçi Proxy Riski (TRUST-ROOT-05, TRUST-ROOT-06, TRUST-ROOT-08)
Kullanıcı ile AIDM arasındaki tek iletişim hattı AGY'nin kontrolündeki Antigravity IDE sohbet penceresi veya `default_api:ask_question` aracı olduğu sürece, AGY aradaki **Bant İçi Aracı (In-Band Proxy)** konumundadır.
- Tüm girdi ve çıktıları kontrol eden bir uygulayıcıya karşı, bant dışı (out-of-band) bağımsız bir kanal olmadan soru/cevap bütünlüğü ve işlem şeffaflığı (WYSIWYS) matematiksel olarak kanıtlanamaz (**TRUST-ROOT-08 KESİN NO-GO**).
- AGY süreci veya bir istemci, kullanıcıya sahte onay penceresi gösterebilir ya da kullanıcının onayını tahrif edebilir.
- Bu nedenle IDE içi sohbet penceresi insan onayının güven kökü (Root of Trust) **sayılamaz**.

### 1.3. Kör İmzalama Problemi (TRUST-ROOT-02, TRUST-ROOT-03)
Windows TPM 2.0 ve CNG (Cryptography Next Generation) KSP kullanılarak `NCRYPT_UI_POLICY_ALWAYS` ile Windows Hello (Biyometri / PIN) güvenlik penceresi açtırılabilmektedir.
- Ancak bu pencere işletim sisteminin yerleşik PIN/Biyometri modalıdır ve ekranda **hangi dosyanın değiştirileceğini, ne kadar harcama yapılacağını veya hangi komutun çalıştırılacağını göstermez**.
- Yalnızca donanım anahtarının imzalamasını onaylatır; dolayısıyla tek başına bir "İşlem Onayı" (Transaction Consent / WYSIWYS) çözümü değildir.

---

## 2. Değiştirilemez Güvenlik Değişmezleri (Hard Architectural Invariants)

OtonomMCP çekirdeğinde aşağıdaki değişmezler mutlak olarak uygulanır:

1. **Sıfır Uygulayıcı Güveni (Zero Executor Trust):**
   Uygulayıcının (AGY) süreç çıkış kodu (exit code 0) veya `"Görev başarıyla tamamlandı"` şeklindeki sözel beyanları başarı kanıtı sayılmaz. Yalnızca `EvidenceCollector` tarafından toplanan bağımsız dosya SHA-256 hash'leri, Git diff'i ve bağımsız test çıkışları otoriter başarı kanıtıdır.
2. **Sözel İstemci Beyanlarının Kesin Reddi:**
   İstemci payload'ında veya model çıktısında yer alan şu beyanlar ExecutionBridge ve PolicyEngine tarafından doğrudan reddedilir:
   - `actor: "USER"`
   - `isTrustedHumanAuth: true`
   - `authStatus: "VERIFIED_HUMAN"`
   - `hasImplementationAuthority: true`
3. **Tek Seferlik İcra İddiası (Single Execution Claim):**
   Bir `ExecutionIntent`, `ExecutionBridge` tarafından yalnızca bir kez talep edilebilir ve çalıştırılabilir. Mükerrer çağrılar atomik olarak engellenir (`ALREADY_CLAIMED`).
4. **Bilinmeyen Durumda Kesin Durma (Strict Unknown-State Safety):**
   Yürütme sırasında AGY süreci çökerse, zaman aşımına uğrarsa veya sonuç belirsiz kalırsa durum `EXECUTION_UNKNOWN` olur ve sistem bu eylemi asla otomatik olarak tekrar çalıştırmaz. Durum Director'a raporlanır.
5. **Ön-Rezervasyonlu Bütçe Taşma Koruması:**
   Hiçbir LLM isteği veya harcama gerektiren eylem, SQLite veritabanında Nano-USD cinsinden atomik hold rezervasyonu yapılmadan (`claimReservationForDispatch`) ağa gönderilemez. Bütçe yetersizliğinde sistem fail-closed durur (`BUDGET_EXCEEDED`).
6. **Sırların Arındırılması (Secret Sanitization):**
   Bearer token'lar, API anahtarları, parolalar ve özel anahtarlar; URL sorgu parametrelerinden, başlıklardan, hata mesajlarından ve telemetri nesnelerinden deterministik regex ile arındırılır (`***REDACTED***`).

---

## 3. P18-04 ve P20 Check 6 Güvenlik Kapısı

- **Mevcut Durum:** `BLOCKED_ON_AUTH_CONTEXT`.
- **Fail-Closed Kuralı:** İnsan onayı gerektiren bir durum (`REQUIRE_HUMAN_APPROVAL`) oluştuğunda, yukarıda açıklanan nedenlerle henüz güvenilir bir out-of-band insan kimlik kökü bulunmadığı için yürütme kesin olarak engellenir.
- Sistem hiçbir koşulda sahte onay üretmez, bu kapıyı gevşetmez veya testlerde mocklayarak bypass etmez.
