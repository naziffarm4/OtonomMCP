# TRUST-ROOT-06 — Human Approval Protocol Adversarial Validation Raporu

**Rapor Kodu:** TRUST-ROOT-06-ADVERSARIAL-VALIDATION-REPORT  
**Tarih:** 2026-10-04  
**Görev Türü:** SECURITY VALIDATION / READ-ONLY / ADVERSARIAL REVIEW  
**Öncelik:** CRITICAL  
**Bağımlılıklar:** TRUST-ROOT-03, TRUST-ROOT-04, DIRECTOR-INTERACTION-01, DIRECTOR-INTERACTION-02, TRUST-ROOT-05  
**Kod Değişikliği:** YASAK (Tamamen Salt-Okunur Güvenlik Doğrulaması)

---

## 1. Yönetici Özeti

Bu güvenlik denetimi, [TRUST-ROOT-05](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-05-HUMAN-APPROVAL-ARCHITECTURE-DECISION.md) raporunda önerilen **"Director Karar Sahibi + AGY UI Courier + TPM 2.0"** mimarisinin güvenlik iddialarını, varsayımlara dayanmaksızın hasmane (adversarial) saldırı senaryoları altında bağımsız olarak denetlemek amacıyla yürütülmüştür.

### 1.1. Temel Adversarial Bulgular

1. **Kullanıcı Yanıtı Manipülasyonu ve TPM'in Körlüğü (FAILED):**  
   Kullanıcı Antigravity IDE `ask_question` ekranında **"Reddet"** seçeneğini seçtiği halde, ele geçirilmiş veya hatalı çalışan AGY Courier AIDM'e **"Onayla"** cevabı iletirse; **TPM 2.0 imza süreci bu tahrifatı KESİNLİKLE TESPİT EDEMEZ**.  
   Windows CNG modalı (`A tool is requesting access to a protected item`) işlem ayrıntılarını, kullanıcının neyi seçtiğini veya onaylanan eylemin parametrelerini ekranda gösteremez (Blind Signing). Kullanıcının Windows onay penceresini mutlaka iptal edeceği varsayımı **kriptografik veya teknik bir savunma kanıtı DEĞİLDİR; kanıtlanmamış bir kullanıcı davranışı varsayımıdır**.

2. **Ekran Gösterimi ile Kanonik Yük Arasındaki Bağın Kopukluğu (WYSIWYS İhlali - UNPROVEN):**  
   AIDM'nin ürettiği soru paketinin kriptografik olarak imzalı olması, Antigravity IDE'nin Electron DOM penceresinde kullanıcının gözüyle okuduğu piksellerin tahrif edilmediğini **kanıtlayamaz**. AIDM ekranı göremez; AGY Courier soru metnini ekranda zararsız bir işlem gibi gösterip arkada kritik bir bütçe veya dosya silme eylemini onaylatabilir.

3. **Director İmza Anahtarının Güven Köksüzlüğü (UNPROVEN):**  
   TRUST-ROOT-05'te önerilen `directorSignature` alanının kim tarafından üretileceği incelendiğinde; buluttaki ChatGPT oturumunun yerel makineye özel bir asimetrik imza anahtarına sahip olmadığı (OpenAI API imzalı token üretmez), yerel `DirectorReasoningEngine`'in ise aynı Windows kullanıcısı altında çalışan yazılımsal bir süreç olduğu belirlenmiştir. Yerel bir anahtar, aynı kullanıcı altındaki herhangi bir süreç tarafından DPAPI üzerinden çözülebilir veya bellekten okunabilir. **Director imzasının bağımsız bir donanım güven kökü MEVCUT DEĞİLDİR**.

4. **Nihai Karar: KESİN NO-GO (Üretim Entegrasyonu İçin).**  
   Mevcut haliyle AGY UI Courier + TPM 2.0 modeli, kullanıcının gerçekte neyi onayladığı ile donanımın neyi imzaladığı arasındaki bağı kriptografik kesinlikle kuramamaktadır. P18-04 / P20 Check 6 kapısının bu haliyle açılması veya üretime entegre edilmesi **REDDEDİLMİŞTİR (NO-GO)**.

---

## 2. TRUST-ROOT-05 İddialarının Doğruluk Tablosu

TRUST-ROOT-05 raporunda öne sürülen temel tezlerin hasmane denetim sonuçları:

