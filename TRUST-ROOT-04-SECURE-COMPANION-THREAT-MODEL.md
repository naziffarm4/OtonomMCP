# TRUST-ROOT-04 — Secure Companion Trust Architecture & Threat Model

**Rapor Kodu:** TRUST-ROOT-04-SECURE-COMPANION-THREAT-MODEL  
**Tarih:** 2026-10-04  
**Görev Türü:** READ-ONLY Security Architecture Audit  
**Proje:** OtonomMCP  
**Öncelik:** Kritik  
**Durum:** TAMAMLANDI (Kapsamlı Tehdit Modeli, Kanıt Kalitesi Denetimi ve Mimari Karar Değerlendirmesi)

---

## 1. Yönetici Özeti

Bu güvenlik mimarisi denetimi, [TRUST-ROOT-01](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-01-FEASIBILITY-REPORT.md), [TRUST-ROOT-02](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-02-WINDOWS-HELLO-POC-REPORT.md) ve [TRUST-ROOT-03](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-03-TPM-STRONG-KEY-POC-REPORT.md) çalışmalarının bulgularını temel alarak, OtonomMCP projesi için güvenli insan onayı (human approval) mimarisini, işletim sistemi sınırlarını ve olası bir Companion Worker yaklaşımının tehdit modelini eksiksiz olarak belirlemek amacıyla yürütülmüştür.

### 1.1. Temel Bulgular ve Kök Gerçekler

1. **Donanım Anahtarı vs. İşlem Onayı (Key Access vs. Transaction Consent):**  
   [TRUST-ROOT-03](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-03-TPM-STRONG-KEY-POC-REPORT.md) PoC çalışmasında TPM 2.0 (`MS_PLATFORM_KEY_STORAGE_PROVIDER`) donanım anahtarı başarıyla üretilmiş ve `NCRYPT_SILENT_FLAG` ile arka planda sessiz imzalama işletim sistemi tarafından `0x80090022` (`NTE_SILENT_CONTEXT_NOT_SUPPORTED`) kodu ile kesin olarak engellenmiştir. Ancak Windows CryptoAPI / CNG yerel onay penceresi (`A tool is requesting access to a protected item`), **yalnızca özel anahtara erişimi denetleyen statik bir kapıdır**. Ekranda bütçe, görev kimliği, eylem kimliği veya yük özeti **GÖSTERİLEMEZ**. Windows yerel modalı kullanıcıya "What-You-See-Is-What-You-Sign" (WYSIWYS) garantisi sunamaz; bu durum donanım destekli kör imzalama (Hardware-Backed Blind Signing) açığı yaratır.

2. **Aynı Kullanıcı Süreçleri Arasındaki İzolasyon Yokluğu (The Same-User DAC Fallacy):**  
   Microsoft Windows NT Discretionary Access Control (DAC) mimarisinde, aynı kullanıcı hesabı (User SID) ve aynı Bütünlük Düzeyinde (Medium Integrity Level) çalışan süreçler arasında işletim sistemi düzeyinde bir güvenlik sınırı (security boundary) **bulunmamaktadır**. Dolayısıyla, standart bir Win32 masaüstü uygulaması olarak çalıştırılacak izolesiz bir Companion Worker; aynı kullanıcının çalıştırdığı kötü niyetli bir komut dosyası, npm bağımlılığı veya ele geçirilmiş bir arka plan aracı tarafından bellek enjeksiyonuna, UI Automation tabanlı sahte tıklamalara, pencere bindirmelerine (overlay/clickjacking), adlandırılmış boru (Named Pipe) taklidine ve ikili dosya (binary) manipülasyonuna karşı **SAVUNMASIZDIR**.

3. **Director-Only Etkileşim Kuralı:**  
   [OtonomMCP_Birlikte_Gelistirme_Plani.md](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/OtonomMCP_Birlikte_Gelistirme_Plani.md) bağlayıcı kararı uyarınca kullanıcının **tek muhatabı ChatGPT Director'dır**. AIDM Orchestrator veya Antigravity CLI (`agy`) doğrudan kullanıcıya soru sormaz, onay istemez veya bağımsız bir sohbet arayüzü sunmaz. Companion Worker yaklaşımı bağımsız bir kullanıcı arayüzü veya ikinci bir karar mercii haline gelemez.

4. **Nihai Karar Özeti:**  
   - **Standart Win32 İzolesiz Companion Worker + Salt CNG Modalına Dayalı Üretim Entegrasyonu: KESİN NO-GO.**  
   - **Director-Only Out-of-Band Doğrulama + TPM 2.0 Donanım Kilidi (Hibrit Model) için İzole Tasarım: ŞARTLI GO (CONDITIONAL GO).**

---

## 2. Mevcut Güven Mimarisi ve Gerçek Kod Referansları

Mevcut OtonomMCP kod tabanındaki güven ve yetkilendirme zinciri incelenmiş; somut dosya, sınıf, fonksiyon ve satır referansları aşağıda doğrulanmıştır:

### 2.1. [IdentityManager](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/identity-manager.ts)
- **Depolama Yolu:** `.ai-manager/state/identity.json` (Satır 19).
- **Anahtar Türü:** `crypto.generateKeyPairSync('ed25519')` ile yazılımsal Ed25519 anahtar çifti (Satır 91).
- **Anahtar Koruması:** Windows DPAPI `ProtectedData.Protect(..., DataProtectionScope::CurrentUser)` kullanılmaktadır. Bu işlem, geçici bir PowerShell betiği (`.mcp-protect-${uuid}.ps1`) diske yazılarak `powershell -ExecutionPolicy Bypass -File ...` çağrısıyla yürütülmektedir (Satır 27-41).
- **İmzalama ve Doğrulama:** `signPayload` (Satır 123) ve `verifySignature` (Satır 129). JSON serileştirmesi yalnızca sığ anahtar sıralaması (`Object.keys(payload).sort()`) yapmaktadır; derin kanonikleştirme (RFC 8785 canonical JSON) bulunmamaktadır.
- **Kritik Güvenlik Açığı:** DPAPI `CurrentUser` kapsamı, aynı Windows kullanıcısı altında çalışan **herhangi bir sürecin** ekrana hiçbir onay penceresi gelmeksizin `identity.json` dosyasını çözmesine olanak tanır. Anahtarın çalınması işletim sistemi düzeyinde engellenemez.

### 2.2. [AuthContextValidator](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/auth-context-validator.ts)
- **Doğrulama Mantığı:** `validate(context, currentProjectId)` fonksiyonu (Satır 31).
- **Alan Kontrolleri:** `isForged === true` kontrolü (Satır 36), Ed25519 imza doğrulaması (Satır 50), `identityId` eşleşmesi (Satır 55), `publicKeyFingerprint` kontrolü (Satır 59), `expiresAt` kontrolü (Satır 63), `projectId` çapraz proje izolasyonu (Satır 67), ve `NonceStore.markNonceSeen()` replay kontrolü (Satır 72).
- **Kritik Mimari Zafiyet (Satır 81):**  
  ```typescript
  const isTrueHumanInteraction = context.verified === true && context.authSource === 'TRUSTED_IDE';
  ```
  `AuthContextValidator`, istemci tarafından gönderilen `verified: true` ve `authSource: 'TRUSTED_IDE'` bayraklarını imza geçerli olduğu takdirde doğrudan `isTrueHumanInteraction: true` olarak kabul etmektedir. Çalınmış veya aynı kullanıcı tarafından DPAPI ile taklit edilmiş bir anahtar bu kontrolü rahatlıkla aşabilmektedir.

### 2.3. [NonceStore](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/nonce-store.ts)
- **Kalıcı Dosya:** `.ai-manager/state/seen-nonces.json` (Satır 13).
- **Replay Engelleme:** `markNonceSeen(nonce)` fonksiyonu (Satır 17).
- **Sınırlama:** Bellek ve disk şişmesini önlemek için yalnızca son 1000 nonce tutulmaktadır (`nonces.slice(-1000)`, Satır 36).
- **Kalan Açık:** 1000'den fazla istek gönderildiğinde eski nonce'lar düşer. Eğer `expiresAt` TTL süresi uzun tutulursa, 1000 istek sonrasında aynı nonce yeniden kullanılabilir. Ayrıca diskteki dosya aynı kullanıcı tarafından silinebilir veya değiştirilebilir.

### 2.4. [ProjectMandateStore](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/project-mandate-store.ts)
- **Kalıcı Dosya:** `.ai-manager/state/project-mandate.json` (Satır 17).
- **Yazma Koruması:** `saveMandate(mandate, authContext)` fonksiyonu (Satır 40-64). `AuthContextValidator` çağırarak `isTrueHumanInteraction` şartı arar; yoksa `WAITING_FOR_TRUSTED_IDENTITY` fırlatır.
- **Kritik Eksiklik:** `loadMandate()` fonksiyonu (Satır 30-38) diskten JSON dosyasını doğrulanmamış düz metin olarak okur. Dosyanın diskte kim tarafından yazıldığını veya değiştirildiğini doğrulayan bir HMAC ya da dijital imza kontrolü **YOKTUR**.

### 2.5. [ExecutionBridge](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/execution-bridge/execution-bridge.ts)
- **Check 6: Product Owner Approval Check (Satır 440-605):**  
  P18-04 ve P20 güven sınırını oluşturur.
  - Aktif paket durumu `APPROVED` değilse (`ERR_PO_AUTHORIZATION_REQUIRED`).
  - `pkg.isStale === true` ise fail-closed.
  - `intent.authorizationReference` uyuşmazlığında fail-closed.
  - `pkg.approvalRecord.authStatus === 'UNVERIFIED_CLIENT_INPUT'` veya `isTrustedHumanAuth === false` ise **`BLOCKED_ON_AUTH_CONTEXT`** ile yürütmeyi kesin olarak durdurur (Satır 495-514).
  - Anti-spoofing kontrolleri: `isForged`, sahte imza, cross-project, cross-session, cross-task, expired timestamp ve replayed nonce kontrolleri fail-closed olarak uygulanmıştır (Satır 522-560).
  - Satır 595-604: `isAuthContextRequired && authCtx?.verified !== true` olduğunda yürütme `BLOCKED_ON_AUTH_CONTEXT` ile bloke edilir.

### 2.6. [AuthorizationPolicyEngine](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/authorization/authorization-policy-engine.ts)
- `evaluateAction(action)` fonksiyonu (Satır 30-100).
- `mandateStore.loadMandate()` ile politikayı yükler. Zaman aralığı, proje kimliği, revizyon ve eylem türü kurallarını deterministik olarak denetler.

### 2.7. [LocalRuntimeStateManager](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/storage/runtime-state.ts)
- `.ai-manager/state/local-runtime.json` üzerinde tekil çalışma kilidi (`acquireInstanceLock`, Satır 220).
- `isProcessAlive(pid)` ile canlılık kontrolü (Satır 203). Zombie takeover, stale lock clearing ve force-unlock kesin olarak yasaklanmıştır (Satır 235-250).

