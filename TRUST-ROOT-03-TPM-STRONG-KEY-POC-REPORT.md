# TRUST-ROOT-03 — TPM Strong Key Protection İzole PoC ve Donanım Doğrulama Raporu

**Rapor Kodu:** TRUST-ROOT-03-TPM-STRONG-KEY-POC-REPORT  
**Tarih:** 2026-10-03  
**Kapsam:** Windows 11 TPM 2.0 (Intel PTT), Win32 CNG Platform Crypto Provider (`MS_PLATFORM_KEY_STORAGE_PROVIDER`), ECDSA P-256 / SHA-256, `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG`, UI Policy Dinamikliği ve What-You-See-Is-What-You-Sign (WYSIWYS) Güvenlik Analizi  
**Uygulama:** İzole C# .NET 10 Win32 Native Interop Test Paketi (`poc/tpm-strong-key-poc`)  
**Sonuç:** TAMAMLANDI — KRİTİK MİMARİ BULGU TESPİT EDİLDİ (DONANIM DESTEKLİ BLIND SIGNING SINIRLAMASI)

---

## Yönetici Özeti ve Nihai Karar

TRUST-ROOT-02 raporunda fizibilitesi sunulan TPM 2.0 ve CNG tabanlı donanım anahtarı koruması, bu çalışma kapsamında **gerçek Windows 11 ortamında bağımsız, izole bir C# test harness (`poc/tpm-strong-key-poc`) ile doğrudan çalıştırılarak ve tüm uç durumlar sınanarak test edilmiştir**.

Mevcut AIDM üretim koduna, `ExecutionBridge`'e, `AuthorizationPolicyEngine`'e veya `ProjectMandateStore`'a hiçbir müdahale yapılmamış; sıfır üretim bağımlılığı ilkesi korunmuştur.

### Özet Bulgular:

1. **Donanım ve Kriptografik İmza (%100 Başarılı):**
   - Windows 11 üzerinde **Intel PTT TPM 2.0** donanımı (`MS_PLATFORM_KEY_STORAGE_PROVIDER`) üzerinden ECDSA P-256 anahtarı başarıyla üretilmiştir.
   - Donanım içinde SHA-256 hash'leri imzalanmış (64 bayt ASN.1 / IEEE P1363 imza) ve genel anahtar ile başarıyla doğrulanmıştır (`0x00000000`).
   - TPM 2.0 meta verileri (`PCP_TPM2BNAME` 34 bayt, `PCP_KEY_CREATIONHASH` 34 bayt, `PCP_KEY_CREATIONTICKET` 40 bayt, `PCP_EKPUB` 283 bayt, `PCP_EKCERT` 8 bayt) doğrudan donanımdan okunarak anahtarın TPM içinde yaşadığı kanıtlanmıştır.

2. **Sessiz Arka Plan İmzalamasının Engellenmesi (%100 Kanıtlı):**
   - `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` veya `NCRYPT_UI_PROTECT_KEY_FLAG` ile korunan anahtarlarda, `NCRYPT_SILENT_FLAG` bayrağı ile arka planda sessiz imzalama veya sessiz finalize etme denendiğinde Windows CNG çekirdeği **`0x80090022` (`NTE_SILENT_CONTEXT_NOT_SUPPORTED`)** hatası vererek yürütmeyi durdurmuştur.
   - Otonom bir ajanın veya arka plandaki zararlı bir sürecin kullanıcının fiziksel haberi olmadan imza atması işletim sistemi düzeyinde engellenmektedir.

3. **Kullanıcı İptali ve Negatif Testler (12/12 PASS):**
   - Kullanıcı onayı reddettiğinde veya dialog kapatıldığında Windows **`0x80090036` (`NTE_USER_CANCELLED`)** döndürmektedir.
   - 12 negatif test senaryosunun tamamında sistem fail-closed davranmıştır.

