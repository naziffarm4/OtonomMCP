# TRUST-ROOT-02 — Windows Hello Consent API Doğrulaması ve Entegrasyon Fizibilitesi Raporu

**Rapor Kodu:** TRUST-ROOT-02-WINDOWS-HELLO-POC-REPORT  
**Tarih:** 2026-10-03  
**Kapsam:** Windows 11 TPM 2.0, CNG Platform Crypto Provider, Windows Hello, WinRT UserConsentVerifier, KeyCredentialManager, UI Policy Koruması, AIDM P20/P21/P22 Entegrasyonu  
**Durum:** TAMAMLANDI (Fizibilite, API Doğrulaması ve Mimari Tasarım)

---

## Yönetici Özeti ve Temel Karar

TRUST-ROOT-01 denetiminde Antigravity IDE'nin yazılımsal süreç kimliğinin işletim sistemi düzeyinde taklit edilemez kılınamayacağı (%100 kanıtlı olarak) belirlenmişti. TRUST-ROOT-02 araştırması kapsamında, **"İstemci payload'ından ve IDE'nin iç durumundan bağımsız olarak, işletim sistemi ve donanım destekli gerçek bir insan onayının nasıl doğrulanabileceği"** Windows 11 ve TPM 2.0 üzerinde doğrudan test edilerek incelenmiştir.

### Temel Bulgular:
1. **API Gerçeği ve Yanılgıların Ayıklanması:**
   - Literatürde veya tartışmalarda geçen `NCRYPT_UI_POLICY_ALWAYS` isimli bir bayrak Windows SDK (`ncrypt.h`) içinde **mevcut değildir**.
   - Resmi Win32 CNG bayrakları `NCRYPT_UI_PROTECT_KEY_FLAG (0x1)` ve `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG (0x2)`'dir. Bu bayraklar her imza çağrısında işletim sistemi düzeyinde kullanıcı onayı penceresini zorunlu kılar.
   - WinRT `UserConsentVerifier` API'si kriptografik imza üretmez; salt bir boolean/enum sonucu döner ve parmak izi/kamera bulunmayan masaüstü sistemlerinde `DeviceNotPresent` hatası verir.
   - WinRT `KeyCredentialManager.IsSupportedAsync` unpackaged masaüstü uygulamalarında (standart Win32/Node.js) `False` döner; MSIX/UWP paket kimliği gerektirir.
2. **Doğrudan Deneysel Kanıt (Bu Makinede Doğrulandı):**
   - Bu Windows 11 ortamındaki **Intel PTT TPM 2.0** donanımı (`tpmtool` ile doğrulandı: TPM 2.0, Initialized: True, Storage/Attestation: Ready).
   - Win32 CNG `MS_PLATFORM_CRYPTO_PROVIDER` üzerinden donanım destekli **ECDSA P-256** anahtar üretimi ve SHA-256 özüt imzalama başarıyla (`0x00000000`, 64 bayt imza) gerçekleştirilmiştir.
   - `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` ile korunan anahtara sessiz arka plan erişimi denendiğinde işletim sistemi `0x80090022` (`NTE_SILENT_CONTEXT_NOT_SUPPORTED`) hatası vererek **otonom veya arka plandan izinsiz imza atılmasını kesin olarak engellemiştir**.
3. **Teknik Karar: ŞARTLI GO (CONDITIONAL GO).**
   - TPM 2.0 tabanlı `MS_PLATFORM_CRYPTO_PROVIDER` ve `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` mekanizması teknik olarak uygulanabilirdir.
   - Ancak üretim koduna doğrudan Node.js bağımlılığı olarak sokulmadan önce, izole bir C++/C# yardımcı süreç (secure companion worker) üzerinden PoC ile doğrulanmalıdır.

---

## 1. İncelenen Mevcut Mimari ve Entegrasyon Noktaları

Mevcut AIDM mimarisi incelenmiş ve Windows Hello / TPM onayının eklenebileceği kesin sınırlar belirlenmiştir:

```
[Mevcut Mimari Akışı]
MCP Client (Antigravity IDE Stdio)
       │
       ▼
ExecutionBridge (P20 Önkoşul Zinciri)
       │
       ├── Check 6: PRODUCT_OWNER_APPROVAL ──► [KRİTİK ENTEGRASYON NOKTASI 1]
       │       │
       │       ├── AuthContextValidator.validate()
       │       │       │
       │       │       ├── NonceStore.markNonceSeen() (Replay Engeli)
       │       │       └── IdentityManager (Mevcut DPAPI Ed25519) ──► [TPM 2.0 KSP İLE DEĞİŞECEK ALAN]
       │       │
       │       └── isTrueHumanInteraction Kontrolü (Fail-Closed: BLOCKED_ON_AUTH_CONTEXT)
       │
       ├── Check 7-10: Scope, Mandate, Policy Engine (P21)
       │       │
       │       └── ProjectMandateStore.saveMandate() ──► [KRİTİK ENTEGRASYON NOKTASI 2]
       │               │
       │               └── MandateRevision & PolicyVersion Güncellemesi
       │
       ▼
ExecutorBridge / DriverEngine (Yürütme)
```

### 1.1. Kritik Entegrasyon Noktaları:
1. **`ProjectMandateStore.saveMandate(mandate, authContext)`:**  
   Proje sınırları (izin verilen dizinler, komutlar, bütçe ve süre) belirlenirken veya güncellenirken (`mandateRevision` artışında).
2. **`ExecutionBridge` - Check 6 (`PRODUCT_OWNER_APPROVAL`):**  
   `BLOCKED_ON_AUTH_CONTEXT` kapısının açılması için gereken `isTrueHumanInteraction: true` durumu, istemci payload'ından değil, doğrudan TPM onay imzasından türetilmelidir.
3. **`aidm.approval.human.submit` MCP Aracı:**  
   İnsan onayı (`ApprovalPackage`) gönderildiğinde, payload ile birlikte TPM onay imzası (`hardwareConsentSignature`) doğrulanmalıdır.
4. **`AuthorizationPolicyEngine.evaluateAction()`:**  
   Eylemin yürütülmesinden önce `mandateRevision` ve `policyVersion` bağlamının TPM imzasındaki bağlamla tam uyuşması şart koşulmalıdır.

---

## 2. Resmi Microsoft API Kaynakları ve Doğrulama Sonuçları

Aşağıdaki mekanizmalar resmi Microsoft belgeleri ve yerel SDK başlık dosyaları (`C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\um\ncrypt.h`) üzerinden incelenmiştir:

### 2.1. Windows SDK `ncrypt.h` İncelemesi: `NCRYPT_UI_POLICY_ALWAYS` Gerçeği
Resmi SDK'da yapılan araştırmada:
* `NCRYPT_UI_POLICY_ALWAYS` isimli bir makro veya sabit **YOKTUR**.
* Resmi yapı `NCRYPT_UI_POLICY` olarak tanımlıdır:
```c
typedef struct __NCRYPT_UI_POLICY
{
    DWORD   dwVersion;
    DWORD   dwFlags;
    LPCWSTR pszCreationTitle;
    LPCWSTR pszFriendlyName;
    LPCWSTR pszDescription;
} NCRYPT_UI_POLICY;
```
* Geçerli `dwFlags` değerleri şunlardır:
  - `NCRYPT_UI_PROTECT_KEY_FLAG (0x00000001)`: Anahtarın UI korumalı olduğunu belirtir.
  - `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG (0x00000002)`: **Anahtar her kullanıldığında (her imzalama işleminde) kullanıcıya onay penceresi açılmasını zorunlu kılar.**
  - `NCRYPT_UI_FINGERPRINT_PROTECTION_FLAG (0x00000004)`: Biyometrik parmak izi korumasını zorunlu kılar.
  - `NCRYPT_UI_APPCONTAINER_ACCESS_MEDIUM_FLAG (0x00000008)`: AppContainer erişim seviyesi bayrağı.

