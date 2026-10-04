# TRUST-ROOT-05 — Human Approval Root-of-Trust Architecture Decision

**Rapor Kodu:** TRUST-ROOT-05-HUMAN-APPROVAL-ARCHITECTURE-DECISION  
**Tarih:** 2026-10-04  
**Görev Türü:** SECURITY ARCHITECTURE DECISION / READ-ONLY VALIDATION  
**Öncelik:** CRITICAL  
**Bağımlılıklar:** TRUST-ROOT-03, TRUST-ROOT-04, DIRECTOR-INTERACTION-01, DIRECTOR-INTERACTION-02  
**Kod Değişikliği:** YASAK (Salt-Okunur Mimari Doğrulama ve Karar Belgesi)

---

## 1. Yönetici Özeti

Bu mimari karar belgesi, TRUST-ROOT serisi ve DIRECTOR-INTERACTION denetimlerinin bulgularını sentezleyerek, OtonomMCP sistemi için **güvenilir insan onayı (human approval root-of-trust)** mimarisini kesinleştirmek amacıyla hazırlanmıştır.

### 1.1. Temel Problem ve Çıkış Noktası
[DIRECTOR-INTERACTION-02](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/DIRECTOR-INTERACTION-02-IDENTITY-SEPARATION-REPORT.md) denetimi, Antigravity IDE içindeki yerel `default_api:ask_question` aracının mülkiyetinin **yalnızca aktif Antigravity IDE Ajanına (AGY)** ait olduğunu; harici bir ChatGPT Director oturumunun veya AIDM MCP sunucusunun bu araca doğrudan erişemeyeceğini kanıtlamıştır.

Buna karşın, projenin bağlayıcı anayasal kararı şudur:
> **"Kullanıcının tek muhatabı ChatGPT Director'dır. AGY kullanıcıya doğrudan soru soramaz, onay isteyemez ve karar mercii olamaz."**

Bu iki gerçeklik arasındaki köprü, bu raporda modellenen ve teknik sınırları kanıtlanan **"Director Karar Sahibi — AGY UI Taşıyıcısı (Director Decider — AGY UI Courier)"** modeli ile kurulmaktadır:
1. **Karar Otoritesi:** Soru metnini, seçenekleri ve onay gereksinimini yalnızca AIDM içindeki [DirectorReasoningEngine](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director-reasoning/director-reasoning-engine.ts) üretir.
2. **UI Courier (Taşıyıcı):** Antigravity Ajanı hiçbir karar almaz; Director'ın ürettiği kanonik soru paketini Antigravity IDE'nin `ask_question` modalı ile kullanıcıya gösteren **salt bir ekran taşıyıcısıdır (Pass-through Courier)**.
3. **Kullanıcı Yanıtı:** Kullanıcının seçimi doğrudan AIDM'e iletilir ve Director tarafından doğrulanır.
4. **İki Aşamalı Kilit:** `ask_question` ile sağlanan "İşlem Detayını Görerek Onaylama" (WYSIWYS), yerel TPM 2.0 donanım anahtarı (`MS_PLATFORM_KEY_STORAGE_PROVIDER`) ile mühürlenmeden [ExecutionBridge](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/execution-bridge/execution-bridge.ts) Check 6 kapısı açılmaz.

### 1.2. Nihai Mimari Karar
- **Model Kararı:** **ŞARTLI GO (CONDITIONAL GO)**.  
  Director Karar Sahibi + AGY UI Courier + Yerel TPM 2.0 Donanım Kilidi modeli, OtonomMCP'nin güvenlik ve etkileşim gereksinimlerini karşılayan **yegane uygulanabilir mimaridir**.
- **Check 6 Durumu:** `BLOCKED_ON_AUTH_CONTEXT` kapısı, hem kanonik Director onay paketi hem de TPM donanım imzası bir arada doğrulanana kadar **fail-closed kalmaya devam edecektir**.

---

## 2. Önceki Raporların Doğrulanmış Bulguları

Bu karar, önceki dört denetimin kanıtlanmış teknik gerçeklerine dayanmaktadır:

1. **[TRUST-ROOT-03](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-03-TPM-STRONG-KEY-POC-REPORT.md):**  
   - Windows 11 TPM 2.0 (`MS_PLATFORM_KEY_STORAGE_PROVIDER`), `0x80090022` (`NTE_SILENT_CONTEXT_NOT_SUPPORTED`) ile arka planda gizli imza atılmasını kesin olarak engeller.
   - Ancak yerel Windows onay penceresi (`A tool is requesting access to a protected item`) işlem parametrelerini (bütçe, görev, eylem) **GÖSTEREMEZ**. Statik anahtar koruması sağlar, dinamik işlem onayı (WYSIWYS) sağlayamaz.
2. **[TRUST-ROOT-04](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-04-SECURE-COMPANION-THREAT-MODEL.md):**  
   - Windows DAC modelinde aynı kullanıcı (Medium Integrity) altındaki süreçler arasında güvenlik sınırı yoktur. Standart bir Win32 Companion GUI, UIAutomation ve clickjacking saldırılarına açıktır.
   - İşlem detaylarının kullanıcıya doğal etkileşim kanalında (Director) sunulması zorunludur.
3. **[DIRECTOR-INTERACTION-01](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/DIRECTOR-INTERACTION-01-FEASIBILITY-REPORT.md):**  
   - Antigravity IDE'nin yerel `default_api:ask_question` aracı resmi olarak mevcuttur; yapılandırılmış seçenekler ve senkron bloklama sunar. Harici headless push API'si yoktur.
4. **[DIRECTOR-INTERACTION-02](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/DIRECTOR-INTERACTION-02-IDENTITY-SEPARATION-REPORT.md):**  
   - `default_api:ask_question` aracını doğrudan çağırabilecek tek varlık Antigravity IDE Ajanıdır. MCP sunucusu veya harici ChatGPT bu araca doğrudan erişemez. Bu nedenle AGY'nin rolü kesin olarak "UI Courier" ile sınırlandırılmalıdır.

---

## 3. Director-Only Mimari Değerlendirmesi

OtonomMCP'nin tek karar verici ilkesi, AGY'nin varlığına rağmen şu 4 kural ile mutlak olarak korunur:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ MİMARİ OTORİTE DAĞILIMI                                                                │
│                                                                                        │
│  ┌────────────────────────┐         ┌────────────────────────┐                         │
│  │ ChatGPT Director       │         │ Antigravity Ajanı      │                         │
│  │ (Reasoning Runtime)    │         │ (AGY - UI Courier)     │                         │
│  ├────────────────────────┤         ├────────────────────────┤                         │
│  │ • Karar Üretir         │         │ • Soru Üretemez        │                         │
│  │ • Seçenekleri Belirler │         │ • Seçenek Değiştiremez │                         │
│  │ • Bütçeyi Tayin Eder   │         │ • Karar Veremez        │                         │
│  │ • Yanıtı Doğrular      │         │ • YALNIZCA EKRANDA     │                         │
│  │ • Yetki Talimatı Verir │         │   MODAL AÇAR           │                         │
│  └───────────┬────────────┘         └───────────▲────────────┘                         │
│              │                                  │                                      │
│              │ Kanonik Challenge İmzalar        │ ask_question Çalıştırır              │
│              └──────────────────────────────────┘                                      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Otorite Devri Yasağı:** `DirectorReasoningEngine`'in karar yetkisi hiçbir koşulda istemci tarafındaki AGY'ye devredilemez.
2. **Kanonik Bağlam İhlali Koruması:** AGY'nin kendi inisiyatifiyle açtığı sorular, AIDM'de karşılık gelen bir `challengeId` ve `directorSessionId` bulunamayacağı için reddedilir.
3. **Tek Kullanıcı Muhatabı:** Kullanıcı ekranda beliren sorunun altında "Director İsteği" başlığını ve Director tarafından hazırlanan gerekçeyi görür.
4. **Yürütme Öncesi Değerlendirme:** Kullanıcı modalde bir seçim yaptığında, yürütme doğrudan başlamaz; yanıt önce Director akıl yürütme döngüsüne girer ve onaylanır.