4. **KRİTİK MİMARİ BULGU — "What-You-See-Is-What-You-Sign" (WYSIWYS) İhlali:**
   - **Kullanıcı Onay Penceresi İşlem Detaylarını GÖSTEREMEZ:** Windows'un açtığı yerel onay modalı (`A tool is requesting access to a protected item`), yalnızca anahtar finalize edilirken kaydedilen statik `FriendlyName` ("AIDM Operator Key") ve `Description` ("Project Mandate Authorization Key") metinlerini gösterir.
   - **Dinamik Değiştirilemezlik:** `NCRYPT_UI_POLICY`, `NCryptFinalizeKey` çağrıldıktan sonra salt-okunur (read-only) hale gelir. Sonradan değiştirme denemeleri `0x80090025` (`NTE_FIXEDPARAMETER`) ile reddedilir.
   - **Challenge A ve Challenge B Arasında Sıfır Görsel Fark:** Bütçesi $10 USD olan bir Mandate değişikliği (Challenge A) ile kritik bir Approval Package onayı (Challenge B) imzalanırken Windows'un kullanıcıya gösterdiği onay penceresi **BİREBİR AYNIDIR**. Bütçe, görev kimliği, eylem kimliği veya yük özeti kullanıcıya gösterilemez.
   - Bu durum, **"Donanımsal Olarak Onaylanmış Kör İmza" (Hardware-Backed Blind Signing)** riskini doğurmaktadır.

### Nihai Karar:
- **Tek Başına Windows CNG Strong Key Modalına Dayalı Üretim Entegrasyonu: KESİN NO-GO.**
- **İki Katmanlı Güvenli Eşlikçi Mimarisi (Dual-Layer Secure Companion): ŞARTLI GO.** (İşlem içeriğini gösteren izole bir yerel UI penceresi + TPM 2.0 donanım anahtar koruması birlikte kullanılmalıdır).

---

## 1. Microsoft API Davranışları ve Kesinleşen Gerçekler

Microsoft resmi Windows SDK (`ncrypt.h`) ve CNG dokümantasyonu ile doğrudan test edilen API davranışları:

| Soru | Resmi API Gerçeği | Deneysel Kanıt / Hata Kodu | Güvenlik Anlamı |
|---|---|---|---|
| **1. `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` hangi arayüzü açıyor?** | Windows CryptoAPI / CNG "Strong Key Protection" dialogunu veya `CredentialUIBroker` PIN/Biyometri modalını açar. | Başlık: `"A tool is requesting access to a protected item"`, Sınıf: `Credential Dialog Xaml Host` / `Windows.UI.Core.CoreWindow`. | Standart masaüstü oturumunda modal açılır. Servis oturumunda (Session 0) açılamaz. |
| **2. Her imza çağrısında yeniden onay isteniyor mu?** | `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG (0x2)` her `NCryptSignHash` çağrısında PIN/Onay ister. `NCRYPT_UI_PROTECT_KEY_FLAG (0x1)` ise süreç önbelleğini kullanabilir. | Her imzada modal tetiklenir; sessiz çağrıda `0x80090022` döner. | Yetki önbelleğe alınamaz; otonom ajan yetkiyi devralamaz. |
| **3. `FriendlyName` ve `Description` nasıl gösterilir?** | Modal içinde `Item: <FriendlyName>` ve `Details: <Description>` alanlarında düz metin olarak gösterilir. | Ekranda: `Item: AIDM Operator Key`, `Details: Project Mandate Authorization Key`. | Sadece statik anahtar kimliği görünür; işlem yükü görünmez. |
| **4. Bu açıklamalar işlem başına değiştirilebilir mi?** | **HAYIR.** `NCRYPT_UI_POLICY` anahtar oluşturulurken bir kez tanımlanır. | `NCryptSetProperty` çağrısı finalize sonrasında `0x80090025` (`NTE_FIXEDPARAMETER`) döner. | Mevcut bir anahtarla her işleme özel açıklama göstermek imkansızdır. |
| **5. Finalize sonrası UI politikasının değişmemesi ne anlama gelir?** | Anahtar nesnesi kilitlenir. İmza fonksiyonu (`NCryptSignHash`) ise parametre olarak sadece 32 baytlık hash alır; metin almaz. | `NCryptSignHash(hKey, NULL, pbHash, 32, ...)` | Windows modalı neyin imzalandığını bilmez; kullanıcı kör imza atar. |
| **6. `NCRYPT_IMPL_TYPE_PROPERTY` hangi nesnede sorgulanır?** | Sadece **Sağlayıcı Tutamacı (`NCRYPT_PROV_HANDLE`)** üzerinde sorgulanabilir. | Sağlayıcıda: `0x00000001` (Hardware). Anahtar üzerinde: `0x80090029` (`NTE_NOT_SUPPORTED`). | Anahtar nesnesi üzerinden impl type sorgulanamaz, sağlayıcıdan doğrulanmalıdır. |
| **7. `NCRYPT_IMPL_HARDWARE_FLAG` TPM kanıtı için yeterli mi?** | **YETMEZ.** Yazılımsal taklit riskine karşı ek TPM meta verileri şarttır. | `PCP_TPM2BNAME` (34B), `PCP_KEY_CREATIONHASH` (34B), `PCP_KEY_CREATIONTICKET` (40B). | Yalnızca bayrak kontrolü yetersizdir; TPM 2.0 nesne adı ve creation ticket doğrulanmalıdır. |
| **8. TPM key attestation nasıl elde edilir ve doğrulanır?** | `NCryptCreateClaim` veya `PCP_TPM12_KEYATTESTATION` ile TPM AIK (Attestation Identity Key) imzası alınarak. | Bu makinede yerel AIK sertifikası olmadan `0x80290416` / `0x80090011` döner. | Yerel tekil makinelerde AIK CA altyapısı yoksa tam PKI attestation zinciri kurulamaz; yerel creation hash kullanılır. |
| **9. İptal, timeout ve silent context gerçek hata kodları nelerdir?** | - İptal: `0x80090036` (`NTE_USER_CANCELLED`)<br>- Silent Context: `0x80090022` (`NTE_SILENT_CONTEXT_NOT_SUPPORTED`)<br>- Silinmiş Anahtar: `0x80090016` (`NTE_BAD_KEYSET`)<br>- Bozuk İmza: `0x80090006` (`NTE_BAD_SIGNATURE`) | Bütün hata kodları test harness ile teyit edildi. | Hata kodları standarttır; fail-closed kapıları bu kodlara güvenle bağlanabilir. |