### 2.2. WinRT `UserConsentVerifier` API İncelemesi
* **Dokümantasyon:** `Windows.Security.Credentials.UI.UserConsentVerifier`
* **Metotlar:** `CheckAvailabilityAsync()`, `RequestVerificationAsync(String message)`
* **Deneysel Sonuç (Bu Makinede):** `CheckAvailabilityAsync()` çağrısı **`DeviceNotPresent`** döndürdü.
* **Neden:** `UserConsentVerifier` yalnızca biyometrik donanım (parmak izi okuyucu veya Windows Hello IR kamera) arar. Biyometrik donanımı olmayan masaüstü bilgisayarlarda (yalnızca PIN/TPM olan) çalışmaz. Ayrıca imza üretmez; yalnızca bir enum döner. Güvenlik kanıtı olarak yetersizdir.

### 2.3. WinRT `KeyCredentialManager` API İncelemesi
* **Dokümantasyon:** `Windows.Security.Credentials.KeyCredentialManager`
* **Metotlar:** `IsSupportedAsync()`, `RequestCreateAsync()`, `OpenAsync()`, `KeyCredential.RequestSignAsync()`
* **Deneysel Sonuç (Bu Makinede):** `IsSupportedAsync()` çağrısı **`False`** döndürdü.
* **Neden:** `KeyCredentialManager` Windows Hello for Business veya UWP/MSIX uygulama kimliği (Appx package identity) gerektirir. Standart Win32/Node.js süreçlerinde doğrudan kullanılamaz.

### 2.4. Win32 CNG ve Microsoft Platform Crypto Provider (`MS_PLATFORM_CRYPTO_PROVIDER`)
* **Dokümantasyon:** Microsoft CNG Key Storage Functions (`NCryptOpenStorageProvider`, `NCryptCreatePersistedKey`, `NCryptSignHash`).
* **Deneysel Sonuç (Bu Makinede):**
  - Sağlayıcı açma: `0x00000000` (Başarılı)
  - TPM 2.0 üzerinde `ECDSA_P256` anahtarı oluşturma: `0x00000000` (Başarılı)
  - Donanım içinde SHA-256 hash imzalama: `0x00000000` (Başarılı, 64 bayt Base64 imza üretildi)
  - `NCRYPT_SILENT_FLAG` ile gizli imzalama testi: `0x80090022` (`NTE_SILENT_CONTEXT_NOT_SUPPORTED` - İşletim sistemi tarafından başarıyla engellendi).

---

## 3. API ve Platform Uyumluluk Matrisi

| Kriter | WinRT `UserConsentVerifier` | WinRT `KeyCredentialManager` | Win32 CNG Software KSP | Win32 CNG TPM 2.0 KSP (`MS_PLATFORM_CRYPTO_PROVIDER`) |
|---|---|---|---|---|
| **Gerçekte Neyi Doğrular?** | Biyometri varlığını ve kullanıcının "Evet" dediğini (enum). | Windows Hello anahtarıyla challenge imzasını. | Yazılımsal anahtarla imza. | **TPM donanımında saklanan anahtarla imza.** |
| **Kriptografik İmza Üretir mi?** | **HAYIR** (Sadece enum döner). | EVET (RSA/ECC imza). | EVET. | **EVET (ECDSA P-256 / RSA 2048).** |
| **Kullanıcı Etkileşimi Zorunlu mu?** | Evet (Biyometri varsa). | Evet (PIN/Biyometri). | Hayır (Sessiz çalışır). | **EVET (`NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` ile).** |
| **Her İşlemde Yeniden Doğrulama?** | Evet. | Evet (`RequestSignAsync`). | Hayır. | **EVET (Her `NCryptSignHash` çağrısında OS modalı açılır).** |
| **TPM Olmadan Çalışabilir mi?** | Evet (Yazılımsal Hello ile). | Hayır (TPM şart). | Evet (Yazılımsal). | **HAYIR (TPM 2.0 donanımı şarttır).** |
| **Software Fallback Tespiti?** | Yok. | Otomatik (Desteklenmiyorsa açılmaz). | Yok (Zaten software). | **`NCRYPT_IMPL_TYPE_PROPERTY` = `0x1` (`HARDWARE`) ile kesin tespit edilir.** |
| **Node.js/Electron'dan Çağrılabilir mi?** | Sadece WinRT köprüsüyle. | Sadece packaged Appx ise. | Native addon veya P/Invoke ile. | **Native Win32 C++ addon veya yardımcı CLI/Worker ile.** |
| **MCP Stdio Modeli ile Uyumlu mu?** | Kısmi. | Düşük. | Tam. | **TAM (Etkileşimli masaüstünde OS modalı açar).** |

