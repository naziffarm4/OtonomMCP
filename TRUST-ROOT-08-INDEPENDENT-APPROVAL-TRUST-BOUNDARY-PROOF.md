# TRUST-ROOT-08 — Independent Approval Trust Boundary Proof

**Rapor Kodu:** TRUST-ROOT-08-INDEPENDENT-APPROVAL-TRUST-BOUNDARY-PROOF  
**Tarih:** 2026-10-04  
**Görev Türü:** SECURITY ARCHITECTURE RESEARCH / ADVERSARIAL FEASIBILITY  
**Mod:** READ-ONLY (Tamamen Salt-Okunur Güvenlik Mimarisi Kanıtı)  
**Öncelik:** CRITICAL  
**Bağımlılıklar:** TRUST-ROOT-01, TRUST-ROOT-02, TRUST-ROOT-03, TRUST-ROOT-04, DIRECTOR-INTERACTION-01, DIRECTOR-INTERACTION-02, TRUST-ROOT-05, TRUST-ROOT-06, TRUST-ROOT-07  
**Kod Değişikliği:** YASAK (Sıfır Üretim Kodu, Sıfır Paket, Sıfır API Çağrısı)

---

## 1. Yönetici Özeti

Bu çalışma, TRUST-ROOT serisinin (01-07) birikimli bulgularını sentezleyerek, OtonomMCP için **"Antigravity/AGY uygulayıcısından tamamen bağımsız, kullanıcının yalnızca Director ile muhatap olduğu ve IDE sınırları içinde kalan güvenilir bir insan onayı mimarisinin var olup olmadığını"** matematiksel, mimari ve sistem güvenliği ilkeleriyle kesin olarak kanıtlamak amacıyla yürütülmüştür.

### 1.1. Nihai Hüküm ve Karar Özeti

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ NİHAİ KARAR: KESİN NO-GO (TAM BAĞIMSIZ ARAYÜZ İÇİ ONAY MİMARİSİ İMKANSIZDIR)           │
│                                                                                        │
│ Belirlenen 7 Değiştirilemez Kısıt Altında:                                             │
│ 1. Kullanıcı yalnızca Director ile muhataptır.                                         │
│ 2. AGY yalnızca uygulayıcıdır; karar verici veya bağımsız arayüz sahibi değildir.      │
│ 3. AIDM ikinci bir GUI/CLI/sohbet penceresi açamaz.                                    │
│ 4. Tüm etkileşim yalnızca Antigravity IDE içinde kalmalıdır.                           │
│ 5. İkinci cihaz, dış bulut tüneli veya harici web kancası kullanılamaz.                │
│ 6. P18-04 / P20 Check 6 kapısı fail-closed kalacaktır.                                 │
│ 7. Donanım anahtarı (TPM) tek başına insan onayı sayılamaz.                            │
│                                                                                        │
│ MATEMATİKSEL VE MİMARİ KANIT:                                                          │
│ Kullanıcı ile AIDM arasındaki tek iletişim ve piksel oluşturma kanalı AGY'nin denetim- │
│ indeki IDE sohbeti ve `default_api:ask_question` aracı olduğu sürece, AGY aradaki      │
│ "Tek İletişim Hattı (In-Band Proxy)" konumundadır.                                     │
│                                                                                        │
│ Güvenlik kuramı gereği: "Tüm girdi ve çıktıları kontrol eden güvenilmeyen bir aracıya  │
│ (untrusted in-band proxy) karşı, bağımsız bir bant dışı kanal (out-of-band channel)   │
│ olmaksızın soru ve cevap bütünlüğü ile WYSIWYS garantisi SAĞLANAMAZ."                  │
│                                                                                        │
│ Bu nedenle P18-04 / P20 Check 6 kapısının "tamamen bağımsız arayüz içi onayla otomatik │
│ üretime açılması" KESİN OLARAK İMKANSIZDIR (NO-GO).                                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Önceki TRUST-ROOT Çalışmalarının Doğrulanmış Sonuçları