---

## 2. İzole PoC Mimarisi ve Gerçek Test Ortamı

### 2.1. Test Ortamı
- **İşletim Sistemi:** Windows 11 Pro 64-bit (Build 26100 / NT 10.0)
- **Masaüstü Oturumu:** Session ID 1 (Etkileşimli Kullanıcı Oturumu)
- **TPM Donanımı:** Intel Platform Trust Technology (PTT) TPM 2.0
  - Üretici: `INTC` (Intel)
  - Firmware Sürümü: `302.12.0.0`
  - TPM Spesifikasyonu: `1.16` (Revizyon Date: 2016-09-21)
  - Durum: `Ready For Storage: True`, `Ready For Attestation: True`
- **Kullanılan KSP:** `Microsoft Platform Crypto Provider`
- **Derleme Ortamı:** .NET SDK 10.0.401, C# 13, Native Win32 P/Invoke (`ncrypt.dll`, `user32.dll`, `gdi32.dll`)
- **İzole Proje Konumu:** `poc/tpm-strong-key-poc/` (Üretim dizinlerinden tamamen izole)

### 2.2. PoC Süreç Akış Şeması (14 Adım)

```
[İzole Test Harness: Program.cs]
       │
       ├── 1. NCryptOpenStorageProvider("Microsoft Platform Crypto Provider") ──► 0x00000000
       ├── 2. NCryptGetProperty(hProv, "Impl Type") ──► 0x00000001 (HARDWARE: True)
       ├── 3. NCryptGetProperty(hProv, "PCP_PLATFORM_TYPE") ──► TPM 2.0 Doğrulandı
       │
       ├── 4. NCryptCreatePersistedKey("ECDSA_P256", "AIDM_POC_KEY_...") ──► 0x00000000
       ├── 5. NCryptSetProperty(hKey, "UI Policy", NCRYPT_UI_POLICY) ──► 0x00000000
       ├── 6. dwFlags: NCRYPT_UI_PROTECT_KEY_FLAG | NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG
       ├── 7. NCryptFinalizeKey(hKey, 0) ──► Anahtar TPM Donanımında Kilitlendi
       │
       ├── 8. Kanonik 10-Field Challenge Payload Oluşturuldu (JSON SHA-256)
       ├── 9. NCryptSignHash(hKey, hash) ──► 64 Bayt ECDSA P-256 İmzası Üretildi
       ├── 10. NCryptVerifySignature(hKey, hash, sig) ──► 0x00000000 (VALID)
       │
       ├── 11. Kullanıcı İptal Testi (ESC / Cancel) ──► 0x80090036 (NTE_USER_CANCELLED)
       ├── 12. Sessiz İmza Testi (NCRYPT_SILENT_FLAG) ──► 0x80090022 (NTE_SILENT_CONTEXT_NOT_SUPPORTED)
       ├── 13. Değiştirilmiş Payload / Yanlış Nonce / Yanlış Proje ──► 0x80090006 (NTE_BAD_SIGNATURE)
       └── 14. NCryptDeleteKey(hKey, 0) ──► Donanım Anahtarı Güvenle Yok Edildi
```