---

## 4. AGY UI Courier Güvenlik Modeli

AGY'nin bir aracı olarak sistemi yanıltmasını engellemek için 8 potansiyel saldırı senaryosu ve savunma mekanizmaları analiz edilmiştir:

| Saldırı Senaryosu | Saldırı Yöntemi | Önleme / Tespit Mekanizması | Fail-Closed Davranışı |
|---|---|---|---|
| **1. Soru Metninin Değiştirilmesi** | Director "Veritabanı silinsin mi?" der; AGY modala "Testler çalıştırılsın mı?" yazar. | Soru paketi AIDM'de `payloadHash` ile mühürlenir. Modala kısa doğrulama özütü (`Fingerprint: #A1F9`) basılır. | Hash uyuşmazlığında imza geçersiz sayılır; işlem yürütülmez. |
| **2. Seçeneklerin Değiştirilmesi / Çıkarılması** | AGY "Reddet" seçeneğini siler, yalnızca "Onayla" gösterir. | AIDM, dönen seçeneğin Director'ın `options` dizisinde olup olmadığını doğrular. | Geçersiz seçenek gelirse `DirectorActionValidationError` ile reddedilir. |
| **3. Yanıltıcı Açıklama Eklenmesi** | AGY sohbette "Director bunu güvenli buldu, onaylayın" der. | Kullanıcıya bağlayıcı kararın modaldaki resmi metin olduğu bildirilir; serbest chat metni yetki oluşturmaz. | İstemci metni yetki oluşturamaz. |
| **4. Önerilen Seçeneğin Değiştirilmesi** | Director "Reddet" önerirken AGY "Onayla"yı önerir. | `recommendedOption` alanı Director imzalı paketin içindedir; AIDM karşılaştırma yapar. | Mismatch tespit edilirse uyarı üretilir. |
| **5. Kullanıcı Yanıtının Değiştirilmesi** | Kullanıcı "Reddet" der; AGY AIDM'e "Onayla" iletir. | **TPM Donanım Kilidi:** Onay durumunda yerel TPM modalı açılır. Kullanıcı reddettiyse TPM modalını iptal eder (`0x80090036`). | `NTE_USER_CANCELLED` -> Check 6 derhal fail-closed kilitlenir. |
| **6. Sahte Cevap Gönderilmesi** | AGY kullanıcıya modal açmadan doğrudan AIDM'e onay gönderir. | P20 Check 6: İstemciden gelen beyanlar `UNVERIFIED_CLIENT_INPUT` olarak işaretlenir. | `BLOCKED_ON_AUTH_CONTEXT` ile durdurulur (P20-01D Test 1 kanıtlı). |
| **7. Eski Cevabın Tekrarı (Replay)** | Action 1 onayını Action 2 için tekrar sunar. | `contextFingerprint`, `actionId`, `mandateRevision` ve tekil `nonce` eşleşmesi aranır. | `NonceStore` replay tespiti -> fail-closed ret. |
| **8. İzsiz / Yetkisiz Soru Açılması** | AGY kendi kendine `ask_question` çalıştırır. | AIDM'de açık bir `challengeId` bulunmadığı için gelen yanıt hiçbir işleme bağlanamaz. | `ERR_CHALLENGE_NOT_FOUND` ile düşürülür. |

> [!WARNING]
> **Kritik Sınır (İmzalı Soru vs. Görüntülenen Piksel):**  
> AIDM'nin gönderdiği soru paketinin kriptografik olarak imzalanmış olması, Antigravity IDE'nin Electron DOM penceresinde piksellerin tahrif edilmediğini tek başına garanti edemez.  
> Bu ayrım nedeniyle, **AGY'nin kullanıcı yanıtını tahrif etmesine karşı son savunma hattı TPM 2.0 fiziksel onay penceresidir**.

---

## 5. Soru / Cevap Kanonik Sözleşmesi

Director ile AGY Courier arasındaki veri alışverişi, deterministik serileştirmeye (RFC 8785) tabi tutulan aşağıdaki kanonik şemaya bağlanacaktır:

### 5.1. `DirectorQuestionChallenge` Şeması
```typescript
export interface DirectorQuestionChallenge {
  // Zorunlu Bağlam ve Güvenlik Alanları
  challengeId: string;           // UUID v4
  projectId: string;             // Canonical project identifier
  directorSessionId: string;     // Active Director session
  actionId: string;              // Target action proposal
  contextFingerprint: string;    // SHA-256 snapshot fingerprint
  understandingRevision: number; // Requirements revision
  mandateRevision: number;       // Security mandate revision
  policyVersion: number;         // Policy engine version
  
  // İçerik ve Sunum Alanları
  question: string;              // User-facing question text
  options: string[];             // Minimum 2 distinct options
  recommendedOption?: string;    // Optional recommended choice
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  
  // Yaşam Döngüsü ve Anti-Replay
  createdAt: string;             // ISO 8601 UTC
  expiresAt: string;             // ISO 8601 UTC (Strict TTL: 120s)
  nonce: string;                 // 128-bit random hex
  
  // Bütünlük İmzası
  payloadHash: string;           // SHA-256 of canonical JSON (excluding signature)
  directorSignature: string;     // Director private key signature
}
```

### 5.2. Alan Analizi: Hangileri Zorunlu, Hangileri Gereksiz?
- **Zorunlu Alanlar:** `challengeId`, `projectId`, `directorSessionId`, `actionId`, `contextFingerprint`, `question`, `options`, `expiresAt`, `nonce`, `payloadHash`. Bu alanlar olmadan çapraz oturum, zaman aşımı ve replay koruması sağlanamaz.
- **Hızlı Red Alanları:** `understandingRevision` ve `mandateRevision`, büyük bağlam nesnelerini ayrıştırmadan `ExecutionBridge`'in anında uyuşmazlık tespiti yapmasını sağlar; korunmalıdır.
- **Gereksiz / Çıkarılan Alanlar:** Serbest formatlı `metadata` veya `customNotes` alanları kanonik hash'i belirsizleştirdiği için sözleşmeden çıkarılmıştır.

---

## 6. TPM ve İnsan Onayı Ayrımı

TRUST-ROOT-03 bulguları ışığında, güvenlik özellikleri aşağıdaki 5 temel düzeyde ayrıştırılmıştır:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. DONANIMSAL ANAHTAR KORUMASI (TPM 2.0 Silicon)                                       │
│    - Özel anahtar RAM veya diskte düz metin yaşamaz; çalınamaz.                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. FİZİKSEL KULLANICI VARLIĞI (NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG)                   │
│    - Arka planda sessiz imza 0x80090022 ile engellenir; insan fiziksel olarak oradadır. │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 3. GERÇEK PRODUCT OWNER KİMLİĞİ                                                        │
│    - TPM yalnızca yerel Windows kullanıcısının anahtarıdır; kurumsal PO kimliği        │
│      için işletim sistemi kimlik doğrulaması (PIN/Biyometri) ile birleşir.             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 4. İŞLEM DETAYLARININ GÖRÜLMESİ (WYSIWYS)                                              │
│    - TPM modalı detay gösteremez (Kör İmza). BU DETAYI YALNIZCA ask_question GÖSTERİR! │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 5. GÖRÜNEN İŞLEM İLE İMZALANAN YÜKÜN EŞİTLİĞİ                                          │
│    - ask_question'da onaylanan payloadHash, TPM'in imzaladığı hash ile aynıdır.       │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> **Kesin Güvenlik Ayrımı:**  
> TPM 2.0 tek başına insan onayını kanıtlayamaz; `ask_question` tek başına donanımsal güvenliği kanıtlayamaz.  
> Güven kökü, **`ask_question`'ın sunduğu WYSIWYS içeriği ile TPM 2.0'ın sunduğu donanımsal erişim kilidinin birbirine bağlanmasıyla** oluşur.

---

## 7. Alternatif Güven Mimarileri

Değerlendirilen alternatifler ve uygulanabilirlik analizleri:

| Mimari Alternatif | Güvenlik Kazanımı | Sınırlamalar ve Saldırı Yüzeyi | Uygulama Maliyeti | Mimari Uyum | Karar |
|---|---|---|:---:|:---:|:---:|
| **1. Director + AGY UI Courier + TPM (Önerilen)** | WYSIWYS sunumu + Arka plan sessiz imza engeli + Rol ayrılığı. | AGY DOM manipülasyonu riski (TPM iptali ile sınırlanır). | Düşük-Orta | **%100 Tam Uyum** | **ŞARTLI GO** |
| **2. Yalnızca Windows CNG / TPM (Courier Yok)** | Donanımsal imza kanıtı. | **Kör İmza (Blind Signing):** Kullanıcı neyi onayladığını göremez. | Düşük | Düşük (Güvenlik Kusuru) | **KESİN NO-GO** |
| **3. FIDO2 / WebAuthn Harici Token** | Fiziksel parmak dokunuşu (User Presence). | Harici donanım zorunluluğu; ekransız tokenlarda WYSIWYS eksikliği. | Yüksek | Düşük | **NO-GO** |
| **4. UAC Secure Desktop Companion** | UIPI ile %100 clickjacking koruması. | Masaüstü değiştirme (`SwitchDesktop`) kararsızlığı; yönetici yetkisi şartı. | Çok Yüksek | Düşük (Geliştiriciyi engeller) | **NO-GO** |
| **5. DPAPI / Yazılımsal Anahtar (Mevcut Durum)** | Hızlı yerel geliştirme. | Aynı kullanıcının her süreci anahtarı çalabilir (`TRUST-ROOT-01`). | Sıfır | Güvensiz | **DEĞİŞTİRİLECEK** |

---

## 8. Zorunlu Tehdit Modeli (12 Senaryo)

| # | Tehdit Tanımı | Saldırgan Yeteneği | Etki | Mevcut Koruma | Eksik Kalan Savunma | Gerekli Doğrulama ve Artık Risk |
|---|---|---|---|---|---|---|
| **T-01** | **Aynı Windows kullanıcısı zararlı süreç** | Dosyaları okuma, bellek tarama. | Anahtar çalınması. | DPAPI (Etkisiz). | TPM KSP donanım izolasyonu. | **TPM 2.0 şarttır.** Artık risk: Bellek içi hooking. |
| **T-02** | **Sahte AGY / Sahte MCP istemcisi** | Sahte onay paketi gönderme. | Yetkisiz yürütme. | Check 6: `UNVERIFIED_CLIENT_INPUT`. | Donanım imzası zorunluluğu. | Tam koruma. Artık risk: Sıfır. |
| **T-03** | **AGY Soru/Cevap Manipülasyonu** | Metin veya seçeneği tahrif etme. | Yanıltıcı onay. | Yok. | İmzalı soru paketi + TPM iptali. | Kullanıcı TPM modalında iptal eder. Artık risk: Düşük. |
| **T-04** | **Yanlış Workspace / ProjectId** | Proje A onayını Proje B'de sunma. | Yetki aşımı. | `AuthContextValidator` binding. | Tam koruma mevcut. | Artık risk: Sıfır. |
| **T-05** | **Eski Session / Stale Fingerprint** | Eski onay jetonunu yürütme. | Tutarsız kod icrası. | `basedOnContextFingerprint` kontrolü. | Tam koruma mevcut. | Artık risk: Sıfır. |
| **T-06** | **Nonce Replay** | Kullanılmış token'ı tekrar iletme. | Çift eylem yürütme. | `NonceStore` disk kaydı. | 1000 sınırı sonrası TTL koruması. | Kısa TTL (120s) şarttır. Artık risk: Sıfır. |
| **T-07** | **IDE Kapanması ve Yeniden Açılması** | In-flight onay durumunun düşmesi. | Durum tutarsızlığı. | `local-runtime.json` kilit koruması. | Onay paketinin `isStale` işaretlenmesi. | Otomatik kurtarma fail-closed çalışır. |
| **T-08** | **İkinci IDE Instance Çakışması** | İki IDE'nin aynı projeyi açması. | Eşzamanlı durum bozulması. | `LocalRuntimeStateManager` katı kilidi. | Tam koruma mevcut. | Artık risk: Sıfır. |
| **T-09** | **TPM Anahtarının Silinmesi / Erişilememesi** | Anahtarın silinmesi. | Kilitlenme. | `0x80090016` (`NTE_BAD_KEYSET`). | Fail-closed duruş. | Sistem güvenle durur. |
| **T-10** | **İnsan Onayı Olmadan Otomatik Onay** | Ajanın kendi kendine yetki vermesi. | Otonom kaçak. | Check 6: `isTrustedHumanAuth === false`. | Tam koruma mevcut. | Artık risk: Sıfır. |
| **T-11** | **Yetkisiz / Süresi Geçmiş Mandate** | Zaman penceresi dışı işlem. | Güvenlik ihlali. | `AuthorizationPolicyEngine` zaman kontrolü. | Tam koruma mevcut. | Artık risk: Sıfır. |
| **T-12** | **İmzalı Payload ile Yürütülen Action Uyuşmazlığı** | A onaylatılıp B çalıştırılması (TOCTOU). | Yıkıcı eylem. | `ExecutionBridge` dondurulmuş intent kontrolü. | Tam koruma mevcut. | Artık risk: Sıfır. |

