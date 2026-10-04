# TRUST-ROOT-07 — Independent Human Approval Channel Feasibility Raporu

**Rapor Kodu:** TRUST-ROOT-07-INDEPENDENT-APPROVAL-CHANNEL-REPORT  
**Tarih:** 2026-10-04  
**Görev Türü:** SECURITY ARCHITECTURE RESEARCH / READ-ONLY  
**Öncelik:** CRITICAL  
**Bağımlılıklar:** TRUST-ROOT-03, TRUST-ROOT-04, DIRECTOR-INTERACTION-01, DIRECTOR-INTERACTION-02, TRUST-ROOT-05, TRUST-ROOT-06  
**Kod Değişikliği:** YASAK (Tamamen Salt-Okunur Güvenlik Mimarisi Araştırması)

---

## 1. Yönetici Özeti

Bu güvenlik mimarisi araştırması, [TRUST-ROOT-06](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-06-ADVERSARIAL-VALIDATION-REPORT.md) denetiminde kanıtlanan temel zafiyeti çözmek amacıyla yürütülmüştür:
> **"Director tarafından hazırlanan onay isteğinin kullanıcıya doğru gösterildiğini ve kullanıcının verdiği cevabın değiştirilmeden AIDM'e ulaştığını AGY'den bağımsız olarak nasıl doğrulayabiliriz?"**

### 1.1. Temel Bulgular ve Kök Gerçekler

1. **Arayüz İçi Güven Sınırı İmkansızlığı (The In-Band Proxy Paradox):**  
   Kullanıcının tek arayüzü Antigravity IDE sohbet paneli ise ve bu paneldeki tüm pikseller ile girdi olayları Antigravity IDE Ajanı (AGY) tarafından kontrol ediliyorsa; **AGY'den bağımsız, yazılımsal ve arayüz içi (in-band) bir insan onay kanalı kurmak matematiksel ve mimari olarak İMKANSIZDIR**.  
   Güvenlik aksiyomu gereği: *Güvenilmeyen bir aracı (untrusted proxy), bağımsız bir bant dışı (out-of-band) güven kökü veya paylaşılan bir gizli bilgi olmaksızın tahrif edilemez bir kanal sağlayamaz*.