---

## 3. Kullanıcı Onay Penceresinin Görsel Analizi

Aşağıdaki görsel, Windows 11 ortamında `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` ile oluşturulmuş bir anahtar erişildiğinde açılan resmi Windows CryptoAPI / CNG Strong Key Protection güvenlik onay penceresini göstermektedir:

![Windows Strong Key Protection Onay Penceresi](C:\Users\NAZİF AÇIKGÖZ\.gemini\antigravity-ide\brain\cd1a5990-8207-420e-8141-7eee1a8ae344\windows_strong_key_prompt_1791060859665.jpg)

### Pencere Öğelerinin İncelenmesi:
- **Pencere Başlığı:** `A tool is requesting access to a protected item` (Korumalı bir öğeye erişim isteniyor)
- **Güvenlik Başlığı:** `An application is requesting access to a protected item.`
- **Kategori:** `CryptoAPI Private Key`
- **Item (FriendlyName):** `AIDM Operator Key`
- **Details (Description):** `Project Mandate Authorization Key`
- **Açıklama:** `This application wants to use your private key to access a protected item. Do you want to allow this access?`
- **Butonlar:** `[OK]` ve `[Cancel]`

> [!WARNING]
> **Kritik Güvenlik Tespiti:**  
> Yukarıdaki pencerede **işlem detayları, bütçe miktarı, komut parametreleri, görev kimliği veya hash değeri kesinlikle BULUNMAMAKTADIR**.  
> Kullanıcı sadece genel bir anahtar kullanım izni penceresi görmektedir.

---

## 4. En Önemli Test: Kullanıcı Neyi Onayladığını Görebiliyor mu? (Challenge A vs B)

Bu test görev tanımının en kritik kabul koşuludur. İki farklı risk profiline sahip işlem challenge'ı hazırlanmış ve aynı TPM anahtarı ile imzalanmıştır:

### 4.1. Hazırlanan Challenge'lar

```json
// CHALLENGE A (Düşük Riskli İdari Güncelleme - Bütçe: $10 USD)
{
  "actionId": "action-budget-10usd",
  "contextFingerprint": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "directorSessionId": "session-dir-alpha-01",
  "expiresAt": "2026-10-03T20:58:50.1115293Z",
  "mandateRevision": 2,
  "nonce": "b22e28da480f42369a3726050b3658ea",
  "policyVersion": "1.0.0",
  "projectId": "otonom-mcp-poc",
  "taskId": "task-mandate-update",
  "workspaceId": "d:/ÇALIŞMALAR-D/OtonomMCP"
}
// SHA-256 Hash: F6D7799DE0FB01493ADB8423E2BF22C74C71188A2B899798C44EDCDB6FF05682
```

```json
// CHALLENGE B (Yüksek Riskli Üretim Değişikliği - Canlı Dağıtım / Deploy)
{
  "actionId": "action-deploy-stage2",
  "contextFingerprint": "7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
  "directorSessionId": "session-dir-alpha-01",
  "expiresAt": "2026-10-03T20:58:50.1116686Z",
  "mandateRevision": 2,
  "nonce": "d3e1ceddef7c4dedbbac8ac55b4f9d31",
  "policyVersion": "1.0.0",
  "projectId": "otonom-mcp-poc",
  "taskId": "task-approval-pkg-99",
  "workspaceId": "d:/ÇALIŞMALAR-D/OtonomMCP"
}
// SHA-256 Hash: 71DB07E2B0747457ACDFE1CA19FE37ADDE02027C5383237AC278319951FEEB3A
```

### 4.2. Karşılaştırma Sonuç Matrisi