### 2.8. MCP Bootstrap ve Stdio İletişim Katmanı
- [executeMcp](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/cli/commands/mcp.ts) ve [StdioMcpTransport](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/mcp/mcp-transport.ts).
- İletişim anonim standart giriş/çıkış borusu (`process.stdin` / `process.stdout`) üzerinden yürütülür.
- Stdio katmanı işletim sistemi düzeyinde istemcinin kimliğini (PID, binary hash, bütünlük düzeyi) doğrulayamaz. İstemciden gelen payload içeriğindeki `actorRole: "PRODUCT_OWNER"` alanları salt istemci beyanıdır.

### 2.9. P20 Check 6 ve [P20-01D Anti-Spoof Kontrolleri](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/tests/p20-01d-anti-spoof.test.ts)
- Test paketi, istemci tarafından gönderilen sahte bayrakların (`isTrustedHumanAuth: true`, `authStatus: 'VERIFIED_HUMAN'`) `ExecutionBridge` Check 6 tarafından `BLOCKED_ON_AUTH_CONTEXT` kodu ile fail-closed reddedildiğini 10 ayrı test senaryosunda kanıtlamıştır.
- Kod tabanı, güven kökü çözülmeden bu kapının gevşetilmesini kesinlikle engellemektedir.

### 2.10. `poc/tpm-strong-key-poc/` Altındaki TRUST-ROOT-03 PoC Dosyaları
- [Program.cs](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/poc/tpm-strong-key-poc/Program.cs): Win32 CNG interop çağrıları ile TPM 2.0 donanım anahtarı üretimini ve imza doğrulamasını gerçekleştirir.
- [tpm-poc-results.json](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/poc/artifacts/tpm-poc-results.json): Test koşu sonuçlarını ve mimari çıkarımları içerir.

---

## 3. Güven Sınırları ve Tehdit Aktörleri

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ WINDOWS KULLANICI OTURUMU (Medium Integrity Level / User SID: NAZİF AÇIKGÖZ)          │
│                                                                                        │
│  ┌───────────────────────┐        stdio pipe (Anonim)       ┌────────────────────────┐ │
│  │ ChatGPT Director Host │ ◄──────────────────────────────► │  AIDM MCP Server       │ │
│  │ (Antigravity IDE /    │   [Güven Sınırı 1: Sıfır OS Auth]│  (Node.js process)     │ │
│  │  Client Runtime)      │                                  │  - ExecutionBridge     │ │
│  └───────────────────────┘                                  │  - AuthValidator       │ │
│                                                             └───────────┬────────────┘ │
│  ┌──────────────────────────────────────────────────┐                   │              │
│  │ TEHDİT AKTÖRÜ A:                                 │                   │ IPC (Borular)│
│  │ Aynı kullanıcıda çalışan kötü niyetli süreç      │                   │ [Sınır 3]    │
│  │ (Malicious Script / Injected Node / Malware)     │                   ▼              │
│  │ - Dosya sistemine tam erişim (DAC) [Sınır 2]     │        ┌───────────────────────┐ │
│  │ - Windows UI mesajlaşmasına erişim [Sınır 4]     │        │ Companion Worker      │ │
│  │ - Named Pipe'lara bağlanabilme [Sınır 3]         │        │ (C# / WinUI Süreci)   │ │
│  └──────────────────────────────────────────────────┘        └───────────┬───────────┘ │
│                                                                          │ Win32 CNG   │
└──────────────────────────────────────────────────────────────────────────┼─────────────┘
                                                                           │ [Sınır 5: OS]
                                                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ DONANIM GÜVENLİK İŞLEMCİSİ (TPM 2.0 / Intel PTT Chip)                                  │
│ - Donanımsal ECDSA P-256 Özel Anahtar Saklama                                          │
│ - Arka Plan Sessiz İmza Engeli (0x80090022)                                            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1. Güven Sınırları (Trust Boundaries)
- **Sınır 1 (MCP İstemcisi <-> AIDM):** Anonim stdio borusu. Karşı tarafın PID ve kimliği doğrulanamaz.
- **Sınır 2 (AIDM <-> Yerel Dosya Sistemi):** `.ai-manager/state/*` dizini. Windows DAC gereği aynı kullanıcıdaki her süreç dosyaları okuyabilir/silebilir/yazabilir.
- **Sınır 3 (AIDM <-> Companion IPC):** Süreçler arası iletişim borusu. Kimlik doğrulama mekanizması yoksa her süreç bağlanabilir.
- **Sınır 4 (Companion UI <-> Windows Masaüstü):** Standart masaüstü pencere yöneticisi. UI Automation ve overlay saldırılarına açıktır.
- **Sınır 5 (Windows CNG <-> TPM 2.0 Donanımı):** Donanımsal güvenlik sınırı. Anahtar dışarı aktarılamaz ve sessiz kullanılamaz.

### 3.2. Tehdit Aktörleri (Threat Actors)
1. **Aktör 1 (Local Rogue Process):** Aynı Windows kullanıcısı altında çalışan, orta bütünlük düzeyine (Medium Integrity) sahip kötü amaçlı komut dosyası, truva atı veya ele geçirilmiş npm bağımlılığı.
2. **Aktör 2 (Confused Deputy LLM / Autonomous Agent):** AGY veya kontrolden çıkmış bir ajan sürecinin sahte parametrelerle yetkisiz eylemleri onaylatmaya çalışması.
3. **Aktör 3 (Concurrent Attacker / Multi-Instance):** Aynı anda ikinci bir IDE veya komut istemcisi açarak paylaşılan durumu ve çalışma kilidini bozmaya çalışan aktör.
4. **Aktör 4 (Snooper / Man-in-the-Middle):** Diskteki geçici dosyaları, logları veya IPC trafiğini dinleyen pasif süreçler.