2. **Yedi Mimari Alternatifinin İncelenmesi:**  
   İncelenen 7 mimariden (A-G):
   - **Mimari A (ask_question + AGY Courier):** AGY soru metnini ve cevabı manipüle edebilir (TRUST-ROOT-06'da FAILED).
   - **Mimari B & G (ChatGPT Cloud Webhook / Out-of-Band):** OpenAI API'si asimetrik PKI onay jetonu üretmez (`NOT_SUPPORTED`). Yerel makineyi genel internete tünel ile açmayı gerektirir; offline çalışamaz.
   - **Mimari C (Yerel AIDM Bağımsız Prompt):** Ayrı bir Companion GUI "İkinci arayüz oluşturulamaz" kuralıyla çelişir ve aynı kullanıcı DAC saldırılarına açıktır (`TRUST-ROOT-04`).
   - **Mimari D (Windows Hello / TPM / FIDO2):** Donanım anahtarı koruması ve fiziksel varlık sağlar; ancak işlem detaylarını gösteremez (Kör İmzalama).
   - **Mimari E (Ayrı İşletim Sistemi Servisi):** Yönetici hakları gerektirir; yerel geliştirme ortamı için aşırı kırılgandır.
   - **Mimari F (Director İmza Anahtarı):** Bulutta resmi API desteği yoktur; yerelde ise aynı kullanıcı altındaki süreçler tarafından okunabilir.

3. **Nihai Karar: KESİN NO-GO (Mevcut Üretim Entegrasyonu İçin).**  
   Mevcut Antigravity IDE, MCP ve Windows CNG altyapısında; hem kullanıcının tek muhatabının Director olduğu, hem AGY'nin aradan tamamen çıkarılabildiği, hem de işlem detaylarının donanım seviyesinde kanıtlandığı **mükemmel ve bağımsız bir onay kanalı henüz mevcut değildir**.  
   Güvenlik açıkları teorik varsayımlarla kapatılamayacağından, P18-04 / P20 Check 6 kapısının üretime açılması **KESİN OLARAK REDDEDİLMİŞTİR (NO-GO)**.

---

## 2. TRUST-ROOT-06 Problem Tanımı

TRUST-ROOT-06 hasmane denetiminde kesinleşen zafiyet zinciri şudur:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ MEVCUT GÜVEN KOPUKLUĞU (THE BROKEN TRUST CHAIN)                                        │
│                                                                                        │
│  [Director / AIDM]                                                                     │
│         │                                                                              │
│         │ 1. Kanonik Soru Paketi: "Bütçe $10 -> $50 yapılsın mı?" (Hash: #7A3F)        │
│         ▼                                                                              │
│  [Antigravity Ajanı (AGY) - Untrusted Courier]                                         │
│         │                                                                              │
│         │ 2. Saldırı: AGY modala "Kod biçimlendirilsin mi?" yazar (Metin Değişti!)     │
│         ▼                                                                              │
│  [Kullanıcı / Product Owner (IDE Ekranı)]                                              │
│         │                                                                              │
│         │ 3. Kullanıcı "Evet, biçimlendir" der ──► [Onayla] tıklar                     │
│         ▼                                                                              │
│  [Antigravity Ajanı (AGY)]                                                             │
│         │                                                                              │
│         │ 4. AGY, AIDM'e döner: "Kullanıcı #7A3F hash'li bütçe artışını onayladı!"     │
│         ▼                                                                              │
│  [Windows TPM 2.0 / CNG Modal]                                                         │
│         │                                                                              │
│         │ 5. Windows: "A tool is requesting access to a protected item" [OK]           │
│         │    (Pencerede bütçe görünmez; kullanıcı OK der)                              │
│         ▼                                                                              │
│  [ExecutionBridge Check 6]                                                             │
│         │                                                                              │
│         └──► SONUÇ: Kullanıcı kod formatlamayı onayladığını sanırken bütçe artırılır! │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Bu zafiyeti çözmek için gereken temel şart: **Kullanıcının gördüğü işlem ile imzalanan işlemin aynı olduğunu doğrulayan bağımsız bir kanal veya doğrulama yöntemidir**.

---

## 3. Alternatif Mimarilerin Karşılaştırması

İncelenen 7 alternatif mimari ayrıntılı olarak değerlendirilmiştir:

| Mimari No | Tanım | Saldırı Yüzeyi | Kimlik Doğrulama | WYSIWYS Garantisi | Kullanıcı Deneyimi | Maliyet / Karmaşıklık | Uygulanabilirlik |
|---|---|---|---|:---:|---|:---:|:---:|
| **A** | **IDE `ask_question` + AGY Courier** | AGY soruyu da cevabı da manipüle edebilir. | Zayıf (Salt UI) | **YOK (AGY kontrolünde)** | Mükemmel (IDE içi) | Düşük | Hazır, Güvensiz |
| **B** | **Director Bağımsız Dış Kanalı (Out-of-Band Push/Mobil)** | İkinci cihaz güvenlidir; yerel AGY kanala erişemez. | Güçlü (Cihaz Biyometrisi) | **TAM (Telefonda okur)** | Orta (İkinci cihaz gerekir) | Yüksek (Bulut altyapısı) | Mümkün, Altyapı Şart |
| **C** | **Yerel AIDM Bağımsız Prompt (Win32 CredUI / CLI)** | AGY aradan çıkar; ancak aynı kullanıcı zararlıları hedef alabilir. | Windows PIN / Parola | Kısmi (Kısa metin) | Orta (Sistem penceresi) | Düşük | Mümkün, UI Kısıtlı |
| **D** | **Windows Hello / TPM / FIDO2 Kombinasyonu** | Donanım anahtarı çalınamaz; arka plan sessiz imza engellenir. | Donanım / Biyometri | **YOK (Kör İmzalama)** | Yüksek (Windows modalı) | Orta | Hazır, WYSIWYS Yok |
| **E** | **Ayrı OS Güvenlik Sınırı (Windows Service / Admin)** | Medium Integrity süreçler erişemez (UIPI koruması). | İşletim Sistemi SID | Güçlü (İzole Masaüstü) | Kötü (UAC masaüstü geçişi) | Çok Yüksek | Hantal, Kırılgan |
| **F** | **Director İmza Anahtarı (Bulut vs. Yerel)** | Bulutta resmi API yok; yerelde aynı kullanıcıya açık. | Yazılımsal Anahtar | Dolaylı | Şeffaf | Düşük | Güven Köksüz |
| **G** | **ChatGPT Web Oturumu + Yerel Webhook** | Yerel zararlı buluta erişemez; ancak tünel ve ağ gerektirir. | OpenAI Oturumu | **TAM (ChatGPT ekranı)** | Orta (Web'e geçiş) | Orta (Tünel / Ağ) | API İmza Desteği Yok |

---

## 4. Teknik Uygulanabilirlik ve Resmi API Kanıtları

Her mimarinin resmi doküman ve API düzeyindeki karşılığı:

### 4.1. Mimari A (Antigravity IDE `ask_question`)
- **Resmi Destek:** `default_api:ask_question` deklarasyonu IDE içinde mevcuttur.
- **Engel:** Aracın tek çağırıcısı aktif Antigravity Ajanıdır (`DIRECTOR-INTERACTION-02`). Ajan untrusted proxy olduğu için güvenlik garantisi veremez.

### 4.2. Mimari B & G (ChatGPT Web / Cloud Direct Callback)
- **Resmi Destek:** OpenAI Custom GPT Actions (REST API over HTTPS).
- **Engel:** OpenAI Actions, giden isteklerde OpenAI kurumsal sertifikası dışında kullanıcıya özel asimetrik anahtarla mühürlenmiş **PKI imza jetonu ÜRETMEZ**. Yerel makineye gelen istek standart bir HTTPS `POST` isteğidir. Ayrıca yerel makinenin genel internete açılması (Cloudflare Tunnel / ngrok) zorunludur.

### 4.3. Mimari C (Win32 CredUI Prompt)
- **Resmi Destek:** `credui.dll` -> `CredUIPromptForWindowsCredentialsW`.
- **Yetenek:** `CREDUIWIN_SECURE_PROMPT` bayrağı ile UAC Güvenli Masaüstünde (Secure Desktop) modal açabilir.
- **Engel:** Kriptografik imza üretmez; yalnızca Windows kimlik doğrulaması yapar (boolean sonuç döner). Ayrıca "İkinci bir UI penceresi oluşturulamaz" mimari kararıyla çelişir.

### 4.4. Mimari D (Windows Hello / TPM 2.0 / FIDO2)
- **Resmi Destek:** `ncrypt.dll` -> `MS_PLATFORM_KEY_STORAGE_PROVIDER`.
- **Yetenek:** `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` ile arka planda sessiz çalışmayı `0x80090022` ile kesin olarak engeller.
- **Engel:** Windows onay diyalogu işlem detaylarını gösteremez (`TRUST-ROOT-03`).

---

## 5. Saldırı Senaryoları Matrisi (11 Saldırı Karşılaştırması)

| # | Saldırı Senaryosu | Mimari A (ask_question) | Mimari B (Out-of-Band) | Mimari C (Yerel Prompt) | Mimari D (TPM Only) | Önerilen Hibrit Model |
|---|---|:---:|:---:|:---:|:---:|:---:|
| **1** | AGY soruyu değiştirir | **BAŞARILI** (Savunmasız) | **ENGELLENİR** | **ENGELLENİR** | **BAŞARILI** | **ENGELLENİR** (SAS Kodu ile) |
| **2** | AGY seçenekleri değiştirir | **KISMEN** | **ENGELLENİR** | **ENGELLENİR** | **BAŞARILI** | **ENGELLENİR** (AIDM Doğrulama) |
| **3** | Ret cevabı onaya çevrilir | **BAŞARILI** (Savunmasız) | **ENGELLENİR** | **ENGELLENİR** | **BAŞARILI** | **ENGELLENİR** (SAS Eşleşmez) |
| **4** | Soru gösterilmeden onay | **ENGELLENİR** (Check 6) | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** (Fail-Closed) |
| **5** | Farklı action için kullanım | **ENGELLENİR** (Check 6) | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** (Hash Eşleşmez) |
| **6** | Aynı kullanıcı zararlı süreç | **BAŞARILI** (DAC açığı) | **ENGELLENİR** | **BAŞARILI** | Kısmi Koruma | Kısmi Koruma (TPM Kilidi) |
| **7** | Sahte MCP istemcisi | **ENGELLENİR** (Check 6) | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** (Check 6) |
| **8** | Nonce replay | **ENGELLENİR** (NonceStore) | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** (TTL + Nonce) |
| **9** | IDE kapanıp açılması | **ENGELLENİR** (Kilit) | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** (Stale Check) |
| **10** | Yanlış proje/workspace | **ENGELLENİR** (Binding) | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** | **ENGELLENİR** (Binding) |
| **11** | Director anahtarı çalınması | **BAŞARILI** | **ENGELLENİR** | **BAŞARILI** | Kısmi Koruma | Kısmi Koruma |

---

## 6. Director İmza Güven Kökü (Cloud vs. Local Analizi)

Director imzasının güven kökü problemi derinlemesine çözümlenmiştir:

1. **Bulut Tabanlı İmza Yanılsaması:**  
   OpenAI ChatGPT API veya Web platformu, istemciye özel bir private key barındırmaz. Dolayısıyla "Director imzası buluttan gelir" varsayımı ticari olarak uygulanamaz.
2. **Yerel Dosya Tabanlı İmza Yanılsaması:**  
   Anahtar `.ai-manager/state/` altında DPAPI ile saklanırsa, aynı Windows kullanıcısı altındaki herhangi bir PowerShell veya Node betiği bu anahtarı anında çözebilir (`TRUST-ROOT-01`).
3. **Gerçekçi Çözüm (Makine Donanımına Bağlı Director Yetkisi):**  
   Director'ın yetkisi ayrı bir gizli anahtarla değil; **AIDM'nin yerel çalışma kilidi ([LocalRuntimeStateManager](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/storage/runtime-state.ts)) ve TPM 2.0 donanım yetkilendirmesi** ile makineye bağlanmalıdır.

---

## 7. Kullanıcı Deneyimi ve Director-Only Uyumu

- **Director-Only Kuralı:** Kullanıcıya ayrı bir Companion GUI dayatmak veya ikinci bir sohbet botu açmak mimari bütünlüğü bozar.
- **En Sade Deneyim:** Kullanıcının IDE içindeki `ask_question` modalında işlem detaylarını okuması ve onaylamak için tek kullanımlık bir **Kısa Doğrulama Kodu (SAS)** girmesidir.
- Bu yaklaşım, AGY'nin aradaki manipülasyon yeteneğini sıfırlar; çünkü AGY kullanıcının yerine bu kodu tahmin edemez veya tahrif edemez.

---

## 8. Mevcut AIDM Kod Tabanıyla Entegrasyon

Mevcut OtonomMCP bileşenleri yeni mimariyi sıfır ek FSM veya DAG ile destekleyebilecek olgunluktadır:

- [DirectorReasoningEngine](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director-reasoning/director-reasoning-engine.ts): `REQUEST_HUMAN_DECISION` üretir.
- [DirectorActionBuilder](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director-action/director-action-builder.ts): Kanonik hash ve SAS kodunu oluşturur.
- [ExecutionBridge](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/execution-bridge/execution-bridge.ts): Check 6 kapısında hem SAS kodunu hem de TPM ECDSA P-256 donanım imzasını doğrular.

---

## 9. Maliyet ve Operasyonel Riskler

- **Maliyet:** Sıfır ek API maliyeti ($10 kredi korunur).
- **Altyapı:** Sıfır harici sunucu, tünel veya bulut bağımlılığı.
- **Kullanılabilirlik:** Tamamen yerel ve çevrimdışı (offline) çalışabilir.

---

## 10. En Güvenli Uygulanabilir Mimari: "İki Kanallı SAS Doğrulamalı Hibrit Model"

Adversarial denetim sonucunda tüm kriterleri karşılayan yegane güvenli model:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ EN GÜVENLİ UYGULANABİLİR MİMARİ (SAS VERIFIED COURIER + TPM LOCK)                      │
│                                                                                        │
│  1. Director Soru & SAS Üretir:                                                        │
│     - Eylem: "Bütçe $10 -> $50 yapılsın mı?"                                           │
│     - payloadHash: 7A3F8B...                                                           │
│     - Kısa Doğrulama Kodu (SAS): [ #A4-B9 ] (Kriptografik olarak türetilir)            │
│                                                                                        │
│  2. AGY UI Courier Modalı Açar:                                                        │
│     - Soru: "Bütçe $50 yapılsın mı? Doğrulama Kodu: #A4-B9"                            │
│     - Seçenekler:                                                                      │
│       [ ] Reddet                                                                       │
│       [ ] Onayla (Onaylamak için yukarıdaki #A4-B9 kodunu giriniz)                    │
│                                                                                        │
│  3. Kullanıcı Yanıtı:                                                                  │
│     - Kullanıcı "Reddet" derse: AGY araya girip "Onayla" gönderemez; çünkü kod yok!   │
│     - Kullanıcı onaylamak için "#A4-B9" yazar.                                         │
│                                                                                        │
│  4. AIDM & TPM Doğrulaması:                                                            │
│     - AIDM: Girilen SAS kodu hash ile eşleşiyor mu? (Evet)                             │
│     - TPM: NCryptSignHash çağrılır, donanım mührü basılır.                            │
│     - ExecutionBridge Check 6: Fail-closed kapıyı açar ve eylemi yürütür.             │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Bu model sayesinde:
1. AGY kullanıcı "Reddet" dediğinde bunu "Onayla"ya çeviremez (SAS kodunu kullanıcı girmedikçe onay üretemez).
2. AGY soruyu tahrif edemez (SAS kodu ile soru metni birbirine bağlıdır).
3. Kullanıcının tek muhatabı Director kalır; IDE içinden çıkılmaz.
4. TPM donanım kilidi sessiz arka plan imzasını engeller.

---

## 11. GO / CONDITIONAL GO / NO-GO Kararı

| Kapsam | Karar | Gerekçe |
|---|:---:|---|
| **Mevcut Durumda P18-04 / P20 Check 6 Üretim Entegrasyonu** | **KESİN NO-GO** | TRUST-ROOT-06'daki açıklar (Kullanıcı ret manipülasyonu ve WYSIWYS eksikliği) henüz kod seviyesinde çözülmemiştir. |
| **Bağımsız Onay Kanalı Olarak "SAS Doğrulamalı Hibrit Model" Tasarımı** | **ŞARTLI GO** | Güvenlik açıklarını kapatan ve resmi API'lerle uyumlu tek uygulanabilir yoldur. |
| **Check 6 Kapısının Gevşetilmesi** | **KESİN NO-GO** | İnsan onayı kesinleşmeden kapı açılamaz. |

---

## 12. Uygulamaya Geçiş İçin Kabul Kriterleri

Geliştirme aşamasına (`P18-04 / P20`) geçilmeden önce aşağıdaki 4 kabul kriteri sağlanmalıdır:

1. **SAS Doğrulama Sözleşmesi:** `DirectorQuestionChallenge` içine kriptografik kısa doğrulama kodu (`sasCode`) alanı eklenmeli ve doğrulanmalıdır.
2. **Kullanıcı Ret İptali:** Kullanıcı reddettiğinde veya kod girilmediğinde TPM imza çağrısının kesinlikle tetiklenmediği kanıtlanmalıdır.
3. **TPM 2.0 Provider Entegrasyonu:** [IdentityManager](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/identity-manager.ts)'ın DPAPI yerine `MS_PLATFORM_KEY_STORAGE_PROVIDER` ile çalışması izole test edilmelidir.
4. **Fail-Closed Regresyon Garantisi:** `ExecutionBridge` Check 6'nın sahte kod veya eksik imzada `BLOCKED_ON_AUTH_CONTEXT` vermeyi sürdürdüğü doğrulanmalıdır.
