# TRUST-ROOT-01 — Trusted IDE Root of Trust Fizibilite ve Mimari Güvenlik Raporu

**Rapor Kodu:** TRUST-ROOT-01-FEASIBILITY-REPORT  
**Tarih:** 2026-10-03  
**Kapsam:** P22 Trusted IDE Authentication Altyapısı, Windows NT Güvenlik Sınırları, Antigravity IDE / Electron Süreç Modeli, Model Context Protocol (MCP) ve Donanım Destekli İnsan Onayı  
**Durum:** TAMAMLANDI (Fizibilite ve Güvenlik Denetimi)

---

## Yönetici Özeti ve Temel Soruya Cevap

### Temel Soru
> **Antigravity IDE içinde, aynı Windows kullanıcısının başka bir sürecinin taklit edemeyeceği biçimde IDE kimliği ve gerçek insan onayı doğrulanabilir mi?**

### Kanıtlı ve Açık Yanıt
1. **IDE Kimliği (Process Identity / Provenance) Açısından: KESİNLİKLE HAYIR.**  
   Microsoft Windows NT güvenlik mimarisinde (Discretionary Access Control - DAC), aynı kullanıcı hesabı (User SID) ve aynı Bütünlük Düzeyinde (Medium Integrity Level) çalışan süreçler arasında işletim sistemi düzeyinde bir güvenlik sınırı (security boundary) **bulunmamaktadır**. Antigravity IDE (Electron tabanlı masaüstü ortamı), işletim sistemine kayıtlı donanımsal veya kriptografik olarak izole edilmiş bir süreç kimliğine (Process Attestation) sahip değildir. Aynı kullanıcı hesabında çalışan herhangi bir arka plan süreci (PowerShell, Python, kötü niyetli komut dosyası), Antigravity IDE'nin ortam değişkenlerini, dosya sistemini ve stdio borularını tamamen taklit edebilir veya bunların belleğini okuyabilir.
2. **Gerçek İnsan Onayı (Proof of Human Presence) Açısından: KISMEN EVET (Donanım Destekli OS Düzeyinde).**  
   İnsan onayı Antigravity IDE'nin sohbet arayüzünden veya istemci payload'ından **kanıtlanamaz**. Ancak Windows TPM 2.0 ve CNG (Cryptography Next Generation) KSP altında `NCRYPT_UI_POLICY_ALWAYS` bayrağı ile Windows Hello (Biyometri / PIN) işletim sistemi güvenlik modalı zorunlu tutularak, o anda bilgisayar başında fiziksel bir insanın varlığı kanıtlanabilir.
3. **Sonuç ve Mimari Duruş:**  
   "IDE'nin yazılımsal kimliğine güvenmek" bir güvenlik yanılsamasıdır (Client-Side Trust Fallacy). Sistem, IDE sürecine güvenmek yerine **"Donanım destekli (TPM 2.0 + Windows Hello) fiziksel insan onayına ve P20/P21 Fail-Closed kapılarına"** dayanmalıdır.

---

## 1. Mevcut Güven Zincirinin Gerçek Durumu

P22 kapsamında uygulanan Ed25519, DPAPI ve Nonce mekanizmaları incelendiğinde mevcut durum şu şekildedir:

```
[Mevcut Durum Kriptografik Akışı]
crypto.generateKeyPairSync('ed25519')
               │
               ▼
DPAPI CurrentUser (PowerShell ProtectedData.Protect)
               │
               ▼
Diskte Depolama: .ai-manager/state/identity.json
               │
               ▼
İmzalama: IdentityManager.signPayload(payload, privateKey)
               │
               ▼
Doğrulama: AuthContextValidator.validate(context, currentProjectId)
```

### Güven Zincirindeki Kopukluklar (Root of Trust Eksikliği):
1. **Güven Köksüzlüğü (No Root of Trust):**  
   Oluşturulan Ed25519 anahtarı tamamen yerel ve özyinelemelidir (self-generated). Bir Sertifika Otoritesi (CA), donanım kökü (TPM) veya Antigravity platform PKI hiyerarşisi tarafından onaylanmamıştır.
2. **Kriptografik İllüzyon:**  
   Ed25519 doğrulaması yalnızca `"Bu yük, diskteki identity.json dosyasındaki public key'in eşi olan private key ile imzalanmıştır"` önermesini doğrular. Bu imzanın Antigravity IDE tarafından mı, yoksa aynı kullanıcı hesabı altındaki rastgele bir süreç tarafından mı atıldığını doğrulayamaz.