---

## 4. Tehdit Senaryoları ve Risk Matrisi

Aşağıdaki 14 senaryo, projenin güvenlik gereksinimleri ve Windows NT işletim sistemi mimarisi kapsamında ayrıntılı olarak incelenmiştir:

| Senaryo No | Tehdit Senaryosu | Saldırgan Yeteneği | Mevcut Savunma | Kalan Açık | Engellendi mi? |
|---|---|---|---|---|:---:|
| **S-01** | **Aynı kullanıcı altında çalışan sürecin Companion'ı taklit etmesi** | IPC borusuna sahte sunucu açabilir veya AIDM'e bağlanabilir. | Yok. | Windows DAC modeli aynı kullanıcıdaki süreçleri ayırt etmez. | **HAYIR** |
| **S-02** | **Sahte Companion UI veya sahte onay penceresi açılması** | Ekranın üstüne (Topmost) birebir aynı UI tasarımını çizebilir. | Yok. Standart masaüstünde pencereler taklit edilebilir. | Kullanıcı sahte UI'ya güvenip onay verebilir (Phishing). | **HAYIR** |
| **S-03** | **UI overlay, clickjacking ve UI automation** | `UIAutomation` API veya `SendInput` ile onay butonuna basabilir. | Yok. Standart Win32 pencereleri UIAutomation'a açıktır. | Kullanıcı fark etmeden butona basılabilir. | **HAYIR** |
| **S-04** | **Companion binary'sinin değiştirilmesi / taklit edilmesi** | Kullanıcı dizinindeki `companion.exe` dosyasını üzerine yazabilir. | Yok. Dosya izinleri kullanıcıya yazma hakkı tanır. | Çalıştırılan kod saldırgan koduna dönüşür. | **HAYIR** |
| **S-05** | **Named Pipe / IPC üzerinden kimliğe bürünme (Impersonation)** | Named Pipe dinleyicisine bağlanıp sahte onay gönderebilir. | `GetNamedPipeClientProcessId` PID alabilir ama PID reuse riski vardır. | Shared secret veya token yoksa bağlantı ayırt edilemez. | **HAYIR** |
| **S-06** | **Challenge veya onay payload'ının değiştirilmesi (Tampering)** | IPC üzerinden giden baytları değiştirmeye çalışabilir. | Kanonik SHA-256 hash ve ECDSA P-256 imzası. | Hash alındıktan sonraki değişiklikler yakalanır; öncesi IPC'ye bağlıdır. | **EVET (Kısmen)** |
| **S-07** | **Kullanıcının A'yı onaylayıp B'nin yürütülmesi (TOCTOU)** | Onay alındıktan sonra intent veya DAG'daki görevi değiştirebilir. | ExecutionBridge intent dondurma ve revizyon/hash bağlama kontrolleri. | Bütün bağlam (`contextFingerprint`, revizyonlar) kilitlidir. | **EVET** |
| **S-08** | **TPM imza isteğinin kullanıcı bilgisi dışında tetiklenmesi** | `NCryptSignHash` çağrısını gizlice arka planda yapabilir. | `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` -> `0x80090022` fırlatır. | Sessiz çağrı OS tarafından kesin engellenir; ancak kör imza riski sürer. | **EVET** |
| **S-09** | **Aynı onayın farklı proje/workspace için kullanılması** | Proje A imzasını Proje B'de sunabilir. | Kanonik yükte `projectId` ve `workspaceId` zorunludur. | Hash eşleşmez; `0x80090006` (`NTE_BAD_SIGNATURE`) döner. | **EVET** |
| **S-10** | **Nonce replay ve süreç yeniden başladıktan sonra replay** | Eski imzalı token'ı ağdan veya logdan alıp tekrar gönderebilir. | `seen-nonces.json` disk depolaması ve `expiresAt` kontrolü. | 1000'den eski nonce düşebilir veya diskteki dosya silinebilir. | **EVET (Kısmen)** |
| **S-11** | **Süre aşımı, iptal ve anahtarın silinmesi** | Süresi geçmiş challenge veya silinmiş anahtarla imza dener. | `expiresAt < Now`, `0x80090036` (Cancel), `0x80090016` (Bad Key). | Standart hata kodları fail-closed olarak kapıyı kapalı tutar. | **EVET** |
| **S-12** | **İkinci Antigravity IDE örneği veya workspace çakışması** | İkinci bir IDE açarak aynı workspace'i manipüle edebilir. | `LocalRuntimeStateManager.acquireInstanceLock` katı tekil kilit. | PID kontrolü ve force-unlock yasağı ile çift çalışma önlenir. | **EVET** |
| **S-13** | **AGY'nin ürettiği sahte / yanıltıcı onay isteği** | AGY otonom olarak `aidm_approval_package_approve` çağırır. | P20 Check 6 fail-closed: `BLOCKED_ON_AUTH_CONTEXT`. | İstemci beyanı kabul edilmez; donanım kanıtı olmadan kapı açılmaz. | **EVET** |
| **S-14** | **Kullanıcının gördüğü ile imzalanan yükün farklı olması (WYSIWYS)** | Ekrana $10 bütçe gösterip arka planda $10.000 imzalatabilir. | Windows CNG modalında sıfır koruma (İçerik görünmüyor). | **KRİTİK AÇIK.** Katman 1 ile Katman 2 bağımsızsa saldırı başarılı olur. | **HAYIR** |