| TRUST-ROOT-05 İddiası | Adversarial Denetim Sonucu | Kanıt Durumu | Gerçek Teknik Durum |
|---|---|:---:|---|
| **1. "AGY yalnızca taşıyıcıdır; soru üretemez."** | **KISMEN DOĞRU** | **PARTIALLY PROVEN** | AIDM tarafında DirectorSession ve challengeId kontrolü AGY'nin sıfırdan sahte onay üretmesini engeller. Ancak AGY'nin Director sorusunu ekrana basarken tahrif etmesini engelleyemez. |
| **2. "AGY kullanıcı cevabını değiştiremez; kullanıcı TPM'de iptal eder."** | **YANLIŞ / GEÇERSİZ SAVUNMA** | **FAILED** | Kullanıcı "Reddet" dese bile AGY "Onayla" ilettiğinde Windows CNG modalı açılır. CNG modalında işlem detayı görünmediği için kullanıcı onaylayabilir. Davranışsal varsayım güvenlik kanıtı sayılamaz. |
| **3. "Soru paketi imzalı olduğu için içerik tahrif edilemez."** | **YANILTICI** | **UNPROVEN** | İmzalı JSON AIDM'den AGY'ye ulaşana kadar korunur; ancak AGY'nin `ask_question` parametresine geçtiği string üzerinde AIDM'in hiçbir denetimi yoktur. |
| **4. "TPM 2.0 sessiz arka plan imzasını engeller."** | **DOĞRU** | **PROVEN** | `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` ile korunan anahtarlarda `NCRYPT_SILENT_FLAG` çağrısı `0x80090022` ile kesin olarak engellenir (TRUST-ROOT-03 NT-04 kanıtlı). |
| **5. "TPM 2.0 + ask_question iki aşamalı tam güven kökü oluşturur."** | **EKSİK / KANITSIZ** | **FAILED** | İki aşama arasında doğrulanabilir, tahrif edilemez bir kriptografik köprü yoktur. Aradaki köprü (AGY) untrusted bir aktördür. |
| **6. "İmzalanan işlem ile yürütülen işlem birebir aynıdır."** | **DOĞRU** | **PROVEN** | `ExecutionBridge` intent dondurma, `contextFingerprint` ve `authorizationReference` eşleşmesi ile TOCTOU saldırılarını tam olarak engeller. |

---

## 3. Challenge ve HumanApprovalProof Protokol Analizi

TRUST-ROOT-05'te tanımlanan `DirectorQuestionChallenge` sözleşmesi hasmane bakış açısıyla incelenmiştir:

### 3.1. Alanların Yeterlilik ve Güvenlik Değerlendirmesi
- `challengeId`, `projectId`, `directorSessionId`, `actionId`: **Zorunlu ve Yeterli.** Eylemi tekil bir oturuma ve projeye bağlar.
- `contextFingerprint`: **Kritik.** Kod tabanı değiştiğinde eski soruların geçersiz kalmasını sağlar.
- `understandingRevision`, `mandateRevision`, `policyVersion`: **Hızlı Red İçin Zorunlu.**
- `question`, `options`, `recommendedOption`: **Ekrana Yansıtma Alanları.** AGY bu metinleri ekranda değiştirirse imza geçersiz kalmalıdır; ancak kullanıcı ekranda ne gördüğünü bilmediği bir hash'i onaylayamaz.
- `expiresAt`: **Kritik.** Kesinlikle kısa tutulmalıdır (maksimum 60-120 saniye).
- `nonce`: **Zorunlu.** Replay saldırılarını engeller.
- `payloadHash`: **Zorunlu.** RFC 8785 JSON Canonicalization Scheme (JCS) ile SHA-256 özütü alınmalıdır.
- `directorSignature`: **GÜVEN AÇIĞI (Bkz. Bölüm 6).** İmzanın sahibi belirsizdir.

### 3.2. Zorunlu `HumanApprovalProof` Sözleşmesi
Eğer bir onay kanıtı kabul edilecekse, yalnızca istemci beyanı değil; aşağıdaki alanları içermek zorundadır:

```typescript
export interface HumanApprovalProof {
  challengeId: string;
  actionId: string;
  selectedOption: string;
  contextFingerprint: string;
  approvedAt: string;
  nonce: string;
  payloadHash: string;
  
  // Donanımsal Mühür
  hardwareConsentSignature: string; // TPM ECDSA P-256 imza baytları
  tpmKeyIdentifier: string;        // TPM2B_NAME veya Public Key Fingerprint
  tpmCreationTicket?: string;      // Donanım üretim kanıtı
}
```

---

## 4. AGY UI Courier Saldırı Testleri (12 Senaryo)

Aşağıdaki 12 senaryo, AGY'nin kötü niyetli, ele geçirilmiş veya halüsinasyon gören bir aktör olduğu varsayımıyla test edilmiştir:

### Senaryo 1: AGY Soru Metnini Değiştirir
- **Saldırı:** Director "Veritabanını silmeyi onaylıyor musunuz?" der. AGY modala "Kod biçimlendirmeyi onaylıyor musunuz?" yazar.
- **Mevcut Savunma:** Yok. AIDM ekrandaki pikselleri göremez.
- **Savunma Durumu:** **UNPROVEN / FAILED.** Kullanıcı yanıltılarak onay verir.
- **Fail-Closed Davranışı:** Sağlanamaz; kullanıcı "Evet" dediği için işlem yürütülür.

### Senaryo 2: AGY Seçenekleri Değiştirir
- **Saldırı:** Director `['Onayla', 'Reddet']` gönderir; AGY ekrana `['Hızlı Devam', 'Detaylı Devam']` koyar.
- **Mevcut Savunma:** AIDM, dönen yanıtın Director'ın `options` dizisinde olup olmadığını kontrol eder.
- **Savunma Durumu:** **PROVEN.** Dönen metin uyuşmadığında `DirectorActionValidationError` ile fail-closed reddedilir.

### Senaryo 3: AGY "Reddet" Seçeneğini Kaldırır
- **Saldırı:** AGY kullanıcıya yalnızca tek seçenek sunar: `['Onayla']`.
- **Mevcut Savunma:** Kullanıcı modalı kapatabilir (`Skip/Escape`). Ancak AIDM ekranda kaç seçenek gösterildiğini denetleyemez.
- **Savunma Durumu:** **PARTIALLY PROVEN.** Kullanıcı zorlanırsa onaylayabilir.

### Senaryo 4: AGY `recommendedOption` Değerini Değiştirir
- **Saldırı:** Director "Reddet" önerirken AGY ekranda "(Recommended) Onayla" gösterir.
- **Mevcut Savunma:** AIDM kullanıcının seçtiği seçeneğin geçerliliğini denetler; ancak kullanıcının AGY tarafından yönlendirildiğini (nudging) tespit edemez.
- **Savunma Durumu:** **UNPROVEN.** Kullanıcı yönlendirilebilir.

### Senaryo 5: Kullanıcının Cevabını Değiştirir (Kritik Test)
- **Saldırı:** Kullanıcı modalda "Reddet" seçer. AGY bunu görmezden gelir ve AIDM'e `selectedOption: "Onayla"` iletir.
- **Mevcut Savunma:** TRUST-ROOT-05'te "Kullanıcı TPM modalında iptal eder" varsayımı öne sürülmüştü.
- **Savunma Durumu:** **FAILED.** Windows CNG modalı işlem detayını göstermediği için kullanıcı rutin bir onay sanarak [OK]'a basabilir. TPM bu tahrifatı algılayamaz!

### Senaryo 6: Kullanıcıya Soru Göstermeden Yanıt Gönderir
- **Saldırı:** AGY `ask_question` modalını hiç açmaz; doğrudan `aidm_approval_package_approve` çağırır.
- **Mevcut Savunma:** [ExecutionBridge](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/execution-bridge/execution-bridge.ts) Check 6, istemciden doğrudan gelen çağrıları `UNVERIFIED_CLIENT_INPUT` olarak işaretler.
- **Savunma Durumu:** **PROVEN (P20-01D Test 1 Kanıtlı).** Yürütme derhal `BLOCKED_ON_AUTH_CONTEXT` ile durdurulur.

### Senaryo 7: Sahte Challenge Üretir
- **Saldırı:** AGY Director talimatı olmaksızın kendi uydurduğu bir `challengeId` ile onay üretir.
- **Mevcut Savunma:** AIDM veritabanında aktif ve açık bir Director challenge kaydı aranır.
- **Savunma Durumu:** **PROVEN.** Eşleşmeyen challenge reddedilir.