3. **Mevcut Başarı:**  
   Kriptografik altyapı veri bütünlüğünü (data tampering), replay saldırılarını (nonce store) ve cross-project/cross-session yetki sızıntılarını %100 matematiksel kesinlikle engellemektedir; ancak imzalayıcının gerçek kimliğini garanti edememektedir.

---

## 2. Antigravity IDE'nin Sağlayabildiği Güven Kanıtları

Antigravity IDE ve işletim sistemi arasındaki kimlik katmanları birbirinden kesin olarak ayrılmalıdır:

| Kimlik Katmanı | Gerçekte Neyi Kanıtlar? | Neyi Kanıtlayamaz? | Yerine Geçebilir mi? |
|---|---|---|---|
| **IDE Tarafından Doğrulanmış Süreç Kimliği** | Yoktur. Antigravity IDE bir Electron/VS Code çatalıdır; alt süreçlere kriptografik attestation token aktarmaz. | Sürecin gerçekten Antigravity IDE olduğunu kanıtlayamaz. | Hayır. |
| **İşletim Sistemi Tarafından Doğrulanmış Süreç Kimliği** | Yalnızca Process ID (PID) ve Image Path (`Antigravity.exe`). | `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` manipülasyonu ve PID geri dönüşümü nedeniyle spoofing'e karşı güvenli kanıt oluşturamaz. | Hayır. |
| **Kullanıcı Hesabı Kimliği (User SID)** | İşlemin `NAZİF AÇIKGÖZ` (S-1-5-21-...) kullanıcısı altında çalıştığını kanıtlar. | Kullanıcının hangi uygulamasının çalıştığını ayırt edemez. | Hayır. |
| **İmzalı AuthContext** | Belirli bir private key'in kullanıldığını kanıtlar. | Key'in kimin tarafından ve hangi arayüzde kullanıldığını kanıtlayamaz. | Hayır. |
| **Gerçek İnsan Etkileşimi (Human Interaction)** | IDE arayüzünde chat'e yazılan metin veya tıklanan buton salt Electron DOM olayıdır. | Olayın bir LLM aracı tarafından mı yoksa gerçek bir insan parmağıyla mı tetiklendiğini kanıtlayamaz. | Hayır. |

---

## 3. Windows Güvenlik Mekanizmalarının Karşılaştırması

Windows platformunda kullanılabilir güvenlik mekanizmalarının teknik analizi:

| Mekanizma | Gerçekte Neyi Kanıtlar? | Neyi Kanıtlayamaz? | Aynı Kullanıcı Zararlısına Karşı Koruma | Kullanıcı Etkileşimi | Win 11 Uyumluluğu | Maliyet & Karmaşıklık |
|---|---|---|---|---|---|---|
| **DPAPI (`CurrentUser`)** *(Mevcut Yapı)* | Verinin geçerli oturum açmış kullanıcı tarafından şifrelendiğini ve offline çalınamayacağını. | Aynı kullanıcının diğer süreçlerini ayırt edemez. | **%0 (Koruma Yok)** | Yok (Sessiz) | %100 | Çok Düşük (PowerShell/Native) |
| **DPAPI (`LocalMachine`)** | Verinin bu fiziksel makinede şifrelendiğini. | Makinedeki tüm kullanıcılar ve süreçler çözebilir. | **%0 (Daha Güvensiz)** | Yok | %100 | Düşük |
| **Windows Credential Manager** | Kimlik bilgisinin Windows kasa veritabanında olduğunu. | Aynı kullanıcıdaki her script `CredReadW` ile okuyabilir. | **%0 (Koruma Yok)** | Yok | %100 | Düşük |
| **CNG / Software KSP** | Yazılımsal anahtar saklama ve kriptografik işlemleri. | Anahtar diskte DPAPI ile saklanır; diğer süreçler erişebilir. | **%0 (Koruma Yok)** | Yok | %100 | Orta |
| **TPM 2.0 Platform Crypto Provider** | Özel anahtarın donanım yongasında olduğunu ve RAM/diskten çalınamayacağını. | Hangi sürecin TPM'e imza çağrısı yaptığını (`NCryptSignHash`). | **Kısmi (Anahtar çalınamaz ama imza attırılabilir)** | Yok (PIN yoksa) | %100 | Yüksek (Win32 Native C++) |
| **Windows Hello (`NCRYPT_UI_POLICY_ALWAYS`)** | **O anda fiziksel bir insanın PIN veya Biyometri (Yüz/Parmak İzi) ile onay verdiğini.** | Çağrıyı başlatan uygulamanın IDE mi yoksa harici süreç mi olduğunu. | **Yüksek (Kullanıcı onayı olmadan sessiz imza atılamaz)** | **Var (OS Modal PIN/Biyometri)** | %100 | Yüksek (Native Win32 Köprüsü) |
| **AppContainer / UWP Sandbox** | Sürecin dosya ve ağ erişiminin kısıtlandığını. | Antigravity IDE genel amaçlı geliştirme aracıdır; sandbox'a alınamaz. | Yüksek | Yok | Kısıtlı | İmkansız (Geliştirme ortamı kısıtlanamaz) |