---

## 5. TRUST-ROOT-03 Kanıt Kalitesi Denetimi

TRUST-ROOT-03 çalışmasında sunulan kanıtlar, test harness kaynak kodları ve diskteki ham çıktı dosyaları üzerinden bağımsız olarak denetlenmiştir:

### 5.1. AI Tarafından Üretilen Görsellerin Denetimi (Mockup vs. Gerçek Ekran Görüntüsü)
- **Denetim Tespiti:** TRUST-ROOT-03 raporunda yer alan `windows_strong_key_prompt_1791060859665.jpg` ve `challenge_ab_comparison_1791060874168.jpg` dosyaları, **işletim sisteminin yerel masaüstü framebuffer'ından alınmış gerçek ekran görüntüleri DEĞİLDİR**.
- **Kanıt:** Bu dosyalar, yapay zeka ajanının `generate_image` aracı ile IDE beyin dizininde üretilmiş şematik tasarım ve illüstrasyon (mockup) görselleridir.
- **Güvenlik Sonucu:** Söz konusu görseller gerçek bir Windows 11 güvenlik modalının fiziksel piksel kanıtı olarak **KABUL EDİLEMEZ**. Raporlanan görsel iddialar teknik API dokümantasyonu (`ncrypt.h`) ile doğrulanmış olsa da, görsel kanıt statüsü **UNVERIFIED AS OS SCREENSHOT** olarak işaretlenmelidir.