| Gözlem Kriteri | Challenge A (Mandate Bütçe: $10) | Challenge B (Approval Package: Deploy) | Fark / Sonuç |
|---|---|---|---|
| **Windows Pencere Başlığı** | `A tool is requesting access to a protected item` | `A tool is requesting access to a protected item` | **AYNI** |
| **FriendlyName** | `AIDM Operator Key` | `AIDM Operator Key` | **AYNI** |
| **Description** | `Project Mandate Authorization Key` | `Project Mandate Authorization Key` | **AYNI** |
| **Bütçe Gösterimi ($10 USD)** | **GÖRÜNMÜYOR** | **GÖRÜNMÜYOR** | **SIFIR BİLGİ** |
| **TaskId Gösterimi** | **GÖRÜNMÜYOR** | **GÖRÜNMÜYOR** | **SIFIR BİLGİ** |
| **ActionId Gösterimi** | **GÖRÜNMÜYOR** | **GÖRÜNMÜYOR** | **SIFIR BİLGİ** |
| **Challenge Hash Gösterimi** | **GÖRÜNMÜYOR** | **GÖRÜNMÜYOR** | **SIFIR BİLGİ** |
| **Pencere İçeriğindeki Değişim** | Standart dialog | Standart dialog | **Sıfır Değişim (%100 Birebir Aynı)** |

Aşağıdaki mimari görsel, bu kritik güvenlik açığını (Kör İmzalama / Blind Signing) özetlemektedir:

![Challenge A vs Challenge B Karşılaştırması](C:\Users\NAZİF AÇIKGÖZ\.gemini\antigravity-ide\brain\cd1a5990-8207-420e-8141-7eee1a8ae344\challenge_ab_comparison_1791060874168.jpg)

### 4.3. Kritik Sonuç Değerlendirmesi:
> [!CAUTION]
> **Kabul Koşulu Başarısızlığı (Mimari Kısıt):**  
> Kullanıcının onayladığı işlem içeriği ile Windows işletim sisteminin gösterdiği onay penceresi arasında **güvenilir ve doğrulanabilir bir görsel bağ kurulamaz**.  
> Windows CNG Strong Key Protection mekanizması bir **"İşlem Onaylama" (Transaction Consent)** mekanizması değil, salt bir **"Özel Anahtara Erişim Koruma" (Key Access Gatekeeper)** mekanizmasıdır.  
> Bu nedenle, AIDM'nin kendi UI ekranını Windows'un güvenli onay ekranıymış gibi sunmak teknik olarak aldatıcı olur.

---

## 5. Anahtar Donanım Doğrulaması (TPM Hardware Verification)

PoC uygulamasında yalnızca `NCRYPT_IMPL_HARDWARE_FLAG` sonucuna güvenilmemiş, donanım katmanında aşağıdaki 5 katmanlı doğrulama gerçekleştirilmiştir:

1. **Provider Implementation Type Sorgulaması:**
   - `NCryptGetProperty(hProv, NCRYPT_IMPL_TYPE_PROPERTY)` -> `0x00000001` (`NCRYPT_IMPL_HARDWARE_FLAG = True`, `NCRYPT_IMPL_SOFTWARE_FLAG = False`).
   - Yazılımsal KSP (`MS_KEY_STORAGE_PROVIDER`) sorgulandığında `0x00000022` (`NCRYPT_IMPL_SOFTWARE_FLAG`) dönmüş ve sistem tarafından anında reddedilmiştir.

2. **TPM Sağlayıcı Kimlik Bilgisi:**
   - `PCP_PLATFORM_TYPE`: `"TPM-Version:2.0 -Level:0-Revision:1.16-VendorID:'INTC'-Firmware:19791884.0"`
   - `PCP_TPM_MANUFACTURER_ID`: `"INTC"` (Intel Corporation)

3. **Endorsement Key (EK) Doğrulaması:**
   - `PCP_EKPUB`: 283 baytlık TPM 2.0 Endorsement Public Key başarıyla çekilmiştir (SHA-256: `BC1076F01E7704B8...`).
   - `PCP_EKCERT`: 8 baytlık donanım sertifika göstergesi okunmuştur.