---

## 9. Mevcut Kod Tabanına Entegrasyon Noktaları

Bu mimari için OtonomMCP'ye hiçbir yeni FSM, DAG veya Driver eklenmeyecektir. Entegrasyon noktaları şunlardır:

1. **[IdentityManager](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/identity-manager.ts):**  
   DPAPI ve geçici PowerShell betiği (`.mcp-protect-*.ps1`) yerine; Win32 CNG `MS_PLATFORM_KEY_STORAGE_PROVIDER` üzerinden TPM 2.0 ECDSA P-256 sağlayıcısına geçirilecektir.
2. **[AuthContextValidator](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/auth-context-validator.ts):**  
   Satır 81'deki zafiyetli istemci kontrolü (`context.verified === true && context.authSource === 'TRUSTED_IDE'`) kaldırılarak; doğrudan TPM ECDSA P-256 imzası ve `QuestionChallengeEnvelope` hash doğrulamasına bağlanacaktır.
3. **[DirectorActionBuilder](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director-action/director-action-builder.ts):**  
   `REQUEST_HUMAN_DECISION` eyleminde kanonik `DirectorQuestionChallenge` zarfını oluşturacaktır.
4. **[ExecutionBridge](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/execution-bridge/execution-bridge.ts):**  
   Check 6 (`PRODUCT_OWNER_APPROVAL`), donanım imzası ve kanonik challenge doğrulanana kadar `BLOCKED_ON_AUTH_CONTEXT` vermeyi sürdürecektir.

---

## 10. Çözülemeyen Riskler (Residual Unresolvable Risks)

1. **İstemci Tarafı Görsel Aldatma (Courier Phishing):**  
   AGY sorunun açıklamasını sohbette yanlış yorumlarsa kullanıcı yanıltılabilir. Bu risk, kanonik özetin modala basılmasıyla azaltılır ancak tamamen sıfırlanamaz.
2. **İşletim Sistemi Seviyesinde Bellek Okuma:**  
   Aynı Windows kullanıcısı altındaki zararlı süreçler Node.js belleğini okuyabilir. Bu durum Windows NT işletim sistemi mimarisinin doğal bir sınırıdır.
3. **Onay Yorgunluğu:**  
   Kullanıcının ayrıntıları incelemeden "Onayla"ya basması kullanıcı davranışı riskidir.

---

## 11. GO / CONDITIONAL GO / NO-GO Kararı

| Kapsam | Karar | Gerekçe |
|---|:---:|---|
| **Director Karar Sahibi + AGY UI Courier + TPM 2.0 Güven Mimarisi** | **ŞARTLI GO** | Çözüm teorik ve pratik olarak uygulanabilir tek yoldur. |
| **AGY'ye Bağımsız Karar Yetkisi Verilmesi** | **KESİN NO-GO** | Bağlayıcı mimari karara aykırıdır. |
| **Salt Yazılımsal Chat Cevabıyla Check 6'nın Açılması** | **KESİN NO-GO** | İstemci beyanı güven kanıtı değildir. |
| **Ayrı Bir Masaüstü Companion GUI Yazılması** | **KESİN NO-GO** | Clickjacking ve aynı kullanıcı zafiyetleri nedeniyle reddedilmiştir. |