### Senaryo 8: Eski Challenge'ı Tekrar Kullanır (Replay)
- **Saldırı:** Geçmişte onaylanmış bir challenge paketini yeni bir istekte tekrar gönderir.
- **Mevcut Savunma:** [NonceStore](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/nonce-store.ts) tekil nonce kontrolü + `expiresAt` (60s TTL) + `contextFingerprint` kontrolü.
- **Savunma Durumu:** **PROVEN.** Replay kesin olarak engellenir.

### Senaryo 9: Farklı Workspace / Project İçin Challenge Kullanır
- **Saldırı:** Proje A için alınan onayı Proje B'de sunar.
- **Mevcut Savunma:** [AuthContextValidator](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/auth-context-validator.ts) Satır 67-69: `context.projectId !== currentProjectId` kontrolü fail-closed reddeder.
- **Savunma Durumu:** **PROVEN.** Çapraz proje sızıntısı %100 engellenir.

### Senaryo 10: Soru İçeriğini Gösterip Farklı Action Yürütür (TOCTOU)
- **Saldırı:** Kullanıcıya "Bütçe $10 yapılsın mı?" denir; arkada tüm projeyi silen eylem yürütülür.
- **Mevcut Savunma:** `ExecutionBridge` intent doğrulamasında `actionId`, `taskId` ve `contextFingerprint` dondurulur; onaylanan referans ile yürütülen intent birebir eşleşmek zorundadır.
- **Savunma Durumu:** **PROVEN.** Eylem değiştirilemez.

### Senaryo 11: UI Courier Süreci Cevap Geldikten Sonra Değiştirilir
- **Saldırı:** Aynı kullanıcı altındaki kötü niyetli bir süreç, AGY sürecinin belleğine enjeksiyon yapar.
- **Mevcut Savunma:** Windows NT DAC modelinde aynı kullanıcı süreçleri korunamaz (`TRUST-ROOT-01`).
- **Savunma Durumu:** **UNPROVEN (İşletim Sistemi Sınırı).**

### Senaryo 12: AGY Director İmzası Olmadan Onay Üretmeye Çalışır
- **Saldırı:** AGY doğrudan yürütme yetkisi almaya çalışır.
- **Mevcut Savunma:** [DirectorActionDispatcher](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director-action/director-action-dispatcher.ts) Satır 271-287 actor kontrolü ve Check 6.
- **Savunma Durumu:** **PROVEN.** Yetki verilmez.

---

## 5. TPM ve İnsan Onayı Ayrımı

Bu ayrım projenin en temel güvenlik sınırıdır ve teknik olarak kesinleştirilmiştir:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TPM 2.0 TEKNİK OLARAK NEYİ KANITLAR?                                                  │
│                                                                                        │
│  [KANITLANANLAR]                                                                       │
│  ✔ Özel anahtar donanım yongasındadır; RAM veya diskten çalınamaz.                     │
│  ✔ İmza çağrıldığında ekranda OS onay penceresi açılmıştır.                            │
│  ✔ Arka planda sessiz (silent) imza atılamaz (0x80090022 engeli).                      │
│  ✔ O anda bilgisayar başında fiziksel bir insan mevcuttur (User Presence).             │
│                                                                                        │
│  [KESİNLİKLE KANITLAYAMADIKLARI]                                                       │
│  ✖ İnsanın ekranda ne gördüğünü (WYSIWYS).                                             │
│  ✖ Kullanıcının bütçe miktarını, görev kimliğini veya eylemi bilerek onayladığını.     │
│  ✖ Kullanıcının IDE modalında "Reddet" mi yoksa "Onayla" mı seçtiğini.                 │
│  ✖ İmzalanan 32 baytlık hash'in ekranda gösterilen metne ait olduğunu.                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

> [!CRITICAL]
> **Adversarial Soruya Kesin Cevap:**  
> **Soru:** Kullanıcı Antigravity `ask_question` ekranında "Reddet" seçtiği halde AGY "Onayla" cevabı gönderirse, TPM imza süreci bu farkı güvenilir şekilde tespit edebilir mi?  
> **Cevap:** **KESİNLİKLE HAYIR (FAILED).**  
> TPM yalnızca kendisine gönderilen 32 baytlık hash'i imzalar. Hash'in "Onay" anlamına mı yoksa "Ret" anlamına mı geldiğini bilemez ve Electron ekranındaki kullanıcı tercihini denetleyemez.