TRUST-ROOT-08, önceki yedi araştırmanın ampirik ve deneysel bulguları üzerine inşa edilmiştir:

1. **[TRUST-ROOT-01](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-01-FEASIBILITY-REPORT.md) (İşlem Kimliği Sınırı):**
   - Windows NT DACL modeli altında, aynı kullanıcı oturumu (`same-user / same-integrity`) içinde çalışan süreçler birbirlerinin belleğine (`ReadProcessMemory`/`WriteProcessMemory`), pencerelerine (`UIAutomation`/`SetWindowsHookEx`) ve DPAPI anahtarlarına tam erişime sahiptir.
   - IDE'nin veya MCP istemcisinin kimliği yerel zararlılara karşı işletim sistemi seviyesinde kanıtlanamaz.

2. **[TRUST-ROOT-02](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-02-WINDOWS-HELLO-POC-REPORT.md) & [TRUST-ROOT-03](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-03-TPM-STRONG-KEY-POC-REPORT.md) (TPM 2.0 & Windows Hello Donanım Sınırı):**
   - TPM 2.0 CNG KSP (`MS_PLATFORM_KEY_STORAGE_PROVIDER`) ile oluşturulan anahtarlar donanım dışına çıkartılamaz (`NCRYPT_EXPORT_POLICY_PROPERTY = 0`).
   - `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` bayrağı ile arka planda sessiz imzalama kesin olarak engellenir (kod: `0x80090022 - NTE_SILENT_CONTEXT`).
   - **Kritik Kısıt:** Windows Hello / CNG modalı statiktir. Eylemin parametrelerini, dosya yollarını, bütçe tutarlarını veya kullanıcının onay/ret niyetini ekranda gösteremez (**Kör İmzalama / Blind Signing**).

3. **[TRUST-ROOT-04](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-04-SECURE-COMPANION-THREAT-MODEL.md) (Secure Companion Tehdit Modeli):**
   - Ayrı bir Companion GUI, kullanıcının "İkinci bir kullanıcı arayüzü oluşturulamaz" kuralını çiğner.
   - Ayrıca aynı kullanıcı SID'si altında çalıştığı sürece Clickjacking, DLL Injection ve Named Pipe spoofing saldırılarına karşı korumasızdır.

4. **[DIRECTOR-INTERACTION-01](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/DIRECTOR-INTERACTION-01-FEASIBILITY-REPORT.md) & [DIRECTOR-INTERACTION-02](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/DIRECTOR-INTERACTION-02-IDENTITY-SEPARATION-REPORT.md) (Antigravity IDE Etkileşim Sınırı):**
   - Antigravity IDE içinde kullanıcıya interaktif modal açabilen tek mekanizma `default_api:ask_question` aracıdır.
   - Bu araç yalnızca aktif Antigravity Ajanına (AGY) aittir. Harici ChatGPT Director veya AIDM MCP sunucusu bu aracı doğrudan ve bağımsız olarak çağıramaz.

5. **[TRUST-ROOT-05](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-05-HUMAN-APPROVAL-ARCHITECTURE-DECISION.md) & [TRUST-ROOT-06](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-06-ADVERSARIAL-VALIDATION-REPORT.md) (Hasmane Denetim ve Manipülasyon Kanıtı):**
   - AGY'nin "UI Courier" olarak kullanıldığı modelde, AGY soru metnini değiştirebilir ("Bütçeyi artır" yerine "Kodu formatla" gösterebilir).
   - Kullanıcı modalda "Reddet" seçse bile, AGY AIDM'e "Kullanıcı Onayladı" bildirebilir ve arkasından TPM modalını tetikleyebilir. Kullanıcı ekranda işlem detayını görmediği için Windows modalına onay vererek aldatılabilir.