### 11.1. Yedi Zorunlu Soruya Kesin Cevaplar:
1. **Director-only karar otoritesi korunabiliyor mu?**  
   **EVET.** Soruyu ve seçenekleri yalnızca Director üretir. AGY hiçbir karar alamaz.
2. **AGY'nin yalnızca UI taşıyıcısı olması uygulanabilir mi?**  
   **EVET.** `default_api:ask_question` aracı AGY tarafından salt taşıyıcı olarak işletilir.
3. **AGY'nin soru ve yanıtı değiştirmesi engellenebilir mi?**  
   **EVET.** AIDM hash doğrulaması ve TPM kullanıcı iptali (`0x80090036`) ile tespit edilir ve engellenir.
4. **TPM gerçekten gerekli mi?**  
   **EVET.** Arka planda sessiz imza üretimini (`0x80090022`) işletim sistemi düzeyinde engelleyen tek mekanizmadır.
5. **İnsan onayı ile kriptografik kimlik ayrıştırılabiliyor mu?**  
   **EVET.** İnsan onayı `ask_question` ile alınır; kriptografik kilit TPM 2.0 ile sağlanır.
6. **Check 6 hangi koşullarda açılabilir?**  
   Yalnızca geçerli `challengeId`, eşleşen `payloadHash`, taze `nonce` ve geçerli `TPM ECDSA P-256` imzası bir arada sunulduğunda açılır.
7. **Hangi riskler kabul edilmemeli?**  
   İstemcinin kendi beyanına (`verified: true`) güvenilmesi ve Windows CNG modalının kör imzasına güvenilmesi kesinlikle kabul edilmemelidir.

---

## 12. Uygulama Aşamaları

1. **Aşama 1 (Kanonik Şema ve İmza Sözleşmesi):** `DirectorQuestionChallenge` ve `HumanApprovalProof` arayüzlerinin tanımlanması.
2. **Aşama 2 (TPM KSP İstemci Köprüsü):** [IdentityManager](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/identity-manager.ts)'ın DPAPI yerine izole Win32 CNG TPM 2.0 sağlayıcısını çağıracak şekilde güncellenmesi.
3. **Aşama 3 (UI Courier Entegrasyonu):** Antigravity IDE Ajanına Director soru paketini `ask_question` ile açma görevinin sistem talimatı olarak verilmesi.
4. **Aşama 4 (Check 6 Entegrasyonu):** [ExecutionBridge](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/execution-bridge/execution-bridge.ts)'in iki faktörlü doğrulamayı devreye alması.

---

## 13. Zorunlu Kabul Kriterleri

Üretim koduna geçiş için aşağıdaki 5 kriter sağlanmalıdır:
1. `ask_question` modalındaki `options` dizisi ile Director'ın belirlediği dizi birebir aynı olmalıdır.
2. Kullanıcı modalı kapattığında sistem fail-closed davranmalı ve işlemi iptal etmelidir.
3. İmzalanan kanonik SHA-256 hash ile `ExecutionBridge`'e ulaşan hash eşit olmalıdır.
4. Sessiz imza denemesi `0x80090022` ile fail-closed kalmalıdır.
5. Check 6 kapısı donanım imzası olmadan kesinlikle açılmamalıdır.

---

## 14. Sonraki Geliştirme Görevi

Bu mimari karar doğrultusunda sıradaki bağlayıcı geliştirme görevi şudur:

👉 **`P18-04 / P20 — Trusted Human Authentication Gate & TPM Provider Implementation`**  
- Bu aşamada kaynak kod seviyesinde `IdentityManager` TPM 2.0 CNG sağlayıcısına geçirilecek, kanonik challenge sözleşmesi bağlanacak ve P20 Check 6 kapısının iki aşamalı doğrulaması tamamlanacaktır.