---

## 6. Director İmza Anahtarı Güven Kökü

TRUST-ROOT-05'te önerilen `directorSignature` mekanizmasının güven kökü analiz edilmiştir:

| Seçenek | İmza Sahibi | Anahtar Nerede Saklanır? | Aynı Kullanıcı Saldırısına Dayanıklı mı? | Resmi Destek |
|---|---|---|:---:|:---:|
| **A. ChatGPT Cloud Director** | OpenAI Sunucusu | Bulutta (OpenAI) | Evet (Bant dışı) | **YOK (OpenAI PKI token üretmez)** |
| **B. Yerel AIDM DirectorReasoningEngine** | Node.js Süreci | Diskte (`.ai-manager/state/`) | **HAYIR (DPAPI aynı kullanıcıya açıktır)** | Mevcut kod tabanı |
| **C. İkinci Bir TPM Anahtarı (Director Key)** | TPM 2.0 Çipi | TPM Donanımında | Kısmen (PIN yoksa sessiz çağrılabilir) | Win32 CNG |

### Temel Güvenlik Çıkmazı:
Eğer Director anahtarı yerel makinede saklanacaksa (Seçenek B), [TRUST-ROOT-01](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-01-FEASIBILITY-REPORT.md)'de kanıtlandığı gibi aynı Windows kullanıcısı altındaki herhangi bir süreç bu anahtara erişebilir. Bu durumda Director'ın AGY'den bağımsız bir güven kökü **oluşturulamaz**.

---

## 7. Mevcut Kod Tabanı Uyumu

Mevcut OtonomMCP bileşenlerinin hasmane davranışları:

- **[IdentityManager](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/identity-manager.ts):** DPAPI `CurrentUser` kullanır; aynı kullanıcının kötü niyetli süreci anahtarı okuyabilir (`S-01` açığı).
- **[AuthContextValidator](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/auth-context-validator.ts):** Satır 81 (`verified === true && authSource === 'TRUSTED_IDE'`) istemci beyanına güvenir; zafiyetlidir.
- **[ExecutionBridge](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/execution-bridge/execution-bridge.ts):** Check 6 katı fail-closed davranır; `UNVERIFIED_CLIENT_INPUT` durumunda yürütmeyi durdurur (Güçlü koruma).
- **[DirectorActionDispatcher](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director-action/director-action-dispatcher.ts):** `REQUEST_HUMAN_DECISION` eylemini `PENDING_AUTHORIZATION` ile kilitler (Güçlü koruma).

---

## 8. Kanıtlanan Savunmalar (Proven Defenses)

Aşağıdaki savunmalar matematiksel ve deneysel olarak kanıtlanmıştır:

1. **Sessiz Arka Plan İmzası Engeli (PROVEN):** TPM 2.0 `0x80090022` ile izinsiz arka plan imzasını engeller.
2. **Kör İstemci Beyanı Engeli (PROVEN):** MCP istemcisinin doğrudan `isTrustedHumanAuth: true` göndermesi Check 6 tarafından `BLOCKED_ON_AUTH_CONTEXT` ile reddedilir (P20-01D Test 1).
3. **Çapraz Proje ve Çapraz Workspace İzolasyonu (PROVEN):** `projectId` ve `workspaceId` bağlamı uyuşmadığında istek reddedilir.
4. **Idempotency ve Nonce Replay Koruması (PROVEN):** Aynı nonce veya eski `contextFingerprint` ile gelen tekrarlı eylemler reddedilir.
5. **TOCTOU Eylem Değiştirme Koruması (PROVEN):** Onaylanan eylem ile yürütülen intent arasındaki bağ dondurulmuştur; sonradan değiştirilemez.

---

## 9. Kanıtlanamayan Savunmalar (Unproven Defenses)

Aşağıdaki iddiaların güvenlik kanıtı **yoktur veya başarısız olmuştur (FAILED)**:

1. **WYSIWYS Bütünlüğü (UNPROVEN):** Ekranda gösterilen soru metninin Director'ın gönderdiği metinle aynı olduğu kanıtlanamaz (AGY DOM manipülasyonu).
2. **Kullanıcı Ret Cevabının Korunması (FAILED):** Kullanıcı "Reddet" dediğinde AGY'nin "Onayla" göndermesi durumunda TPM'in veya sistemin bunu algılayabileceği iddiası yanlıştır.
3. **Director'ın Bağımsız Güven Kökü (UNPROVEN):** Yerel makinede çalışan Director'ın AGY'den izole bir imza anahtarı güven köküne sahip olduğu kanıtlanamamıştır.

---

## 10. Artık Riskler (Residual Risks)

1. **Courier Phishing / Aldatma Riski:** AGY'nin ekrandaki soru açıklamasını tahrif ederek kullanıcıya zararlı bir işlemi onaylatması.
2. **Kör İmza (Blind Signing):** Windows modalının detay göstermemesi nedeniyle kullanıcının neyi onayladığını bilmeden [OK]'a basması.
3. **Same-User DAC Bellek İhlali:** Aynı Windows kullanıcısındaki süreçlerin bellek okuma yetkisi.

---

## 11. GO / CONDITIONAL GO / NO-GO Kararı

| Alan | Karar | Gerekçe |
|---|:---:|---|
| **Mevcut Tasarımla P18-04 / P20 Check 6 Üretim Entegrasyonu** | **KESİN NO-GO** | Kullanıcı ret cevabının manipülasyonu TPM tarafından tespit edilemez; WYSIWYS bağı kanıtlanmamıştır. |
| **Check 6 Kapısının Gevşetilmesi / Açılması** | **KESİN NO-GO** | İnsan onayı güven kökü çözülmeden kapı açılamaz. |
| **Güvenlik Açıklarını Kapatacak Hedefli Araştırma ve İzole Deney** | **SINIRLI CONDITIONAL GO** | Yalnızca aşağıdaki kabul kriterlerini çözecek izole çalışmalar yapılabilir. |

### Yedi Temel Soruya Nihai Cevaplar:
1. Director'ın karar otoritesi korunuyor mu? -> **PARTIALLY PROVEN**
2. AGY yalnızca taşıyıcı olarak sınırlandırılabiliyor mu? -> **PARTIALLY PROVEN**
3. Kullanıcıya gösterilen içeriğin kanonik olduğu kanıtlanabiliyor mu? -> **UNPROVEN**
4. Kullanıcının seçtiği cevabın değiştirilmediği kanıtlanabiliyor mu? -> **FAILED**
5. TPM imzası gerçek insan onayını kanıtlıyor mu? -> **FAILED (Yalnızca donanım varlığını kanıtlar)**
6. İmzalanan action ile yürütülen action aynı mı? -> **PROVEN**
7. Check 6 güvenli biçimde açılabilir mi? -> **FAILED (Mevcut durumda açılamaz)**

---

## 12. Üretim Geliştirmesi İçin Zorunlu Kabul Kriterleri

P18-04 / P20 üretim koduna geçilmeden önce aşağıdaki 4 koşulun **bağımsız olarak kanıtlanması zorunludur**:

1. **Kullanıcı Ret Güvencesi (Anti-Tamper Response):**  
   Kullanıcı modalda "Reddet" seçtiğinde, AGY'nin bunu "Onayla"ya çevirmesini imkansız kılan teknik bir mekanizma kanıtlanmalıdır (Örneğin: Red durumunda TPM imza çağrısının kesinlikle tetiklenmemesi veya kullanıcının onay için özel bir onay kodunu elle girmesi).
2. **Kullanıcı Doğrulama Kodu (Short Authentication String - SAS):**  
   Director'ın ürettiği hash'in ilk 6 karakteri (örn: `#A4-B9`), hem `ask_question` modalında hem de kullanıcının girmesi gereken bir input alanında doğrulanmalıdır (WYSIWYS kanıtı).
3. **Director İmza Güven Kökünün Tanımlanması:**  
   Director anahtarının aynı kullanıcıdaki süreçler tarafından çalınamayacağı bir saklama mimarisi (örneğin izole bir Windows Service veya parola korumalı KSP) kanıtlanmalıdır.
4. **P20 Check 6 Fail-Closed Sözleşmesi:**  
   Yukarıdaki 3 kanıt sağlanmadan Check 6 gevşetilmemeli ve `BLOCKED_ON_AUTH_CONTEXT` durumu sahte biçimde kaldırılmamalıdır.