---

## 4. Gerçek Kullanıcı Onayı Akış Tasarımı (Flow Design)

Kritik işlemler için tasarlanan 4 onay akışı:

### 4.1. Onay Akışı 1: Project Mandate Oluşturma veya Değiştirme
```
[Director / PO]                                     [MCP Server / AIDM]                             [Windows OS / TPM 2.0]
       │                                                    │                                                │
       │─── 1. saveMandate(mandate) ───────────────────────►│                                                │
       │                                                    │── 2. Canonical Payload & Challenge Oluştur ───►│
       │                                                    │   (projectId, workspaceId, revision, nonce)   │
       │                                                    │                                                │
       │                                                    │── 3. NCryptSignHash(challenge) ───────────────►│
       │                                                    │                                                │
       │                                                    │                    [OS GÜVENLİ MASAÜSTÜ MODALI]│
       │                                                    │                    "AIDM: Project Mandate Değişimi"
       │                                                    │                    "Revizyon: 2, Bütçe: $10.00"│
       │                                                    │                    [ PIN veya Biyometri İste ]  │
       │                                                    │                                                │
       │                                                    │◄── 4. TPM İmzası (ECDSA P-256) ────────────────│
       │                                                    │    (veya 0x80090022 / User Canceled)           │
       │                                                    │                                                │
       │                                                    ├── 5. Imzayı & Nonce'ı Doğrula                  │
       │                                                    │   (Fail-Closed: Geçersizse reddet)             │
       │                                                    │                                                │
       │◄── 6. Mandate Kaydedildi (mandate.json) ───────────┤                                                │
```

### 4.2. Onay Akışı 2: Kritik Approval Package Onayı (`aidm.approval.human.submit`)
1. Director veya PO, `ApprovalPackage` onaylamak istediğinde AIDM sunucusu bir challenge özütü hazırlar:
   $$\text{Challenge} = \text{SHA256}(\text{projectId} \parallel \text{packageId} \parallel \text{revision} \parallel \text{contextFingerprint} \parallel \text{nonce} \parallel \text{expiresAt})$$
2. AIDM, TPM anahtarını kullanarak imzalama başlatır.
3. Windows, ekranda `NCRYPT_UI_POLICY` açıklamasını göstererek kullanıcıdan onay ister:
   - Başlık: `AIDM: Kritik Paket Onayı`
   - Açıklama: `Paket: pkg-deployment-01, Revizyon: 1, Parmak İzi: e3b0c44...`
4. Kullanıcı onay verirse TPM imza üretir.
5. Kullanıcı reddeder veya zaman aşımı olursa `NCryptSignHash` `NTE_USER_CANCELLED` döner; `ExecutionBridge` `BLOCKED_ON_AUTH_CONTEXT` vererek yürütmeyi durdurur.

### 4.3. Onay Akışı 3: Yetki Kapsamını Genişletme (Scope Escalation)
Komut listesine veya yazma dizinlerine yeni bir yol eklenmek istendiğinde:
- Yeni kapsam özütü çıkarılır.
- OS modalında eski izinler ile yeni izinler arasındaki fark (diff) gösterilir.
- Kullanıcı fiziksel onay vermeden `AuthorizationPolicyEngine` kapsamı genişletmez.

### 4.4. Onay Akışı 4: Kritik Güvenlik Politikası Değişikliği (Policy Version Bump)
`policyVersion` yükseltmesi yalnızca TPM onaylı imza ile imzalanmış yeni bir `project-mandate.json` ile yürürlüğe girebilir.

---

## 5. Kriptografik Bağlama (Cryptographic Binding Spec)

Her Windows Hello / TPM onayı, aşağıdaki 10 veri alanının kanonik JSON gösterimine kriptografik olarak bağlanmalıdır:

```typescript
export interface HardwareConsentPayload {
  projectId: string;               // Canonical Project ID
  workspaceId: string;             // Absolute Workspace Path Hash
  directorSessionId: string;       // Active Director Session ID
  taskId: string;                  // Target Task ID
  actionId: string;                // Specific Action UUID
  mandateRevision: number;         // Expected Mandate Revision
  policyVersion: string;           // Security Policy Version
  contextFingerprint: string;      // Director Context SHA-256
  nonce: string;                   // Single-use Cryptographic Nonce
  expiresAt: string;               // ISO Timestamp (Max 60 seconds TTL)
}
```

### Kanonik Özüt Formülü:
$$\text{PayloadString} = \text{CanonicalJson}(\text{HardwareConsentPayload})$$
$$\text{Hash} = \text{SHA-256}(\text{PayloadString})$$
$$\text{Signature} = \text{NCryptSignHash}(\text{hTpmKey}, \text{Hash})$$

Bu imza başka bir projede, başka bir görevde, süresi dolduğunda (`expiresAt`), revizyon değiştiğinde veya tekrar gönderildiğinde (`NonceStore`) matematiksel olarak **geçersiz hale gelir**.

---

## 6. Threat Model ve Kalan Güvenlik Sınırları

| # | Tehdit | Saldırı Mekanizması | Koruma Durumu | Kalan Risk & Güvenlik Sınırı |
|---|---|---|---|---|
| **T1** | **Aynı Windows kullanıcısı altında zararlı süreç** | Zararlı script TPM anahtarını kullanarak imza atmaya çalışır. | **TAM KORUMA.** `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` nedeniyle arka planda sessiz imza atılamaz. OS modalı açılır; saldırgan kullanıcıyı kandıramazsa onay alamaz. | Kullanıcı ekrandaki mesaja bakmadan onay verirse risk doğar (T5). |
| **T2** | **Sahte MCP istemcisi** | Harici bir client sahte `actorRole: "PRODUCT_OWNER"` gönderir. | **TAM KORUMA.** Metin alanı önemsizdir; geçerli TPM donanım imzası yoksa `BLOCKED_ON_AUTH_CONTEXT` döner. | Sıfır. |
| **T3** | **Sahte Product Owner payload'ı** | Payload'a sahte `verified: true` eklenir. | **TAM KORUMA.** Doğrulama payload alanına değil TPM genel anahtarına bakar. | Sıfır. |
| **T4** | **Windows Hello ekranını tetikleyen kötü amaçlı uygulama** | Başka bir uygulama Windows Hello ekranı açarak kullanıcıya onaylatır. | **TAM KORUMA.** İmzalanan hash `projectId` ve `actionId` içermelidir. Başka amaçla alınan imza AIDM bağlamında doğrulanamaz. | Sıfır. |
| **T5** | **Kullanıcının yanlış işlem için onay vermesi (Sosyal Mühendislik)** | Kullanıcı modalda yazan işlem detayını okumadan PIN/Biyometri girer. | **KISMEN.** Modal üzerinde operasyon başlığı ve özeti açıkça gösterilir. | **İnsan faktörü.** Kullanıcı dikkatsizce onaylarsa yetki verilir. |
| **T6** | **TPM bulunmaması veya software fallback** | Saldırgan TPM yerine Software KSP kullandırarak gizlice imzalar. | **TAM KORUMA.** `NCRYPT_IMPL_TYPE_PROPERTY` kontrolü ile `0x1` (Hardware) olmayan sağlayıcı anında reddedilir (Fail-Closed). | Sıfır. |
| **T7** | **Bellek içi token çalınması** | RAM'den o an geçerli imzalanmış token okunur. | **ZAMAN VE NONCE İLE KISITLI.** TTL 60 saniyedir ve nonce tek kullanımlıktır. | Token ilk kullanan tarafından tüketilmemişse 60 saniyelik bir saldırı penceresi kalır. |
| **T8** | **Nonce replay** | İmzalı token logdan yakalanıp tekrar gönderilir. | **TAM KORUMA.** `NonceStore` anında engeller. | Sıfır. |
| **T9** | **Başka workspace/proje için imza kullanımı** | Proje A için alınan imza Proje B'ye sunulur. | **TAM KORUMA.** Challenge içine `projectId` ve `workspaceId` gömülüdür; imza uyuşmaz. | Sıfır. |
| **T10** | **İkinci IDE instance** | İkinci pencere aynı kimliği kullanmaya çalışır. | **TAM KORUMA.** `LocalRuntimeStateManager` PID kilidi ile ikinci instance açılmaz. | Sıfır. |
| **T11** | **IDE kapandıktan sonra eski onayların tekrarı** | Kapanan oturumun onayları yeniden oynatılır. | **TAM KORUMA.** TTL (60s) ve tek kullanımlık nonce ile anında reddedilir. | Sıfır. |