---

## 4. MCP Client Authentication Analizi

### 4.1. Mevcut stdio Bağlantısı
- Antigravity IDE, MCP sunucusunu `stdio` (isimsiz boru / anonymous pipe) üzerinden bir alt süreç (`node packages/core/bin/aidm.js mcp`) olarak başlatır.
- İşletim sistemi düzeyinde isimsiz borular üzerinden mTLS, kimlik sertifikası veya oturum doğrulama desteği yoktur.
- Stdio yalnızca bir karakter akışıdır (byte stream).

### 4.2. İstemci Payload'ındaki Alanların Değeri
- MCP istemcisinin gönderdiği JSON-RPC mesajındaki `actorRole: "PRODUCT_OWNER"`, `verified: true`, `isTrueHumanInteraction: true` gibi alanlar **tamamen güvenilmezdir**.
- Bir saldırgan veya kontrolden çıkmış bir LLM aracı, bu alanları doğrudan JSON içerisine yazabilir.
- **Mimari Kural:** Bu alanlar asla güven veya yetki kanıtı olarak kabul edilemez.

### 4.3. Named Pipes (Adlandırılmış Borular) Alternatifi
- Windows'ta Named Pipe kullanıldığında sunucu `GetNamedPipeClientProcessId()` ile istemcinin PID'sini alabilir.
- Ancak Antigravity IDE'nin standart MCP yapılandırması (`mcp_config.json`) yalnızca `stdio` tabanlı başlatmayı desteklemektedir. Named pipe desteği Antigravity tarafında bulunmamaktadır.

---

## 5. Threat Model ve Saldırı Senaryoları

| # | Tehdit Senaryosu | Saldırı Yöntemi | Mevcut Koruma Durumu | Kalan Risk ve Etki |
|---|---|---|---|---|
| **S1** | **Aynı Windows kullanıcısı altında zararlı süreç** | Arka plandaki script `identity.json` dosyasını okur ve DPAPI ile çözer. | DPAPI `CurrentUser` aynı kullanıcının süreçlerini ayırt edemez. | **%100 KRİTİK.** Anahtar çalınabilir ve sahte imzalar üretilebilir. |
| **S2** | **Sahte MCP istemcisi** | Harici bir komut istemcisi `aidm mcp` başlatarak sahte action gönderir. | P20 anti-spoof kontrolleri imzasız veriyi reddeder; ancak S1 gerçekleşirse imzalayabilir. | **Yüksek.** S1'e bağımlı. |
| **S3** | **Sahte Product Owner** | İstemci veya LLM `actorRole: "PRODUCT_OWNER"` gönderir. | **TAM KORUMA.** P20-01C fail-closed `BLOCKED_ON_AUTH_CONTEXT` döner. | **Sıfır.** Yürütme başlamaz. |
| **S4** | **Başka workspace'ten AuthContext transferi** | Workspace A için imzalanan token Workspace B'de kullanılır. | **TAM KORUMA.** `projectId` ve `workspaceId` bağlama kontrolü ile anında reddedilir. | **Sıfır.** Çapraz proje sızıntısı engellenir. |
| **S5** | **Tekrar kullanılan nonce (Replay)** | Ağdan veya logdan yakalanan token tekrar gönderilir. | **TAM KORUMA.** `seen-nonces.json` ve RAM önbelleği ile reddedilir. | **Sıfır.** Çift harcama engellenir. |
| **S6** | **IDE kapandıktan sonra kalan kimlik** | Diskte kalan `identity.json` kötüye kullanılır. | `expiresAt` süresi (60s) dolduğunda token reddedilir; ancak anahtar diskte kalır. | **Orta.** Anahtar silinmedikçe yeni token üretilebilir. |
| **S7** | **Multi-instance çakışması (İkinci IDE)** | İkinci bir IDE penceresi aynı workspace üzerinde AIDM açar. | **TAM KORUMA.** `LocalRuntimeStateManager.acquireInstanceLock` PID kilidi ile ikinciyi engeller. | **Sıfır.** Çift çalışma engellenir. |
| **S8** | **Kullanıcı etkileşimi olmadan otomatik onay** | Ajan kendi kendine `aidm_approval_package_approve` çağırır. | **TAM KORUMA.** `isTrueHumanInteraction: false` kalır ve `BLOCKED_ON_AUTH_CONTEXT` devreye girer. | **Sıfır.** Otonom kaçak önlenir. |
| **S9** | **Private key'in başka süreççe çözülmesi** | S1 senaryosundaki DPAPI zafiyetinin gerçekleşmesi. | DPAPI mimarisi aynı kullanıcıya açıktır. | **%100 KRİTİK.** |