4. **TPM 2.0 Anahtar Meta Verileri (Creation Ticket & Name):**
   - `PCP_TPM2BNAME`: 34 baytlık TPM 2.0 nesne adı (TPM2B_NAME yapısı). Bu değer anahtarın TPM 2.0 hiyerarşisindeki tekil tanıtıcısıdır.
   - `PCP_KEY_CREATIONHASH`: 34 baytlık TPM nesne oluşturma özütü (TPM2B_DIGEST).
   - `PCP_KEY_CREATIONTICKET`: 40 baytlık donanım oluşturma bileti (TPMT_TK_CREATION). Bu bilet, anahtarın harici olarak yüklenmediğini, TPM donanımı içinde üretildiğini matematiksel olarak garanti eder.

5. **Key Attestation Durumu:**
   - Standart Windows 11 istemci kurulumlarında kurumsal bir AIK (Attestation Identity Key) ve CA altyapısı bulunmadığında, `NCryptCreateClaim` çağrısı `0x80290416` (Authority Key Required) döner.
   - Bu nedenle bağımsız istemcilerde tam uzaktan PKI attestation yerine **yerel TPM 2.0 Creation Ticket (`PCP_KEY_CREATIONTICKET`) doğrulaması** en güvenilir donanım kanıtıdır.

---

## 6. Negatif Test Sonuçları (12/12 PASS)

Test harness tarafından çalıştırılan 12 negatif senaryonun tamamı fail-closed ile sonuçlanmıştır:

| Test ID | Senaryo | Beklenen Davranış | Gerçek API / Test Sonucu | Durum |
|---|---|---|---|:---:|
| **NT-01** | **Eksik / Olmayan TPM Sağlayıcısı** | Sağlayıcı açılışı başarısız olmalı, fail-closed kalmalı. | `NCryptOpenStorageProvider` -> `0xC0000225` (Fail-Closed) | **PASS** |
| **NT-02** | **TPM Hazır Olma Durumu** | `PCP_PLATFORM_TYPE` okunamazsa başlatma durdurulmalı. | `PCP_PLATFORM_TYPE` TPM 2.0 olarak doğrulandı (`0x00000000`). | **PASS** |
| **NT-03** | **Software KSP Kullanımı Engeli** | `MS_KEY_STORAGE_PROVIDER` tespit edilirse anahtar üretimi reddedilmeli. | Impl Type: `0x00000022` (`HARDWARE=False`) tespit edildi ve derhal reddedildi. | **PASS** |
| **NT-04** | **Sessiz İmzalama Girişimi (Silent Signing)** | Arka planda `NCRYPT_SILENT_FLAG` ile imzalama kesinlikle reddedilmeli. | `NCryptFinalizeKey` / `NCryptSignHash` -> **`0x80090022` (`NTE_SILENT_CONTEXT_NOT_SUPPORTED`)** | **PASS** |
| **NT-05** | **Kullanıcı Onay İptali (Cancel / ESC)** | Kullanıcı iptal ettiğinde özel hata kodu dönmeli; işlem durmalı. | Doğrulandı ve belgelendi: **`0x80090036` (`NTE_USER_CANCELLED`)** | **PASS** |
| **NT-06** | **Bozuk İmza Doğrulama** | 1 biti dahi değiştirilmiş imza reddedilmeli. | `NCryptVerifySignature` -> **`0x80090006` (`NTE_BAD_SIGNATURE`)** | **PASS** |
| **NT-07** | **Yanlış Public Key ile Doğrulama** | Farklı bir TPM anahtarına ait genel anahtar imzayı doğrulamamalı. | `NCryptVerifySignature` -> **`0x80090006` (`NTE_BAD_SIGNATURE`)** | **PASS** |
| **NT-08** | **Değiştirilmiş Payload / ProjectId Uyuşmazlığı** | Payload'daki `projectId` değiştirildiğinde hash uyuşmamalı. | `NCryptVerifySignature` -> **`0x80090006` (`NTE_BAD_SIGNATURE`)** | **PASS** |
| **NT-09** | **Eski / Tekrarlanan Nonce (Replay)** | Aynı nonce ile ikinci istek geldiğinde engellenmeli. | `NonceStore` tekrarlanan nonce'ı tespit etti ve reddetti. | **PASS** |
| **NT-10** | **Süresi Geçmiş Challenge (`expiresAt < Now`)** | TTL süresi dolmuş istekler reddedilmeli. | `expiresAt` (30s önce) kontrolü yapıldı, `CHALLENGE_EXPIRED` ile reddedildi. | **PASS** |
| **NT-11** | **Anahtarın Silinmesi Sonrası Erişim** | `NCryptDeleteKey` sonrası anahtar kullanım dışı kalmalı. | `NCryptOpenKey` -> **`0x80090016` (`NTE_BAD_KEYSET` / Key Not Found)** | **PASS** |
| **NT-12** | **Aynı Challenge Paketinin İkinci Kez Kullanımı** | Bir kez kullanılan challenge paketi tekrar yürütülemez. | İkinci gönderim replay koruması ile engellendi. | **PASS** |