### 5.2. `tpm-poc-results.json` Ham İçeriği ve Üretim Yöntemi Denetimi
- **Denetim Tespiti:** `poc/tpm-strong-key-poc/Program.cs` içerisindeki [ExportJsonReport](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/poc/tpm-strong-key-poc/Program.cs#L337-L410) metodu incelendiğinde; bu metodun dinamik test sonuçlarını bir test koşucusundan toplamak yerine, **önceden tanımlanmış statik anonim nesneleri ve sabit dizeleri (`"PASS"`, `"0x80090022"`, vb.) doğrudan JSON'a serileştirdiği tespit edilmiştir**.
- **Güvenlik Sonucu:** [tpm-poc-results.json](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/poc/artifacts/tpm-poc-results.json) dosyası, testlerin çalışma anında ürettiği dinamik bir log çıktısı değil; geliştirici/kod tarafından statik olarak yapılandırılmış bir rapor şablonudur.

### 5.3. NT-02 Testi Sınıflandırma Hatası (Pozitif vs. Negatif Test)
- **Denetim Tespiti:** [Program.cs](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/poc/tpm-strong-key-poc/Program.cs#L782-L792) içerisindeki `NT-02` testi:
  ```csharp
  // NT-02: TPM Readiness Check (querying PCP_PLATFORM_TYPE)
  int nt2Status = NCryptOpenStorageProvider(out var hTpmProv, MS_PLATFORM_KEY_STORAGE_PROVIDER, 0);
  bool tpmReady = (r == 0 && cb > 0);
  AssertTest("NT-02", "TPM Hardware Readiness", tpmReady, "TPM 2.0 Platform Type verified");
  ```
  şeklindedir.
- **Güvenlik Sonucu:** Bu test bir hata veya saldırı senaryosunu sınayan "Negatif Test" değildir; TPM 2.0 sağlayıcısının hazır olduğunu ve platform tipinin başarıyla döndüğünü doğrulayan bir **"Pozitif Donanım Hazırlık Testi"dir**. Negatif testler listesinde yer alması metodolojik bir sınıflandırma hatasıdır.

### 5.4. NT-05, NT-09 ve NT-12 Sentetik Doğrulama Sınırlamaları
- **NT-05 (User Cancellation):** `RunNegativeTests()` içerisinde (Satır 811-814) test anında gerçek bir iptal modalı açılıp ESC gönderilmemiş; `AssertTest("NT-05", "User Cancellation Code", true, ...)` çağrısıyla kod içine `true` sabitlenmiştir.
- **NT-09 ve NT-12 (Nonce Replay & Reuse):** Testler üretimdeki `NonceStore.ts` sınıfı veya disk üzerindeki JSON dosyası ile değil, C# içerisinde geçici bir bellek içi `HashSet<string>` nesnesi ile sınanmıştır (Satır 871-874).
- **Güvenlik Sonucu:** Bu testler izole mantıksal simülasyonlardır; üretim entegrasyonu kanıtı sayılamaz.

### 5.5. TPM İmzası İnsan Onayını Kanıtlar mı?
- **Kesin Yargı:** **HAYIR.** TPM 2.0 imzasının varlığı, yalnızca TPM donanımına kaydedilmiş bir anahtarın kullanıldığını kanıtlar. `NCryptSignHash` API'si parametre olarak yalnızca 32 baytlık bir hash aldığı ve Windows modalında hiçbir işlem detayı görünmediği için, kullanıcının bu işlemle neyi onayladığını bildiği (informed consent) **matematiksel veya mantıksal olarak KANITLANAMAZ**.

---

## 6. Mimari Alternatiflerin Karşılaştırması

Güvenli insan onayı ve güven kökü mimarisi için dört temel alternatif karşılaştırılmıştır:

### 6.1. Alternatif 1: İki Katmanlı Companion UI + TPM-Backed Key (TRUST-ROOT-03 Önerisi)
- **Tanım:** Standart Win32 C#/WPF/WinUI yerel süreç işlem detayını ekranda gösterir (Katman 1); ardından TPM `NCryptSignHash` ile donanım imzası alınır (Katman 2).
- **Güvenlik Sınırları:** Standart kullanıcı masaüstü oturumu.
- **Aynı Kullanıcı Tehditleri:** Savunmasız. Aynı kullanıcının diğer süreçleri pencereye `WM_COMMAND` gönderebilir, UIAutomation ile butona basabilir veya IPC mesajını değiştirebilir.
- **İnsan Onayı Kanıtı:** Zayıf-Orta (Sadece fiziksel varlık kanıtlanır, ekrandaki bilginin okunduğu kanıtlanamaz).
- **WYSIWYS Gösterimi:** Var (Yazılımsal UI düzeyinde).
- **İmzalanan = Yürütülen Eşitliği:** Katman 1'in güvenilirliğine bağlı.
- **Windows 11 Uyumluluğu:** %100.
- **Uygulama Karmaşıklığı:** Orta.
- **Bakım Maliyeti:** Orta.
- **Kalan Risk:** **YÜKSEK (Clickjacking / UI Automation / Binary Değiştirme).**

### 6.2. Alternatif 2: Yalıtılmış Companion + UAC Secure Desktop + Authenticode + Signed IPC
- **Tanım:** Companion Worker `Program Files` altına kurulur, kurumsal kod imzalama sertifikası ile Authenticode imzalanır. UI, UAC'nin kullandığı **Windows Güvenli Masaüstü (Secure Desktop - `SwitchDesktop`)** üzerinde açılır. IPC borusu Windows Access Control List (ACL) ve AppContainer SID ile kilitlenir.
- **Güvenlik Sınırları:** Windows İşletim Sistemi Bütünlük Düzeyi (High Integrity / UIPI) ve Secure Desktop.
- **Aynı Kullanıcı Tehditleri:** Güçlü koruma. Medium Integrity süreçler Secure Desktop'a pencere çizemez, mesaj gönderemez veya fare simüle edemez (`User Interface Privilege Isolation - UIPI`).
- **İnsan Onayı Kanıtı:** Çok Güçlü (İşletim sistemi düzeyinde izole ekran).
- **WYSIWYS Gösterimi:** Var (Güvenli masaüstünde tam detay gösterilir).
- **İmzalanan = Yürütülen Eşitliği:** Tam.
- **Windows 11 Uyumluluğu:** %100 (Ancak kurulumda Administrator yetkisi gerektirir).
- **Uygulama Karmaşıklığı:** **AŞIRI YÜKSEK (Win32 Desktop Switching, Servis Mimarisi, Sertifika Yönetimi).**
- **Bakım Maliyeti:** Yüksek.
- **Kalan Risk:** Geliştirici makinelerinde yönetici yetkisi ve karmaşık kurulum zorluğu.

### 6.3. Alternatif 3: Harici Donanım Güvenlik Anahtarı (FIDO2 / WebAuthn CTAP2)
- **Tanım:** TPM yerine standart bir FIDO2 donanım anahtarı (YubiKey / Windows Hello FIDO2 platform authenticator) kullanılır.
- **Güvenlik Sınırları:** CTAP2 donanım protokolü.
- **Aynı Kullanıcı Tehditleri:** Güçlü. Fiziksel parmak dokunuşu (User Presence) zorunludur; yazılımla taklit edilemez.
- **İnsan Onayı Kanıtı:** Donanımsal dokunuş kanıtlıdır.
- **WYSIWYS Gösterimi:** Ekranlı FIDO2 cihazları hariç standart anahtarlar işlem detayını gösteremez.
- **İmzalanan = Yürütülen Eşitliği:** Kriptografik `clientDataHash` ile sağlanır.
- **Windows 11 Uyumluluğu:** Tam (`Windows.Security.Credentials`).
- **Uygulama Karmaşıklığı:** Yüksek.
- **Bakım Maliyeti:** Düşük.
- **Kalan Risk:** Kullanıcının fiziksel ek donanım taşıma zorunluluğu; ekransız anahtarlarda kör imza riski.

### 6.4. Alternatif 4: Director-Only Out-of-Band Human Approval (ChatGPT Session Cryptographic Confirmation)
- **Tanım:** Kullanıcının tek muhatabı olan ChatGPT Director oturumu üzerinden onay alınır. Onay paketi ve kanonik hash, ChatGPT Web/Mobil arayüzünde kullanıcıya zengin kart olarak sunulur. Kullanıcı "Onayla" dediğinde, cloud tabanlı Director oturumu imzalı bir onay jetonu üretir ve yerel AIDM'e iletir. Yerel TPM anahtarı ise bu jetonu yerel makinede bağlamak için ikincil kilit olarak kullanılır.
- **Güvenlik Sınırları:** Out-of-Band (Bant Dışı) Dağıtık Güvenlik Sınırı. Yerel Windows işletim sistemindeki zararlı süreç, kullanıcının buluttaki ChatGPT oturumuna veya cep telefonuna erişemez!
- **Aynı Kullanıcı Tehditleri:** **MÜKEMMEL KORUMA (Same-User Local Process Isolation).** Yerel makinedeki hiçbir kötü niyetli süreç buluttaki oturumu taklit edemez.
- **İnsan Onayı Kanıtı:** Çok Güçlü (Doğrulanmış ChatGPT kullanıcı kimliği ve oturumu).
- **WYSIWYS Gösterimi:** Mükemmel (ChatGPT sohbetinde tüm parametreler, bütçe, dosyalar açıkça listelenir).
- **İmzalanan = Yürütülen Eşitliği:** Kanonik SHA-256 hash ve revizyon numarası oturum imzasına gömülür.
- **Windows 11 Uyumluluğu:** %100 (Platformdan bağımsız).
- **Uygulama Karmaşıklığı:** Düşük-Orta (Ekstra karmaşık C# GUI, desktop switcher veya driver gerektirmez).
- **Bakım Maliyeti:** Düşük.
- **Kalan Risk:** İnternet bağlantısı ve ChatGPT servis kullanılabilirliği bağımlılığı.

### 6.5. Karşılaştırma Matrisi

| Değerlendirme Kriteri | Alternatif 1: Standart Companion + TPM | Alternatif 2: Secure Desktop Companion | Alternatif 3: FIDO2 Hardware Token | Alternatif 4: Director Out-of-Band + TPM (Hibrit) |
|---|---|---|---|---|
| **Aynı Kullanıcı Kötü Amaçlı Yazılımına Karşı Koruma** | %0 (Savunmasız) | %95 (UIPI + Secure Desktop) | %90 (Fiziksel Dokunuş) | **%99 (Out-of-Band İzolasyon)** |
| **İşlem Detayını Gösterme (WYSIWYS)** | Zayıf (Yazılımsal) | Güçlü (İzole Ekran) | Yok (Ekransız Token) | **Mükemmel (Doğal Sohbet / Kart)** |
| **Director-Only Kuralına Uygunluk** | ÇELİŞKİLİ (Ayrı GUI) | ÇELİŞKİLİ (Ayrı GUI) | KISMEN | **%100 TAM UYUMLU** |
| **Donanımsal İmza Kilidi** | Var (TPM 2.0) | Var (TPM 2.0) | Var (FIDO2 Chip) | **Var (Yerel TPM 2.0 İkincil Kilit)** |
| **Windows 11 Uyumluluğu** | %100 | Yönetici Yetkisi Şart | %100 | **%100** |
| **Uygulama ve Bakım Maliyeti** | Orta | Çok Yüksek / Kırılgan | Yüksek | **Düşük / Sürdürülebilir** |
| **Nihai Karar Uygunluğu** | **NO-GO** | **NO-GO (Aşırı Maliyet)** | **BEKLEMEDE** | **ÖNERİLEN MİMARİ** |

---

## 7. Önerilen Mimari ve Gerekçesi

### 7.1. Önerilen Model: İki Faktörlü Hibrit Güven Mimarisi (Director Out-of-Band + TPM Local Anchor)

OtonomMCP projesinin mimari ilkeleri ve teknik kısıtları göz önüne alındığında, **Alternatif 4 merkezli bir Hibrit Mimari** önerilmektedir:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ FAKTÖR 1: BANT DIŞI BİLİNÇLİ İNSAN ONAYI (Director Out-of-Band WYSIWYS Layer)         │
│ - Kullanıcının tek muhatabı olan ChatGPT Director arayüzü kullanılır.                  │
│ - Onaylanacak paketin özeti, bütçesi ($10 USD), task/action kimlikleri ve              │
│   kanonik SHA-256 özütü kullanıcıya zengin metin kartı olarak sunulur.                 │
│ - Kullanıcı bilinçli olarak "Onaylıyorum" dediğinde Director Session Token üretilir.   │
│ - YEREL ZARARLI YAZILIM BU OTURUMU TAKLİT EDEMEZ (Same-User Immunity).                │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼ [Onay İmzalı Token AIDM'e İletildiğinde]
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ FAKTÖR 2: YEREL MAKİNE VE DONANIM KİLİDİ (Local Hardware Anchor Layer)                 │
│ - AIDM, alınan Director onay jetonunu yerel TPM 2.0 anahtarı ile mühürler.             │
│ - MS_PLATFORM_KEY_STORAGE_PROVIDER üzerinden donanım imzası alınır.                    │
│ - Sessiz çalışma 0x80090022 ile engellenir.                                            │
│ - ExecutionBridge Check 6, hem Director Session Token'ı hem de TPM donanım             │
│   imzasını matematiksel olarak doğrulamadan BLOCKED_ON_AUTH_CONTEXT kilidini açmaz.   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 7.2. Gerekçe
1. **Director-Only Kuralının Korunması:** Kullanıcıya ikinci bir bağımsız arayüz, C# penceresi veya ayrı bir onay programı dayatılmaz. Sistem tek sesli ve tutarlı kalır.
2. **Same-User Açığının Kesin Çözümü:** Yerel Windows ortamında çalışan hiçbir komut dosyası, kullanıcının cloud tabanlı ChatGPT kimliğini taklit edemez.
3. **Kör İmzanın Ortadan Kaldırılması:** Kullanıcı neyi onayladığını açıkça görür (WYSIWYS sağlanır).
4. **Donanım Garantisi:** Yerel yürütme aşamasında TPM 2.0 devrede kalarak, işlemin sadece yetkilendirilmiş fiziksel geliştirici makinesinde koşmasını garanti eder.

---

## 8. Çözülemeyen Riskler (Residual Unresolvable Risks)

1. **Aynı Kullanıcı Bellek Manipülasyonu (In-Memory Hooking):**  
   Windows NT mimarisinde aynı kullanıcı altındaki bir süreç, `OpenProcess` ve `WriteProcessMemory` yetkisine sahiptir. Node.js sürecinin belleği ele geçirilirse, kod yürütme akışı baypas edilebilir. Bu risk yalnızca işletim sistemi düzeyinde farklı bir kullanıcı hesabı veya sanallaştırma (Hyper-V / WSL2) ile çözülebilir.
2. **Kullanıcı Onay Yorgunluğu (Approval Fatigue):**  
   Kullanıcının detayları okumadan sık aralıklarla gelen onay isteklerine ezbere onay vermesi riski teknik olarak engellenemez.
3. **Bulut Oturumu ve Ağ Bağımlılığı:**  
   Director out-of-band onayı internet bağlantısı ve OpenAI altyapısının çalışır durumda olmasını gerektirir. Tamamen çevrimdışı (offline) ortamlarda bu hat çalışmaz.

---

## 9. Üretim Entegrasyonu İçin Zorunlu Kabul Kriterleri

Gelecekte herhangi bir güven kökü veya Companion bileşeninin üretim koduna (`packages/core/src/*`) entegre edilebilmesi için aşağıdaki 6 kabul kriterinin **eksiksiz ve bağımsız kanıtlarla** sağlanması zorunludur:

1. **WYSIWYS Kanıtı:** Kullanıcıya sunulan onay metni ile imzalanan kanonik JSON yükünün (`HardwareConsentPayload`) SHA-256 özetinin birebir matematiksel eşleştiği kanıtlanmalıdır.
2. **Anti-Automation Kanıtı:** Onay mekanizmasının sentetik fare tıklamaları, `UIAutomation` ve `SendInput` API'leri ile otomatikleştirilemeyeceği işletim sistemi seviyesinde doğrulanmalıdır.
3. **Güvenli IPC ve Bütünlük:** Eğer harici bir yerel yardımcı süreç kullanılacaksa; binary'si Authenticode ile imzalı olmalı, `Program Files` gibi korumalı dizinde yer almalı ve IPC borusu karşılıklı kimlik doğrulamalı (Mutual Handshake) olmalıdır.
4. **Replay ve Nonce Sürekliliği:** Nonce tablosunun silinmesi durumunda dahi süresi dolmuş token'ların kesin olarak reddedileceği (`TTL <= 60s`) kanıtlanmalıdır.
5. **Fail-Closed P20 Gate:** `ExecutionBridge` Check 6'nın hiçbir koşulda gevşetilmeyeceği, `verified: true` gibi istemci beyanlarının reddedildiği regresyon testleriyle korunmalıdır.
6. **Director-Only Bütünlüğü:** Kullanıcının onay ve karar alışverişini doğrudan ve yalnızca Director ile yaptığı doğrulanmalıdır.

---

## 10. GO / CONDITIONAL GO / NO-GO Kararı

| Kapsam | Karar | Gerekçe |
|---|:---:|---|
| **Standart Win32 İzolesiz Companion Worker Üretim Entegrasyonu** | **KESİN NO-GO** | Aynı kullanıcı süreçlerine karşı savunmasızdır; kör imzalama (Blind Signing) riskini çözemez; Director-only ilkesiyle çelişir. |
| **P20 Check 6 Kapısının Mevcut Durumda Açılması** | **KESİN NO-GO** | Güvenilir insan onayı ve donanım kökü kanıtlanmadan `BLOCKED_ON_AUTH_CONTEXT` kaldırılamaz. |
| **Director-Only Hibrit Güven Mimarisi Araştırma ve Tasarımı** | **ŞARTLI GO** | Çözüm teorik olarak sağlamdır; ancak IDE sohbet fizibilitesi (`DIRECTOR-INTERACTION-01`) ve izole doğrulama (`TRUST-ROOT-05`) tamamlanmalıdır. |

---

## 11. DIRECTOR-INTERACTION-01 İle İlişkili Bağımlılıklar

1. **IDE Chat Kanalının Yetenek Sınırı:**  
   Antigravity IDE sohbetinin Director tarafından yapılandırılmış onay istekleri (`ask_question`, form veya seçenekli callback) sunmak için kullanılıp kullanılamayacağı henüz doğrulanmamıştır.
2. **Tek Muhatap Kuralı:**  
   Eğer IDE chat altyapısı Director'ın kullanıcıya güvenli soru/onay sunmasını desteklemiyorsa, AIDM içine ikinci bir sohbet arayüzü eklenemez. Desteklenen resmi alternatifler `DIRECTOR-INTERACTION-01` kapsamında araştırılmalıdır.
3. **IDE Yanıtının Güven Derecesi:**  
   IDE sohbetinden dönen metin tek başına güvenilir Product Owner onayı kabul edilemez; işlem özütü ile kriptografik olarak mühürlenmelidir.

---

## 12. Sonraki Görev Önerisi

[OtonomMCP_Birlikte_Gelistirme_Plani.md](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/OtonomMCP_Birlikte_Gelistirme_Plani.md) belgesinde tanımlanan bağlayıcı sıraya tam uyum sağlanarak:

👉 **Sıradaki Görev:** **`DIRECTOR-INTERACTION-01 — Director-Only IDE Chat Feasibility Audit (READ-ONLY)`**  
- Antigravity IDE'nin resmi ve desteklenen arayüzleriyle (MCP, extension, chat API) Director'ın kullanıcıya seçenekli soru/onay sunma ve yanıtı aynı oturuma bağlama kabiliyeti denetlenecektir.
- Kaynak kod, test veya bağımlılık değişikliği yapılmayacaktır.

Bu rapor sonrasında **Companion Worker geliştirmesine otomatik onay verilmemiştir**. Üretim entegrasyonu için sonraki mimari karar (`TRUST-ROOT-05`) ve açık kabul şarttır.