---

## 6. Mevcut Mimaride Kesinlikle Korunacak Bileşenler

Aşağıdaki bileşenler sağlam bir matematiksel ve mimari temel üzerine oturmuştur ve korunmalıdır:

1. **`NonceStore`:** Replay ve token çalınması saldırılarına karşı deterministik ve kalıcı koruma sağlar.
2. **`ExecutionBridge` (P20 Önkoşul Zinciri):** 10 aşamalı sıkı kontrol mekanizması ve `BLOCKED_ON_AUTH_CONTEXT` fail-closed mimarisi.
3. **`AuthorizationPolicyEngine` & `ProjectMandateStore` (P21):** Proje sözleşmesi, izin verilen komutlar, dizin sınırları ve revizyon bağlama mimarisi.
4. **`LocalRuntimeStateManager`:** Tek aktif instance garantisi, PID mülkiyeti, lock çalınmasını ve zombie takeover'ı engelleyen yapı.
5. **`AuthContextValidator`:** Şema, süre, proje, oturum ve fingerprint bağlama kontrolleri.

---

## 7. Teknik Olarak Uygulanabilir Seçenekler

### Seçenek 1: Donanım Destekli Windows Hello İnsan Varlık Kanıtı (Hardware-Backed Proof of Human Presence)
- **Teknoloji:** Windows CNG KSP (`MS_PLATFORM_CRYPTO_PROVIDER`) + TPM 2.0 + `NCRYPT_UI_POLICY_ALWAYS`.
- **İşleyiş:**  
  1. Özel anahtar doğrudan TPM donanımında üretilir ve TPM dışına asla çıkarılamaz (non-exportable).
  2. Her kritik onay işleminde (Mandate kaydı, Approval onayı), işletim sistemi güvenli masaüstünde Windows Hello modal iletişim kutusunu açar (PIN veya Biyometri ister).
  3. Yalnızca kullanıcı fiziksel olarak doğrulama yaparsa TPM hash'i imzalar.
- **Avantajı:** Arka planda sessiz çalışan hiçbir kötü amaçlı süreç veya ajan kullanıcının fiziksel haberi olmadan imza üretemez.
- **Sınırı:** Çağrıyı başlatan uygulamanın IDE olup olmadığını ayırt edemez.

### Seçenek 2: Kısa Ömürlü Bellek İçi Ephemeral Anahtar (In-Memory Ephemeral Session Key)
- **Teknoloji:** Anahtar diske (DPAPI dahil) kesinlikle yazılmaz.
- **İşleyiş:**  
  1. MCP sunucusu başladığında RAM'de tek kullanımlık bir Ed25519 anahtar çifti üretilir.
  2. Sunucu kapandığında anahtar bellekten silinir.
  3. Diskte hiçbir özel anahtar saklanmaz.
- **Avantajı:** Disk tabanlı saldırılar ve oturum sonrası kalan anahtar riski (S6, S9) tamamen ortadan kalkar.
- **Sınırı:** RAM okuma yetkisine sahip yerel süreçlere karşı koruma sağlamaz.

---

## 8. Uygulanamayan veya Kanıtlanamayan Seçenekler

Aşağıdaki yaklaşımlar teorik olarak önerilse de mevcut mimari ve işletim sistemi sınırları gereği **uygulanamaz veya sahte güvenlik sağlar**:

1. **"Saf MCP Stdio Üzerinden Trusted IDE Doğrulaması": İMKANSIZDIR.**  
   Standart JSON-RPC stdio akışında istemcinin kimliğini kanıtlayacak kriptografik bir mekanizma yoktur.
2. **"DPAPI CurrentUser ile Süreç İzolasyonu": İMKANSIZDIR.**  
   Microsoft DPAPI belgelerinde açıkça belirtildiği üzere, DPAPI süreçleri değil kullanıcı hesaplarını birbirinden ayırır.
3. **"Parent PID Denetimi ile Güvenlik": GÜVENİLMEZDİR.**  
   Win32 API `UpdateProcThreadAttribute` ve `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` kullanılarak herhangi bir süreç sahte parent PID ile başlatılabilir.
4. **"LLM Çıktısından İnsan Niyeti Analizi": GÜVENİLMEZDİR.**  
   Prompt injection ve jailbreak teknikleriyle LLM'e sahte insan onay ifadeleri ürettirilebilir.