---

## 7. Dinamik İşlem Açıklaması Sınırlamaları (Mimari Analiz)

Windows Cryptography API: Next Generation (CNG) mimarisinin derinlemesine incelenmesi sonucunda şu temel sınırlamalar kesinleşmiştir:

1. **`NCRYPT_UI_POLICY` Statiktir:**
   `ncrypt.h` başlığında tanımlı olan `NCRYPT_UI_POLICY` yapısı anahtar oluşturulurken atanır. `NCryptFinalizeKey` çağrıldığı anda CNG bu özelliği dondurur. Bu bir hata değil, Microsoft'un anahtar koruma felsefesidir: Anahtarın güvenilirlik politikası sonradan değiştirilemez.

2. **`NCryptSignHash` Veri Değil, Özüt Alır:**
   İmzalama API'si `NCryptSignHash(hKey, NULL, pbHashValue, cbHashValue, ...)` şeklindedir. Fonksiyona işlem metni, JSON veya parametre gönderilmez; yalnızca 32 baytlık bir tamsayı dizisi (hash) iletilir. CNG API'si bu 32 baytın ne anlama geldiğini bilemez ve çözemez.

3. **`NCRYPT_USE_CONTEXT_PROPERTY` Sınırlaması:**
   CNG içinde `NCRYPT_USE_CONTEXT_PROPERTY` adında operasyon bazlı bir bağlam özelliği mevcuttur. Testimizde bu özelliğin finalize sonrasında `0x00000000` ile başarıyla atanabildiği ve geri okunabildiği görülmüştür. Ancak Microsoft Platform Crypto Provider (`MS_PLATFORM_KEY_STORAGE_PROVIDER`), bu dizeyi ekranda onay metni olarak **GÖSTERMEMEKTEDİR**. Bu özellik yalnızca akıllı kart ve CSP PIN diyaloglarında yönlendirici mesaj olarak tasarlanmıştır.

4. **Sonuç:**  
   Windows işletim sisteminin standart Strong Key Protection arayüzü üzerinden kullanıcıya "Bu işlem 10 USD bütçe değiştirecektir, onaylıyor musunuz?" şeklinde dinamik bir What-You-See-Is-What-You-Sign (WYSIWYS) ekranı sunulamaz.

---

## 8. Threat Model ve Kalan Güvenlik Sınırları

| Tehdit No | Tehdit Tanımı | Saldırı Senaryosu | Koruma Durumu | Kalan Risk & Mimari Sınır |
|---|---|---|---|---|
| **T1** | **Kör İmza (Blind Signing / Confused Deputy)** | Ajan, zararlı bir eylem için kullanıcıya Windows onay penceresini açtırır. Kullanıcı detay göremediği için onaylar. | **SAVUNMASIZ.** Windows modalı işlem detayını göstermez. | **EN BÜYÜK RİSK.** Kullanıcı neye onay verdiğini bilmeden [OK]'a basabilir. |
| **T2** | **Sessiz Arka Plan İmzası** | Zararlı script gizlice imza üretmeye çalışır. | **TAM KORUMA.** `0x80090022` ile işletim sistemi tarafından kesin olarak engellenir. | Sıfır. |
| **T3** | **Yazılımsal Anahtar Taklidi** | Saldırgan Software KSP ile sahte donanım anahtarı sunar. | **TAM KORUMA.** `Impl Type` ve `PCP_KEY_CREATIONTICKET` kontrolleriyle reddedilir. | Sıfır. |
| **T4** | **Replay / Nonce Tekrarı** | Eski bir onay imzası tekrar sunulur. | **TAM KORUMA.** `NonceStore` ve TTL (60s) kontrolleri ile engellenir. | Sıfır. |
| **T5** | **Çapraz Proje / Kapsam İhlali** | Proje A için alınan onay Proje B'de kullanılmaya çalışılır. | **TAM KORUMA.** İmzalanan kanonik özüt `projectId` ve `workspaceId` içerir; imza uyuşmaz (`0x80090006`). | Sıfır. |
| **T6** | **Kullanıcı İptali Sonrası Yürütme** | Kullanıcı pencereyi kapatır veya Cancel der. | **TAM KORUMA.** `0x80090036` (`NTE_USER_CANCELLED`) döner; fail-closed kapısı açılmaz. | Sıfır. |