6. **[TRUST-ROOT-07](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-07-INDEPENDENT-APPROVAL-CHANNEL-REPORT.md) (Bağımsız Onay Kanalı Fizibilitesi):**
   - İki kanallı Kısa Doğrulama Kodu (SAS) yaklaşımı değerlendirilmiş; ancak SAS kodunun da yine AGY aracılığıyla ekrana basılması durumunda güvenlik halkasının kırılabileceği tespit edilmiştir.

---

## 3. Mimari Seçeneklerin Karşılaştırması (A - H)

| Mimari | Tanım | Resmi Doküman & API Desteği | Güven Sınırı | Saldırı Yüzeyi | Kullanıcı Deneyimi | Operasyonel Gereksinimler | Sonuç |
|---|---|---|---|---|---|---|:---:|
| **A. ask_question + AGY Courier** | IDE içi `default_api:ask_question` modalı AGY tarafından açılır. | Antigravity IDE Native Tool API | Sıfır (AGY denetiminde) | Soru tahrifatı, şık manipülasyonu, ret cevabını onaya çevirme | Mükemmel (IDE içi diyalog) | Ek araç yok | **VULNERABLE** |
| **B. ChatGPT Web Oturumu** | Kullanıcı onayı doğrudan web tarayıcısındaki OpenAI ChatGPT oturumundan verir. | OpenAI Custom Actions (REST API) | OpenAI Bulut Oturumu | Yerel makinenin genel internete tünellenmesi (ngrok/Cloudflare), ağ dinleme | Kötü (Kullanıcı IDE'den çıkıp tarayıcıya geçer) | İnternet erişimi, public endpoint, SSL cert | **UNPROVEN / NOT_SUPPORTED** |
| **C. Başka Güvenilir İstemci (Companion)** | Yerel ayrı bir GUI (WPF/Electron) veya Win32 Secure Desktop prompt. | Win32 CredUI / Custom App | Windows Masaüstü Oturumu | Same-user DACL saldırıları, UIAutomation, Clickjacking | Orta/Kötü ("İkinci UI yok" kuralını çiğner) | Ayrı derleme, GUI bakım yükü | **VULNERABLE / KURAL İHLALİ** |
| **D. Windows Service / Ayrı Windows Kullanıcısı** | AIDM ayrı bir `LocalSystem` veya özel servis kullanıcısı (`AIDM_Service`) altında çalışır. | Windows Service Control Manager (SCM), Windows Integrity Levels | Güçlü (İşletim sistemi SID sınırı) | IPC kanalı üzerinden erişim denetimi | Kötü (UAC şifreleri, izole masaüstü geçişleri) | Yönetici (Administrator) kurulumu | **KURAL İHLALİ (IDE Dışı)** |
| **E. TPM / Windows Hello / FIDO2** | Donanım güvenlik çipi (TPM 2.0) ve biyometrik Windows Hello onayı. | Windows CNG KSP (`ncrypt.dll`), FIDO2 WebAuthn | Donanım Çipi (TPM Silicon) | Kör İmzalama (Blind Signing): Ekranda işlem parametreleri görünmez | Yüksek (Sistem parmak izi/PIN) | TPM 2.0 donanımı | **PARTIALLY MITIGATED (Kör İmza)** |
| **F. Ayrı Cihaz Üzerinden Onay** | Mobil uygulama, SMS OTP veya Authenticator Push bildirimi. | Push Notification Services (APNs/FCM) | Tam Bant Dışı (Out-of-band Physical Hardware) | Ağ güvenliği, bulut altyapısı kesintisi | Orta (Telefonu eline alması gerekir) | Mobil uygulama, sunucu altyapısı, internet | **KURAL İHLALİ (IDE Dışı)** |
| **G. Antigravity IDE Extension / Bağımsız Panel** | IDE'nin kendi Webview veya Extension API'si üzerinden bağımsız panel açması. | Antigravity IDE Plugin/Extension API | IDE Renderer Sınırı | Antigravity IDE'de MCP sunucuları için bağımsız GUI extension API'si YOKTUR | Bilinmiyor | IDE çekirdek desteği | **NOT_SUPPORTED** |
| **H. Kriptografik Manifest + Kullanıcı Girişli SAS** | Director onay isteğini şifreli/hash'li bir manifestoya bağlar; kullanıcı kodu elle yazar. | Saf Kriptografi (SHA-256 + HMAC-SHA256) | Kriptografik Bilgi Sınırı | Kullanıcının kodu nereden okuduğu: Eğer AGY gösteriyorsa AGY kodu da bilir! | Kabul edilebilir (6 haneli doğrulama kodu) | Sıfır ek donanım | **PARTIALLY MITIGATED** |

---

## 4. Resmî API ve Dokümantasyon Kanıtları

### 4.1. Antigravity IDE Ajan ve Araç Modeli
- **Deklarasyon:** Antigravity IDE araç tanımları (`default_api:ask_question`) yalnızca IDE LLM çalışma zamanına (AGY) enjekte edilir.
- **Kanıt:** MCP sunucuları yalnızca `tools/call` JSON-RPC çağrılarını yanıtlar; IDE arayüzüne doğrudan DOM elemanı, modal veya mesaj pencereleri basamaz. Kullanıcıya giden tüm metinler AGY'nin yanıt akışından ve araç çağrılarından geçer.
- **Sonuç:** AGY'nin müdahale edemeyeceği bağımsız bir IDE içi kanal Antigravity mimarisinde teknik olarak mevcut değildir.

### 4.2. Microsoft Windows CNG KSP ve UI Sınırları
- **Resmi API:** `ncrypt.dll` fonksiyonları: `NCryptOpenStorageProvider`, `NCryptCreatePersistedKey`, `NCryptSetProperty`, `NCryptSignHash`.
- **Kanıt:** `NCRYPT_UI_POLICY_PROPERTY` yapısı incelendiğinde parametreler şunlardır:
  ```c
  typedef struct __NCRYPT_UI_POLICY {
      DWORD   dwVersion;
      DWORD   dwFlags;
      LPCWSTR pszCreationTitle;
      LPCWSTR pszFriendlyName;
      LPCWSTR pszDescription;
  } NCRYPT_UI_POLICY;
  ```
  `pszFriendlyName` ve `pszDescription` anahtar oluşturulurken bir defa yazılır ve statiktir. Her imza işleminde dinamik işlem özeti (örneğin "Action: Execute, Target: package.json, Budget: $50") diyalog penceresine basılamaz.
- **Sonuç:** Kullanıcı Windows Hello penceresinde yalnızca "Antigravity Otonom Key" başlığını görür. Ne imzaladığını göremez.

### 4.3. OpenAI ChatGPT Actions ve Asimetrik İmza
- **Resmi API:** OpenAI GPT Actions / API belgeleri.
- **Kanıt:** OpenAI Actions, giden web kancalarında mTLS veya kullanıcı oturumuna özel bir asimetrik imza anahtarı sunmaz. İstekler standart HTTP `Bearer` veya API anahtarıyla yapılır.
- **Sonuç:** "Director buluttan kendi anahtarıyla imzalar" hipotezi OpenAI tarafından desteklenmemektedir (`NOT_SUPPORTED`).

---

## 5. Zorunlu Saldırı Senaryoları Matrisi (13 Senaryo)

Aşağıdaki matris, incelenen mimarilerin 13 kritik saldırı senaryosu karşısındaki ampirik ve mantıksal durumunu gösterir:

| # | Saldırı Senaryosu | Mimari A (ask_question) | Mimari D (TPM Only) | Mimari H (Manifest + SAS) | Nihai Güvenlik Durumu |
|---|---|:---:|:---:|:---:|:---:|
| **1** | **AGY soru metnini değiştiriyor** | **VULNERABLE** | **VULNERABLE** | **PARTIALLY MITIGATED** | **VULNERABLE (Tam Korunamıyor)** |
| **2** | **AGY seçenekleri değiştiriyor** | **VULNERABLE** | **VULNERABLE** | **PROVEN BLOCKED** | **PARTIALLY MITIGATED** |
| **3** | **AGY önerilen seçeneği değiştiriyor** | **VULNERABLE** | **VULNERABLE** | **PROVEN BLOCKED** | **PARTIALLY MITIGATED** |
| **4** | **Kullanıcı reddediyor, AGY onay iletiyor** | **VULNERABLE** | **VULNERABLE** | **PROVEN BLOCKED** | **PROVEN BLOCKED (SAS ile)** |
| **5** | **Kullanıcıya soru gösterilmeden onay** | **VULNERABLE** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED (TPM ile)** |
| **6** | **AGY sahte Director cevabı oluşturuyor** | **VULNERABLE** | **VULNERABLE** | **PARTIALLY MITIGATED** | **PARTIALLY MITIGATED** |
| **7** | **Aynı Windows kullanıcısı zararlı süreç** | **VULNERABLE** | **PARTIALLY MITIGATED** | **PARTIALLY MITIGATED** | **VULNERABLE (DAC Sınırı)** |
| **8** | **Sahte MCP istemcisi** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED (Check 6)** |
| **9** | **Director imza anahtarının çalınması** | **VULNERABLE** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED (TPM Donanımı)** |
| **10** | **Replay ve nonce tekrar kullanımı** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED (NonceStore)** |
| **11** | **Yanlış proje, workspace veya session** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED (Fingerprint)** |
| **12** | **IDE kapanması ve yeniden başlatılması** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED (RuntimeState)** |
| **13** | **Onaydan sonra action içeriğinin değişimi** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED** | **PROVEN BLOCKED (Hash Check)** |

### Saldırı Analizlerinin Detayları

1. **Senaryo 1-3 (AGY Soru Metnini / Seçenekleri / Öneriyi Değiştiriyor):**
   - *Durum:* **VULNERABLE**.
   - *Gerekçe:* `ask_question` parametrelerini (`question`, `options`) AGY hazırlar. Director'ın arkadaki niyet metni AGY tarafından manipüle edilip kullanıcıya zararsız gösterilebilir.
2. **Senaryo 4 (Kullanıcı Reddediyor, AGY Onay İletiyor):**
   - *Durum:* TPM tek başına kullanıldığında **VULNERABLE**, SAS kodu eklendiğinde **PROVEN BLOCKED**.
   - *Gerekçe:* Kullanıcı [Reddet] dediğinde AGY modal sonucunu yok sayıp AIDM'e `approved` dönebilir. Kullanıcı TPM modalında parametre görmediği için onaylayabilir. Ancak kullanıcı onaylamak için Director'ın ürettiği gizli bir SAS kodunu elle girmek zorunda ise, kullanıcı reddettiğinde bu kodu girmez; AGY bu kodu kullanıcının yerine tahmin edemez.
3. **Senaryo 5 (Soru Gösterilmeden Arka Planda Onay Üretilmesi):**
   - *Durum:* **PROVEN BLOCKED**.
   - *Gerekçe:* TPM 2.0 `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` bayrağı ile korunur. Ekrana fiziksel Windows Hello PIN/biyometri penceresi gelmeden imza alınamaz; sessiz çağrılar `0x80090022` ile fail-closed düşer.
4. **Senaryo 7 (Aynı Windows Kullanıcısı Altında Kötü Amaçlı Süreç):**
   - *Durum:* **VULNERABLE**.
   - *Gerekçe:* Windows NT güvenlik mimarisi gereği aynı kullanıcı oturumundaki işlemler birbirine karşı bir güvenlik sınırı (security boundary) oluşturmaz.
5. **Senaryo 10-13 (Replay, Yanlış Workspace, IDE Kapanması, TOCTOU Tahrifatı):**
   - *Durum:* **PROVEN BLOCKED**.
   - *Gerekçe:* AIDM `NonceStore`, `ProjectMandateStore`, `LocalRuntimeStateManager` ve `ExecutionBridge` hash kontrolleri sayesinde oturum, proje ve eylem yükü tahrifatları kesin olarak engellenir.

---

## 6. Önemli Güvenlik Boyutlarının Ayrımı

Güvenlik analizinde kavram yanılgılarını önlemek için 8 temel boyut birbirinden kesin çizgilerle ayrılmıştır:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ SEKİZ TEMEL GÜVENLİK BOYUTU VE MEVCUT GERÇEKLİK                                        │
│                                                                                        │
│ 1. Kullanıcı Kimliği Doğrulaması : [SAĞLANDI] Windows Hello / PIN / Biyometri.         │
│ 2. Donanım Anahtarı Koruması     : [SAĞLANDI] TPM 2.0 KSP (Donanımdan çıkarılamaz).    │
│ 3. AGY Kimliği Doğrulaması       : [KISMEN] Stdio PID denetimi (Aynı kullanıcı zayıf). │
│ 4. Director Kimliği Doğrulaması  : [GÜVENSİZ] Bulut asimetrik anahtarı yok.            │
│ 5. Soru İçeriğinin Bütünlüğü     : [GÜVENSİZ] AGY modal parametrelerini tahrif edebilir│
│ 6. Kullanıcı Cevabının Bütünlüğü : [GÜVENSİZ] AGY ret yanıtını onaya çevirebilir.      │
│ 7. Görülen = İmzalanan (WYSIWYS) : [İMKANSIZ] Windows Hello penceresi parametre basamaz│
│ 8. Bilinçli İnsan Onayı          : [RİSKLİ] Kullanıcı neyi onayladığını kesin göremez. │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Temel Kural:** Donanım anahtarının TPM içinde korunuyor olması (Boyut 2), kullanıcının bilinçli ve tahrif edilmemiş bir işlemi onayladığı (Boyut 7 ve 8) anlamına GELMEZ.

---

## 7. Kullanıcı Etkileşimi ve Director-Only Uyumluluğu

Kullanıcının belirlediği kesin kural:
> *"Kullanıcı yalnızca Director ile etkileşim kuracak. AIDM ayrı bir kullanıcı arayüzü veya ikinci bir sohbet ajanı oluşturmayacak. AIDM yalnızca Antigravity IDE içinde çalışacak."*

Bu kural şu teknik sonuçları doğurur:

1. **Bağımsız Masaüstü Uygulaması Açılamaz:** Electron, WPF veya ayrı CLI pencereleri kuralı çiğner.
2. **Harici Web / Mobil Açılamaz:** Kullanıcıyı tarayıcıya veya telefona yönlendirmek IDE içi çalışma şartını bozar.
3. **AGY'nin Aradan Çıkarılması İmkansızdır:** Antigravity IDE'nin tek interaktif iletişim motoru AGY'dir. Dolayısıyla Director'ın kullanıcıya mesaj göndermesi teknik zorunluluk olarak AGY'nin pencerelerinden geçmek zorundadır.

**Kaçınılmaz Çelişki (The Unresolvable Conflict):**
- Kullanıcı yalnızca IDE içinde ve Director ile konuşmak istemektedir.
- Ancak IDE içindeki sohbet hattını AGY kontrol etmektedir.
- Bu durumda AGY'nin aracı (courier) olmadığı bir kanal IDE içinde FİZİKSEL VE YAZILIMSAL OLARAK YOKTUR.

---

## 8. Uygulanabilir Hedef Mimari: Sınırlar ve Mitigasyonlar

Eğer üretim ortamında çalışılacaksa, ulaşılabilecek en yüksek güvenlikli mimari **"İki Kademeli Kriptografik Manifest + SAS Doğrulamalı Donanım Kilidi"** modelidir:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ UYGULANABİLİR EN İLERİ MİTİGASYON MODELİ (SAS + TPM DUAL LOCK)                         │
│                                                                                        │
│ 1. Director Soru & Manifest Hazırlar:                                                  │
│    - Eylem: ActionPayload (Bütçe, Dosya Değişikliği vb.)                               │
│    - manifestHash = SHA256(ActionPayload + ProjectID + SessionID + Nonce)              │
│    - sasCode = Top6Chars(HMAC-SHA256(manifestHash, SessionSecret)) [Örn: "7A4-9F2"]    │
│                                                                                        │
│ 2. Soru IDE Dosya Sisteminde Mühürlenir:                                               │
│    - AIDM, çalışma alanına `.ai-manager/manifests/decision-<nonce>.md` yazar.         │
│    - Kullanıcıya: "Lütfen yukarıdaki dosyayı inceleyiniz ve onay kodunu giriniz" der.  │
│                                                                                        │
│ 3. AGY UI Modalı Açar (default_api:ask_question):                                      │
│    - Soru: "Eylemi onaylamak için manifest dosyasındaki onay kodunu giriniz:"         │
│    - Seçenekler:                                                                       │
│      [ ] İşlemi İptal Et / Reddet                                                      │
│      [ ] Onayla (Kodu yazarak)                                                         │
│                                                                                        │
│ 4. Doğrulama Kapısı (ExecutionBridge Check 6):                                         │
│    - Kullanıcı reddederse veya kod yanlışsa -> İŞLEM DERHAL İPTAL EDİLİR.             │
│    - Kullanıcı doğru `sasCode` girdiyse -> Windows Hello TPM modalı açılır.            │
│    - TPM donanım imzası alınır -> Check 6 açılır.                                     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Bu Modelin Gücü ve Zayıflığı
- **Kazanım:** Kullanıcı reddettiğinde AGY bunu onaya çeviremez; çünkü AGY kullanıcının girmediği kodu bilemez.
- **Kalan Zafiyet:** Eğer AGY kullanıcıya manifest dosyasının içeriğini farklı okutursa (veya manifestoyu değiştirmeye kalkarsa), kullanıcının gördüğü ile AIDM'in çalıştırdığı arasındaki bağ zayıflayabilir. Bu nedenle manifest dosyası hash kontrolüyle korunsa da, kullanıcının IDE editöründe gördüğü dosya içeriği hala AGY tarafından manipüle edilebilir.

---

## 9. Kalan Güvenlik Riskleri

1. **Arayüz İçi Tahrifat Riski (In-Band Manipulation):** AGY prompt injection veya model bozulması yaşarsa, kullanıcıya yanıltıcı yönlendirmeler yapabilir.
2. **Kör İmzalama (Blind Signing):** Windows Hello modalında teknik parametrelerin görünmemesi, phishing ve click-fatigue saldırılarına kapı aralar.
3. **Same-User DAC Sınırı:** Geliştiricinin bilgisayarında çalışan başka bir Node.js, Python veya arka plan süreci AIDM dosyalarını okuyabilir.

---

## 10. Kabul Kriterleri (İleride GO Alabilmek İçin Gerekli Şartlar)

Bir mimarinin gelecekte **GO** alabilmesi için aşağıdaki koşulların eksiksiz sağlanması zorunludur:

1. **İkincil Bağımsız Görüntüleyici (Trusted Display):** Kullanıcının neyi imzaladığını harici veya işletim sistemi korumalı bir ekranda (örneğin FIDO2 CTAP2 ekranlı güvenlik anahtarı veya Windows Secure Desktop) doğrudan görebilmesi.
2. **Kriptografik Soru Bütünlüğü:** Soru metninin ve seçeneklerinin AGY tarafından değiştirilmediğinin matematiksel kanıtı.
3. **Geri Alınamaz Ret Güvencesi:** Kullanıcı ret cevabı verdiğinde donanım katmanında işlemin kesin olarak iptal edilmesi.
4. **Director İmza Güven Kökü:** Director'ın kimliğinin yerel bir taklitçi veya aracı ajan tarafından sahtelenemeyecek bağımsız bir donanım/bulut PKI köküne bağlanması.

---

## 11. GO / CONDITIONAL GO / NO-GO Kararı

TRUST-ROOT-08 görev tanımının 9. bölümündeki kesin Karar Kuralı uygulanmıştır:

> *"Bir mimari yalnızca aşağıdaki koşulların tümünü karşılıyorsa GO alabilir:*
> - *AGY onay içeriğini değiştirememeli.*
> - *AGY kullanıcı cevabını değiştirememeli.*
> - *Director'ın güvenilirliği bağımsız biçimde doğrulanabilmeli.*
> - *Kullanıcı ret cevabı onaya dönüştürülememeli.*
> - *Onay belirli bir action, proje, session ve context fingerprint'e bağlanmalı.*
> - *Kullanıcının gördüğü işlem ile yürütülen işlem arasındaki bağ kanıtlanabilmeli.*
> - *Director-only kullanıcı etkileşimi korunmalı.*
> *Bu koşullardan biri kanıtlanamıyorsa NO-GO ver."*

### Değerlendirme Tablosu

| Kriter No | Kriter Açıklaması | Mevcut Durum | Kanıt |
|---|---|:---:|---|
| **1** | AGY onay içeriğini değiştirememeli | **BAŞARISIZ** | AGY `ask_question` parametrelerini tam kontrol eder (`DIRECTOR-INTERACTION-02`). |
| **2** | AGY kullanıcı cevabını değiştirememeli | **BAŞARISIZ** | Arayüz içi yanıtta AGY gelen cevabı AIDM'e farklı iletebilir (`TRUST-ROOT-06`). |
| **3** | Director güvenilirliği bağımsız doğrulanabilmeli | **BAŞARISIZ** | OpenAI API'sinden yerel makineye asimetrik PKI imza kanalı yoktur. |
| **4** | Ret cevabı onaya dönüştürülememeli | **ŞARTLI BAŞARILI** | Saf TPM ile başarısız; SAS kodu girilmediğinde kısmen engellenebilir. |
| **5** | Action, proje, session fingerprint bağı | **BAŞARILI** | AIDM `ExecutionBridge` ve `ProjectMandateStore` hash kontrolü tamdır. |
| **6** | Görülen işlem ile yürütülen işlem bağı (WYSIWYS) | **BAŞARISIZ** | Windows Hello modalı kördür; AGY arayüzü tahrif edilebilir (`TRUST-ROOT-03`). |
| **7** | Director-only kullanıcı etkileşimi korunmalı | **BAŞARILI** | İkinci GUI veya harici sohbet açılmamıştır. |

### Karar

```
══════════════════════════════════════════════════════════════════════════════════════════
NİHAİ MİMARİ KARAR: KESİN NO-GO
══════════════════════════════════════════════════════════════════════════════════════════

1. P18-04 / P20 Check 6 kapısının üretim ortamına "tamamen bağımsız arayüz içi onayla"
   otomatik olarak açılması KESİN OLARAK REDDEDİLMİŞTİR (NO-GO).

2. GEREKÇE:
   Mevcut Antigravity IDE sınırları, Windows masaüstü güvenlik modeli ve OpenAI API 
   özellikleri dahilinde; AGY'nin aracı olmadığı, tahrifata kapalı ve kullanıcının neyi
   onayladığını donanım seviyesinde gördüğü bağımsız bir onay kanalı KURULAMAZ.

3. SİSTEM ÇALIŞMA MODU:
   OtonomMCP, P18-04 / P20 Check 6 kapısını FAIL-CLOSED tutmaya devam edecektir.
   Gerçek API çağrıları, ücretli servisler ve kritik dosya yazma operasyonları
   geliştirici tarafından terminal/CLI seviyesinde açık müdahale olmaksızın 
   tam otonom olarak icra EDİLEMEZ.
══════════════════════════════════════════════════════════════════════════════════════════
```