---

## 9. Önerilen Hedef Mimari (Defense-in-Depth)

Gerçekçi, dürüst ve güvenli bir mimari şu dört katmandan oluşmalıdır:

```
┌────────────────────────────────────────────────────────────────────────┐
│ KATMAN 1: Donanım Kökü (Hardware Root of Trust)                        │
│ - TPM 2.0 tabanlı non-exportable anahtar                               │
│ - Diskte plaintext veya DPAPI private key saklanmaz                   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ KATMAN 2: Fiziksel İnsan Varlığı (Proof of Human Presence)              │
│ - Windows Hello PIN / Biyometri (NCRYPT_UI_POLICY_ALWAYS)              │
│ - Sessiz/otonom arka plan imzalama engellenir                          │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ KATMAN 3: Zaman ve Kapsam Kısıtlaması (Temporal & Contextual Binding)   │
│ - 60 saniyelik TTL (expiresAt)                                         │
│ - Tek kullanımlık NonceStore (Replay koruması)                         │
│ - ProjectId, SessionId, TaskId ve Revision tam eşleşmesi               │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ KATMAN 4: Fail-Closed Politika Kapısı (P20 / P21 Policy Engines)       │
│ - isTrueHumanInteraction = SADECE Katman 2 başarıyla tamamlandığında  │
│ - Eksik veya şüpheli her durumda: BLOCKED_ON_AUTH_CONTEXT              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Açık Kalan Riskler

Bu mimari uygulandığında dahi teorik olarak açık kalan riskler:

1. **Sosyal Mühendislik ile Windows Hello Onayı:**  
   Kötü niyetli bir yerel yazılım Windows Hello ekranını tetiklerse ve kullanıcı bunu AIDM işlemi sanarak parmak izini okutursa sahte bir imza üretilebilir.
2. **Bellek İçi (In-Memory) Manipülasyon:**  
   Aynı kullanıcı oturumunda çalışan gelişmiş bir zararlı (örn. debugger veya bellek tarayıcı), MCP sürecinin RAM'ini okuyarak o an bellekte bulunan doğrulanmış token'ları çalabilir (Windows DAC sınırının doğal sonucu).

---

## 11. Uygulama Ön Koşulları

Bu mimariye geçiş yapılabilmesi için gereken asgari sistem gereksinimleri:
- Windows 11 64-bit işletim sistemi.
- Anakartta aktif TPM 2.0 yongası.
- Yapılandırılmış ve çalışan Windows Hello (PIN, Parmak İzi veya Yüz Tanıma).
- Node.js ile Windows CNG API'lerini çağıracak native Win32 C++ addon (veya imzalı PowerShell modülü).

---

## 12. Kabul Kriterleri (Acceptance Criteria)

Hedef mimarinin kabul edilebilmesi için sağlanması gereken kriterler:

- [ ] **AC-01:** Özel anahtar disk dosya sisteminde kesinlikle saklanmamalıdır (TPM donanımında veya salt RAM'de tutulmalıdır).
- [ ] **AC-02:** Kullanıcı onayı gerektiren işlemlerde Windows işletim sistemi düzeyinde fiziksel etkileşim (Windows Hello) modalı açılmalıdır.
- [ ] **AC-03:** Arka planda çalışan sessiz bir süreç, kullanıcı etkileşimi olmadan onay üretememelidir.
- [ ] **AC-04:** İmzalı her yük proje, oturum, görev ve revizyon numarasına kriptografik olarak bağlı olmalıdır.
- [ ] **AC-05:** P20 `BLOCKED_ON_AUTH_CONTEXT` davranışı, fiziksel doğrulama sağlanmadığı sürece fail-closed olarak yürütmeyi engellemeye devam etmelidir.

---

## Sonuç

Mevcut işletim sistemi ve MCP mimarisinde **"Antigravity IDE'nin taklit edilemez süreç kimliği"** teknik olarak **sağlanamaz**.  
Ancak **"Fiziksel insanın donanım destekli (TPM 2.0 + Windows Hello) gerçek onayı"** teknik olarak **sağlanabilir**.

Sistem, sahte bir IDE kimliği varsayımı yerine, **fiziksel kullanıcı onayı ve fail-closed koruma duvarı** üzerine inşa edilmelidir. Bu gereksinimler henüz üretim koduna entegre edilmediği sürece P22'nin güvenlik durumu **`CRYPTOGRAPHIC_INFRASTRUCTURE_VERIFIED_PENDING_TRUE_ROOT_OF_TRUST`** olarak kalmalıdır.