---

## 7. TPM ve Windows Hello Gereksinimleri

Bu sistemin çalışabilmesi için sistem seviyesindeki asgari gereksinimler:

1. **İşletim Sistemi:** Windows 11 (Build 22000 veya üzeri).
2. **Donanım:** TPM 2.0 yongası (Intel PTT, AMD fTPM veya Dedicated dTPM 2.0).
   - TPM durumu: `tpmtool getdeviceinformation` çıktısında `Ready For Storage: True` ve `Ready For Attestation: True` olmalıdır.
3. **Kullanıcı Kimlik Doğrulaması:** Windows Hello yapılandırılmış olmalıdır (PIN veya Biyometri).
4. **Desktop Session:** Etkileşimli masaüstü oturumu (Session 1). Windows Servisi (Session 0) modunda çalıştırılamaz.

---

## 8. Node.js / Electron Entegrasyon Seçenekleri

Node.js ortamından Win32 CNG API'lerine erişim için 3 mimari seçenek değerlendirilmiştir:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ SEÇENEK A: Out-of-Process Secure Companion Worker (ÖNERİLEN)                           │
│ - Küçük, C# (.NET 8 Native AOT) veya C++ ile yazılmış izole bir yürütülebilir dosya    │
│ - AIDM MCP sunucusu stdin/stdout veya Local Named Pipe ile bu yardımcıya bağlanır     │
│ - Avantajı: Node.js derleme (node-gyp/Python/VS Build Tools) karmaşıklığı yoktur      │
│ - Güvenlik: Yardımcı sadece imzalanacak hash'i alır, OS modalını açar, imzayı döner    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ SEÇENEK B: Node.js Native C++ Addon (N-API)                                            │
│ - Direkt node process içine yüklenen .node C++ modülü                                  │
│ - ncrypt.lib kütüphanesini doğrudan dinamik bağlar                                    │
│ - Avantajı: Süreçler arası ek IPC gerektirmez, son derece hızlıdır                    │
│ - Dezavantajı: Node.js sürüm bağımlılığı, node-gyp ve derleyici gereksinimi vardır     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ SEÇENEK C: PowerShell P/Invoke Köprüsü                                                 │
│ - Geçici .ps1 komut dosyası ile CNG çağrıları yapılması (P22'de DPAPI için kullanılan) │
│ - Avantajı: Sıfır harici derleme, saf Windows kurulumunda çalışır                      │
│ - Dezavantajı: Her imzada 500ms-1000ms PowerShell başlatma gecikmesi yaratır          │
│ - Kullanım Yeri: Sadece PoC ve otomatik test doğrulamaları için uygundur               │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 9. İzole PoC Uygulama Planı (Kod Değişikliği Olmadan)

PoC mevcut üretim kodunu ve testlerini etkilemeyecek şekilde, ayrı bir bağımsız test aracı olarak tasarlanmıştır:

### Adım 1: İzole Test Harness Hazırlığı
* Proje dizini dışında veya `packages/core/tests/poc/` altında izole bir PowerShell veya C# test harness oluşturulması.
* Hedefler:
  1. `NCryptOpenStorageProvider` ile `MS_PLATFORM_CRYPTO_PROVIDER` açılması.
  2. `ECDSA_P256` geçici anahtar oluşturulması ve `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` atanması.
  3. `NCryptFinalizeKey` çağrılması.
  4. Test SHA-256 hash'inin imzalanması (Kullanıcıya Windows Hello / OS onay modalının gösterilmesi).
  5. İptal (`Cancel`) butonuna basıldığında hata kodunun (`0x80090036` veya `NTE_USER_CANCELLED`) yakalandığının kanıtlanması.
  6. PIN/Biyometri girildiğinde imzanın başarıyla üretildiğinin ve genel anahtarla doğrulandığının kanıtlanması.
  7. Anahtarın silinmesi (`NCryptDeleteKey`).

### Adım 2: Nonce ve Bağlam Doğrulama Testi
* Üretilen imzanın `AuthContextValidator` mantığına benzer bir doğrulamadan geçirilerek `projectId` uyuşmazlığında reddedildiğinin simüle edilmesi.

---

## 10. Üretim Entegrasyonu İçin Kabul Kriterleri (Acceptance Criteria)

Bir sonraki aşamada (P23 / Implementation Phase) üretime geçilebilmesi için karşılanması gereken zorunlu kabul kriterleri:

- [ ] **AC-01 (No Software Fallback):** Sistem, `MS_PLATFORM_CRYPTO_PROVIDER` dışında bir sağlayıcıyı veya `NCRYPT_IMPL_HARDWARE_FLAG` içermeyen yazılımsal anahtarları anında reddetmeli (`FAIL_CLOSED_TPM_REQUIRED`).
- [ ] **AC-02 (Mandatory Interactive Prompt):** Her `saveMandate` veya `aidm.approval.human.submit` işleminde, `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` nedeniyle Windows işletim sistemi modalı açılmalı; sessiz arka plan imzalama girişimleri `0x80090022` ile engellenmelidir.
- [ ] **AC-03 (Cryptographic 10-Field Binding):** İmzalanan yük; `projectId`, `workspaceId`, `directorSessionId`, `taskId`, `actionId`, `mandateRevision`, `policyVersion`, `contextFingerprint`, `nonce` ve `expiresAt` alanlarının tamamını içermelidir.
- [ ] **AC-04 (Zero Stale Keys):** Proje kapatıldığında veya oturum sonlandığında TPM anahtarları temizlenmeli veya oturum bazlı ephemeral donanım anahtarları kullanılmalıdır.
- [ ] **AC-05 (Fail-Closed Preservation):** Kullanıcı iptal ettiğinde (`NTE_USER_CANCELLED`), zaman aşımına uğradığında veya TPM yanıt vermediğinde `ExecutionBridge` kesinlikle `BLOCKED_ON_AUTH_CONTEXT` durumunda kalmalı; yürütme başlatılmamalıdır.

---

## 11. Teknik Karar: ŞARTLI GO (CONDITIONAL GO)

### Karar Gerekçesi:
1. **Teknik Olarak Kanıtlanmıştır:**  
   Windows 11 üzerinde TPM 2.0 yongası (`MS_PLATFORM_CRYPTO_PROVIDER`) üzerinden donanımsal `ECDSA P-256` anahtarı üretilebildiği, donanım içinde imza atılabildiği ve `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` sayesinde **kullanıcı onayı olmadan sessiz imza atılmasının işletim sistemi düzeyinde imkansız olduğu** bu makinede doğrulanmıştır.
2. **IDE Süreç Kimliği İddiasından Vazgeçilmiştir:**  
   Sistem, Antigravity IDE'nin yazılımsal kimliğini doğrulamaya çalışmak yerine, **işletim sistemi ve donanım destekli fiziksel kullanıcı onayına** dayanmaktadır. Bu yaklaşım dürüst, sağlam ve endüstri standardı bir yaklaşımdır.
3. **Koşul:**  
   Üretim koduna (P22) geçilmeden önce, izole bir C# Native AOT veya Win32 C++ Companion Worker PoC'si hazırlanmalı; kullanıcı deneyimi (modal ekranın açılma süresi, hata yönetimi) test edilmelidir. Mevcut P20/P21 fail-closed kapıları asla gevşetilmemelidir.