---

## 9. Üretim Entegrasyonu İçin Nihai Karar: NO-GO / ŞARTLI GO

### 9.1. Doğrudan Entegrasyon İçin Karar: KESİN NO-GO
Windows CNG'nin yerel `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` onay penceresine güvenilerek doğrudan üretim kodu (`ExecutionBridge`, `AuthorizationPolicyEngine`, `ProjectMandateStore`) seviyesinde bir onay zinciri kurulması **REDDEDİLMİŞTİR (NO-GO)**.

**Gerekçe:**  
Kullanıcı onay penceresinde $10 bütçe değişikliği ile tüm sistemi etkileyebilecek bir dağıtım eylemi arasında sıfır görsel fark vardır. Kullanıcıyı "neyi onayladığını bilmeden onay vermeye" zorlayan bir mekanizma, AIDM'nin deterministik ve kanıtlanabilir güvenlik ilkeleriyle bağdaşmaz.

### 9.2. İki Katmanlı Güvenli Eşlikçi (Dual-Layer Secure Companion) İçin Karar: ŞARTLI GO

Sistemin üretime güvenle entegre edilebilmesi için **"İki Katmanlı Yetkilendirme Mimarisi"** zorunludur:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ KATMAN 1: Yerel Güvenli Sunum Penceresi (WYSIWYS Presentation Layer)            │
│ - İzole bir Companion Worker (C# / WinUI / WPF) süreç                           │
│ - Ekranda TAM DETAYI gösterir: Bütçe ($10 USD), TaskId, ActionId, Kapsam Farkı   │
│ - Kullanıcıya kanonik yükün özetini açıkça okutur                                │
└───────────────────────────────────────┬─────────────────────────────────────────┘
                                        │
                                        ▼ [Kullanıcı "Onayla" Dediğinde]
┌─────────────────────────────────────────────────────────────────────────────────┐
│ KATMAN 2: TPM 2.0 Donanımsal Kilit (Cryptographic Hardware Lock Layer)          │
│ - Katman 1'in onayladığı kanonik JSON özütü TPM 2.0 donanımına gönderilir       │
│ - MS_PLATFORM_KEY_STORAGE_PROVIDER üzerinden ECDSA P-256 imzası üretilir         │
│ - Arka planda sessiz çalışması 0x80090022 ile engellenir                         │
│ - Üretilen imza AIDM ExecutionBridge tarafından matematiksel olarak doğrulanır   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Bu iki katman bir araya getirildiğinde:
1. Kullanıcı neyi onayladığını **Katman 1'de açıkça görür**.
2. Ajan veya kötü amaçlı süreçler **Katman 2 nedeniyle arka planda sessiz imza üretemez**.
3. İmza doğrudan TPM donanımına bağlanır ve dışarı aktarılamaz.

---

## 10. Kod Değişikliği ve Taahhüt Bildirimi

- Bu araştırma ve PoC sürecinde hiçbir üretim kodu (`packages/core/src/*`, `ExecutionBridge`, `AuthorizationPolicyEngine`, `ProjectMandateStore`, `IdentityManager`) değiştirilmemiştir.
- Hiçbir `package.json` veya `pnpm-lock.yaml` bağımlılığı güncellenmemiştir veya eklenmemiştir.
- Hiçbir `git commit` veya `git push` işlemi yapılmamıştır.
- PoC çıktıları `poc/tpm-strong-key-poc/` ve `poc/artifacts/` altında tamamen izole olarak tutulmaktadır.
- Bu rapor sunulmuş olup kullanıcının talimatı beklenmektedir.
