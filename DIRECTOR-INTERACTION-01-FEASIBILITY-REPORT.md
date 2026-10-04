# DIRECTOR-INTERACTION-01 — Director-Only IDE Chat Feasibility Audit

**Rapor Kodu:** DIRECTOR-INTERACTION-01-FEASIBILITY-REPORT  
**Tarih:** 2026-10-04  
**Görev Türü:** READ-ONLY / TECHNICAL FEASIBILITY AUDIT  
**Öncelik:** Kritik  
**Bağımlılık:** TRUST-ROOT-04 tamamlandı  
**Amaç:** OtonomMCP'nin bağlayıcı "Director-only kullanıcı etkileşimi" mimarisinin Antigravity IDE içerisinde teknik olarak uygulanabilirliğini, resmi API ve dokümantasyon sınırlarıyla doğrulamak.

---

## 1. Yönetici Özeti

Bu fizibilite denetimi, [OtonomMCP_Birlikte_Gelistirme_Plani.md](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/OtonomMCP_Birlikte_Gelistirme_Plani.md) belgesinde tanımlanan bağlayıcı mimari kararı ("Kullanıcının tek muhatabı ChatGPT Director'dır; AIDM ve AGY doğrudan kullanıcıya soru sormaz") temel alarak, Antigravity IDE ortamının resmi yeteneklerini, extension/chat arayüzlerini ve Model Context Protocol (MCP) mekanizmalarını incelemiştir.

### 1.1. Temel Bulgular

1. **IDE İçi Etkileşim ve Soru Sorma (VERIFIED):**  
   Antigravity IDE çalışma ortamında, çalışan bir ajanın kullanıcıya seçenekli sorular sorması, açıklama istemesi ve onay alması için resmi, yerel bir araç bulunmaktadır: **`default_api:ask_question`**. Bu araç çağrıldığında IDE arayüzünde etkileşimli bir modal açılır (`question`, `options`, `is_multi_select`, serbest yazma kutusu ve Submit/Skip butonları); kullanıcı yanıt verene kadar yürütme engellenir (blocking execution) ve kullanıcının seçimi/cevabı ajana doğrudan dönüş değeri olarak iletilir. Ayrıca doküman/plan onayları için Artifact metadata'sında yer alan `RequestFeedback: true` özelliği kullanıcıya resmi "Proceed" onay butonu sunmaktadır.

2. **Harici Headless Chat Push API Yokluğu (NOT_SUPPORTED):**  
   Arka planda bağımsız bir işletim sistemi süreci olarak çalışan harici bir uygulamanın (örneğin CLI'dan veya arka plandaki ayrı bir Node.js daemon'ından) Antigravity IDE'nin açık olan sohbet paneline dışarıdan HTTP/WebSocket/IPC üzerinden doğrudan ve kendiliğinden (unsolicited) chat mesajı basabileceği resmi bir **"Headless IDE Chat Push API"si MEVCUT DEĞİLDİR**. IDE sohbetine yalnızca aktif sohbet oturumundaki ajan veya kullanıcının kendisi girdi sağlayabilir.

3. **MCP Stdio Kanalının Asenkron Bildirim Sınırı (PARTIALLY_VERIFIED):**  
   Antigravity IDE, MCP istemcisi (client) olarak yerel stdio sunucularını (`mcp_config.json`) tam olarak destekler. Ancak standart MCP stdio protokolünde bir sunucu, istemciye JSON-RPC `notifications/message` gönderebilse de, bu bildirimler Antigravity IDE tarafından kullanıcının sohbet penceresinde etkileşimli bir soru/onay balonu olarak **kendiliğinden render edilmez**. İletişim, ajanın MCP araçlarını çağırması (`tools/call`) ve dönen yapılandırılmış cevabı yorumlayarak `ask_question` ile kullanıcıya sunması şeklinde yürütülmelidir.

4. **Kritik Güvenlik Ayrımı (Chat Yanıtı vs. Kriptografik İnsan Onayı):**  
   IDE chat veya modal penceresi üzerinden kullanıcının bir seçeneği tıklaması, **yalnızca kullanıcı niyetinin (intent) beyanıdır**. Bu yanıt Electron DOM ve JavaScript ortamında üretildiği için işletim sistemi düzeyinde fiziksel insan varlığını veya Product Owner kimliğini tek başına **KANITLAYAMAZ**. Güvenli bir insan onayı için, chat üzerinden alınan niyet beyanının yerel TPM 2.0 donanım anahtarı (`MS_PLATFORM_KEY_STORAGE_PROVIDER`) ile mühürlenmesi ve `ExecutionBridge` Check 6 kapısından geçirilmesi zorunludur.

5. **Nihai Karar: ŞARTLI GO (CONDITIONAL GO).**  
   Director'ın kullanıcı ile Antigravity IDE sohbetinde buluşması, **Antigravity Agent Core ve native `ask_question` köprüsü üzerinden teknik olarak %100 UYGULANABİLİRDİR**. İkinci bir sohbet arayüzüne, ayrı bir masaüstü Companion GUI'ye veya harici push sunucusuna ihtiyaç yoktur.

---

## 2. Antigravity IDE Sürümü ve Resmi API Kaynakları

Bu denetim aşağıdaki resmi dokümanlar, sistem tanımları ve SDK kaynakları incelenerek gerçekleştirilmiştir:

### 2.1. İncelenen Resmi Dokümantasyon Kaynakları
1. **Antigravity IDE Referansı:**  
   [`builtin/skills/antigravity_guide/references/ide.md`](file:///C:/Users/NAZ%C4%B0F%20A%C3%87IKG%C3%96Z/.gemini/antigravity-ide/builtin/skills/antigravity_guide/references/ide.md)  
   - VS Code tabanlı AI-first IDE mimarisi.
   - Sidebar Chat, Agent Mode, Inline Code Lenses, Diagnostic Auto-Fix.
   - Workspace-scoped yapılandırma (`.agents/`).
2. **Antigravity 2.0 Masaüstü Referansı:**  
   [`builtin/skills/antigravity_guide/references/app.md`](file:///C:/Users/NAZ%C4%B0F%20A%C3%87IKG%C3%96Z/.gemini/antigravity-ide/builtin/skills/antigravity_guide/references/app.md)  
   - Electron tabanlı masaüstü orkestrasyonu.
   - Chat Canvas, Slash Commands, `@` mentions, Scheduled Tasks.
3. **Antigravity CLI (`agy`) Referansı:**  
   [`builtin/skills/antigravity_guide/references/cli.md`](file:///C:/Users/NAZ%C4%B0F%20A%C3%87IKG%C3%96Z/.gemini/antigravity-ide/builtin/skills/antigravity_guide/references/cli.md)  
   - Terminal tabanlı TUI ajan etkileşimi.
4. **Antigravity Python SDK:**  
   [`builtin/skills/antigravity_guide/references/sdk.md`](file:///C:/Users/NAZ%C4%B0F%20A%C3%87IKG%C3%96Z/.gemini/antigravity-ide/builtin/skills/antigravity_guide/references/sdk.md)  
   - `google-antigravity` SDK; ajan yaşam döngüsü, araç entegrasyonu ve akışkan yanıtlar (`response.thoughts`, `response.tool_calls`).
5. **Özelleştirme ve Yaşam Döngüsü Kancaları (Lifecycle Hooks):**  
   [`builtin/skills/agy-customizations/docs/hooks.md`](file:///C:/Users/NAZ%C4%B0F%20A%C3%87IKG%C3%96Z/.gemini/antigravity-ide/builtin/skills/agy-customizations/docs/hooks.md)  
   - `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` olayları.
   - Stdin/stdout üzerinden JSON sözleşmesi (`conversationId`, `stepIdx`, `transcriptPath`).
6. **Model Context Protocol (MCP) Yapılandırması:**  
   [`builtin/skills/agy-customizations/docs/mcp_servers.md`](file:///C:/Users/NAZ%C4%B0F%20A%C3%87IKG%C3%96Z/.gemini/antigravity-ide/builtin/skills/agy-customizations/docs/mcp_servers.md)  
   - `mcp_config.json` ile Stdio ve SSE transport desteği.
   - Dinamik araç keşfi ve enjeksiyonu.
7. **Aktif Ortam Yerel Araç Tanımı (`ask_question`):**  
   IDE sistem ortamında tanımlı olan `default_api:ask_question` parametre şeması ve modal arayüz sözleşmesi.

---

## 3. API / Extension / Chat Yetenek Matrisi

Antigravity IDE'nin 12 temel yeteneği incelenmiş ve her biri için resmi destek durumu belirlenmiştir:

| No | Yetenek | Durum | Resmi Dayanak ve Teknik Açıklama |
|---|---|:---:|---|
| **1** | **IDE Chat API** | **PARTIALLY_VERIFIED** | Ajanın çalıştığı aktif oturum içinde sohbet yanıtları ve araç çağrıları üretilebilir. Ancak harici bir sürecin dışarıdan doğrudan mesaj enjekte edebileceği genel bir headless REST/WebSocket Chat API **yoktur** (`NOT_SUPPORTED`). |
| **2** | **Extension API** | **PARTIALLY_VERIFIED** | Antigravity IDE, VS Code çatalı olduğu için standart VS Code Extension API (`vscode.chat.*`, `vscode.lm.*`) altyapısına sahiptir. Ancak OtonomMCP bir VS Code extension'ı (`.vsix`) olarak değil, MCP sunucusu olarak tasarlanmıştır. |
| **3** | **MCP Client ve Server Etkileşimi** | **VERIFIED** | Antigravity IDE, `mcp_config.json` üzerinden Stdio ve SSE MCP sunucularını tam olarak destekler. OtonomMCP sunucusu aktif oturumda `OtonomMCP` adıyla başarıyla bağlıdır ve araçları listelenmektedir. |
| **4** | **Chat'e Programatik Mesaj Gönderme** | **PARTIALLY_VERIFIED** | Aktif ajan turu esnasında model cevabı veya `ask_question` modalı ile kullanıcıya soru gönderilebilir. Harici bir arka plan servisinin spontane olarak sohbete bildirim basması desteklenmez. |
| **5** | **Chat Cevabını Programatik Alma** | **VERIFIED** | `ask_question` aracı çağrıldığında yürütme duraklar (blocking); kullanıcının seçtiği veya yazdığı yanıt doğrudan aracın dönüş değeri olarak programatik olarak alınır. Ayrıca `transcript.jsonl` üzerinden geçmiş okunabilir. |
| **6** | **Seçenekli Soru / Structured Choice Desteği** | **VERIFIED** | `default_api:ask_question` aracı `questions: [{ question, options, is_multi_select }]` yapısını destekler. Kullanıcıya seçenekli butonlar ve serbest metin alanı içeren etkileşimli bir modal açar. |
| **7** | **Approve / Reject / Clarify / Defer Yanıtları** | **VERIFIED** | `ask_question` seçenekleri içerisine `['(Recommended) Approve', 'Reject', 'Clarify', 'Defer']` dizisi verilerek yapılandırılmış kullanıcı yanıtı kesin olarak alınabilir. |
| **8** | **Cevabın Aktif Session / Action ile Eşleştirilmesi** | **VERIFIED** | `ask_question` senkron bloklayan bir araç çağrısı olduğu için, dönen yanıt tam olarak soruyu soran Director turu, session ID'si ve action ID'si ile eşleşir. Karışma riski sıfırdır. |
| **9** | **Chat Session ID / Conversation ID Erişimi** | **VERIFIED** | Aktif oturumun `Conversation ID` bilgisi ortam değişkenlerinde, transcript yolunda (`<appDataDir>/brain/<conversation-id>`) ve `hooks.json` stdin verisinde (`conversationId`) resmi olarak mevcuttur. |
| **10** | **IDE Kapanması, Yeniden Açılması ve Session Recovery** | **PARTIALLY_VERIFIED** | Konuşma geçmişi `transcript.jsonl` dosyasında kalıcıdır ve IDE yeniden açıldığında oturum geri yüklenebilir. Ancak modal açıkken IDE kapatılırsa o anki in-flight tur iptal olur; yeniden açıldığında temiz bir tur başlar. |
| **11** | **Kullanıcı Cevabını Alan Süreç / API** | **VERIFIED** | Kullanıcı girdisi Antigravity IDE'nin Electron Renderer arayüzü tarafından yakalanır ve Language Server / Agentic Core sürecine iletilir. İşletim sistemi güvenlik çekirdeği devrede değildir. |
| **12** | **Resmi Event / Callback Mekanizmaları** | **PARTIALLY_VERIFIED** | `hooks.json` (`PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`) kancaları ve MCP araç dönüşleri resmi olarak desteklenir. Harici pub/sub veya webhook desteği yoktur. |

---

## 4. Gerçek Etkileşim Akışı (Adım Adım API Eşleştirmesi)

Director-only kullanıcı etkileşimi, Antigravity IDE'nin resmi yetenekleri ile aşağıdaki 10 adımlı deterministik akışla gerçekleştirilir:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. AIDM Context Alma                                                                   │
│    Director ──► aidm_director_context_sync (MCP) ──► DirectorContextSnapshot          │
│    (Snapshot: projectId, directorSessionId, logicalFingerprint, understandingRevision) │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 2. İhtiyaç Tespiti & Karar Üretimi                                                     │
│    DirectorReasoningEngine ──► ParsedDirectorDecision                                  │
│    (decisionType: 'REQUEST_HUMAN_DECISION', question, options, recommendedOption)      │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 3 & 4. IDE Chat Üzerinden Soru ve Seçeneklerin Sunulması                              │
│    Director / Agent Core ──► default_api:ask_question (Native IDE Tool)                │
│    - Parametre: questions: [{ question: "...", options: [...], is_multi_select: false}]│
│    - IDE Davranışı: Ekranda etkileşimli modal açılır; yürütme duraklar (BLOCKING)     │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 5. Kullanıcı Seçimi / Kararı                                                           │
│    Kullanıcı modal pencereden bir seçeneğe tıklar veya açık metin girer ──► [Submit]  │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 6. Cevabın Alınması                                                                    │
│    ask_question tool'u bloklamayı kaldırır ve kullanıcının seçtiği metni döner        │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 7. Eşleştirme ve Mühürleme (Session / Action Binding)                                  │
│    DirectorActionBuilder.buildEnvelope()                                               │
│    - Girdi: snapshot.logicalFingerprint, understandingRevision, userResponse           │
│    - payloadHash: computePayloadHash({ question, userResponse, timestamp })            │
│    - idempotencyKey & actionId deterministik olarak üretilir                           │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 8. Director Karar Değerlendirmesi                                                      │
│    DirectorReasoningEngine kullanıcının kararını reasoning geçmişine ekler             │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 9. AIDM'e Talimat İletimi                                                              │
│    Director ──► aidm_approval_package_approve VEYA director_executeCycle (MCP Tool)   │
│    - Gönderilen veri: authorizationReference (packageId, revision, payloadHash)        │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 10. AIDM Güvenlik ve Yetkilendirme Kapısı                                              │
│     ExecutionBridge Check 6 (PRODUCT_OWNER_APPROVAL) + AuthorizationPolicyEngine       │
│     - Doğrulama: Context fingerprint, revision, mandate limits ve donanım kilidi       │
│     - Başarılı ise: Yürütme DriverEngine / Executor'a devredilir                       │
│     - Başarısız ise: BLOCKED_ON_AUTH_CONTEXT fail-closed olarak kalır                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Director-Only Bütünlüğü ve Senaryo Analizi

| Senaryo | Mimari Kural | Nasıl Sağlanır? |
|---|---|---|
| **AGY doğrudan kullanıcıya soru sorabilir mi?** | **KESİNLİKLE HAYIR.** | `agy` bir alt süreçtir (Executor). AGY'nin kullanıcıya doğrudan soru sormasını engelleyen kural gereği, AGY belirsizlik tespit ettiğinde işlemi `EXECUTION_FAILED` veya `BLOCKED` durumu ve yapılandırılmış hata kanıtıyla (`RawExecutorOutcome`) sonlandırır. Bu kanıt AIDM üzerinden Director'a iletilir; soruyu yalnızca Director sorar. |
| **AIDM doğrudan onay isteyebilir mi?** | **KESİNLİKLE HAYIR.** | AIDM Orchestrator durum makinesini ve yetki kapılarını yönetir. Onay gerektiren bir durum olduğunda (`PENDING_AUTHORIZATION`), AIDM bu durumu `DirectorContextSnapshot` içine yazar. Soru sorma eylemini Director `REQUEST_HUMAN_DECISION` kararı ile üstlenir. |
| **Director birden fazla seçenek sunabilir mi?** | **EVET.** | `ask_question` aracı dinamik bir `options` dizisi alır. Örneğin: `['(Recommended) Devam Et', 'Reddet', 'Açıklama İste', 'Bütçeyi Artır']`. Çoklu seçim gerekiyorsa `is_multi_select: true` yapılır. |
| **Kullanıcı cevabı gelmeden yürütme sürer mi?** | **HAYIR (Fail-Closed).** | `ask_question` çağrıldığında IDE yürütmeyi senkron olarak kilitler. Ayrıca AIDM tarafında `ExecutionBridge` Check 6 onay paketi onaylanana kadar yürütmeyi `BLOCKED_ON_AUTH_CONTEXT` ile kesin olarak engeller. |
| **Kullanıcı gecikirse veya IDE kapanırsa ne olur?** | **GÜVENLİ DURMA.** | `LocalRuntimeStateManager` çalışma kilidi (`local-runtime.json`) aktif kalır. IDE yeniden açıldığında `transcript.jsonl` ve `HistoryManager` üzerindeki olaylar okunur. Bekleyen onay paketi `isStale` veya `expiresAt` aşımına uğramışsa güvenli biçimde yeniden onay istenir. |
| **Eski bir cevap yeni bir action için kullanılabilir mi?** | **HAYIR (Anti-Replay).** | Her onay `contextFingerprint`, `understandingRevision`, `mandateRevision` ve tekil `nonce` alanlarına bağlanır. Eski bir cevabın yeni bir eylemde sunulması `0x80090006` ve `ERR_SESSION_MISMATCH` ile fail-closed reddedilir. |
| **Aynı sorunun iki kez gönderilmesi nasıl önlenir?** | **IDEMPOTENCY KORUMASI.** | `DirectorActionBuilder` deterministik `idempotencyKey` üretir. `DirectorActionDispatcher` (Satır 305-356) aynı anahtarla gelen mükerrer istekleri tespit ederek `ActionDispatchStatus.DUPLICATE` döner ve ekrana ikinci kez modal açılmasını engeller. |

---

## 6. Session ve Cevap Eşleştirme Modeli

Cevapların doğru oturum ve eylemle eşleşmesi için 4 katmanlı bir bağlama modeli uygulanır:

1. **Bağlam Parmak İzi (Logical Context Fingerprint):**  
   Snapshot'ın SHA-256 özütü (`snapshot.logicalFingerprint`). Soru bu parmak izine dayanır. Kod tabanında 1 baytlık değişiklik olsa dahi parmak izi değişir ve eski cevap geçersiz kalır.
2. **Deterministik Action ID:**  
   `computeDeterministicActionId({ projectId, directorSessionId, actionType, idempotencyKey })` formülü ile türetilir.
3. **Senkron Call-Return Kilidi:**  
   `ask_question` asenkron bir mesajlaşma değil, senkron bir araç çağrısıdır. Cevap döndüğünde, çağrıyı yapan fonksiyonun yerel yığınında (local call stack) doğrudan yakalanır.
4. **Değişmez Tarihçe Kaydı:**  
   Alınan karar ve cevap `HistoryManager` içine `DIRECTOR_DECISION_RECORDED` ve `DIRECTOR_ACTION_DISPATCHED` olayları olarak append-only formatında yazılır.

---

## 7. Güvenlik ve Kimlik Doğrulama Sınırları

### 7.1. Kritik Ayrım: Chat Cevabı vs. Kriptografik PO Onayı
Bu denetimin en kritik güvenlik tespiti şudur:

> [!WARNING]
> **IDE Chat Yanıtı Güven Kökü Değildir:**  
> Antigravity IDE'nin `ask_question` modalında bir butona tıklanması veya chat'e metin yazılması, **kullanıcının iradesini (intent) bildirir; ancak bu işlemin yetkili Product Owner tarafından yapıldığını kriptografik olarak kanıtlayamaz**.  
> Çünkü Electron DOM olayları, aynı Windows kullanıcısı altında çalışan kötü niyetli bir yazılım tarafından `UIAutomation`, `SendInput` veya bellek manipülasyonu ile tetiklenebilir.

### 7.2. TRUST-ROOT-04 Out-of-Band Önerisinin Gerçeklik Denetimi
[TRUST-ROOT-04](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/TRUST-ROOT-04-SECURE-COMPANION-THREAT-MODEL.md) raporunda Alternatif 4 olarak tartışılan "ChatGPT Web/Mobil Oturumu Üzerinden Kriptografik İmzalı Jeton Üretimi" yaklaşımı mevcut resmi API'ler ışığında denetlenmiştir:

- **Mevcut API Gerçeği:** OpenAI ChatGPT platformu veya API'si, son kullanıcının mobil/web oturumunda tıkladığı bir buton için geliştiricinin yerel makinesine özel bir asimetrik anahtarla imzalanmış **"Hardware/PKI Human Consent Token" üreten genel bir API sunmamaktadır**.
- **Sonuç:** ChatGPT oturumunun doğrudan kriptografik imza üreteceği varsayımı **mevcut ticari altyapıda DESTEKLENMEMEKTEDİR (NOT_SUPPORTED)**.

### 7.3. Gerçekçi Güven Kökü Mimarisi
Güvenli model şu şekilde kurulmalıdır:
1. **İrade Beyanı (Presentation & Consent):** Antigravity IDE chat / modal arayüzü (`ask_question`) üzerinden kullanıcıya işlem detayları (Bütçe, TaskId, Kanonik Hash) açıkça gösterilir ve onay alınır (WYSIWYS sağlanır).
2. **Kriptografik Donanım Kilidi (Hardware Gatekeeper):** Kullanıcı "Onayla" dedikten sonra, bu onay özütü yerel makinedeki **TPM 2.0 Strong Key (`MS_PLATFORM_KEY_STORAGE_PROVIDER`)** donanımına gönderilir.
3. **Sessiz İmza Engeli:** Windows CNG çekirdeği `NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG` sayesinde arka planda izinsiz imza atılmasını `0x80090022` ile engeller.
4. **Sonuç:** Böylece hem kullanıcının neyi onayladığını görmesi (IDE Chat WYSIWYS) hem de arka plandan sahte imza atılamaması (TPM 2.0 Hardware Lock) bir arada sağlanır.

---

## 8. Mimari Alternatiflerin Karşılaştırması

Antigravity IDE içinde Director etkileşimi için 3 resmi seçenek karşılaştırılmıştır:

| Kriter | Seçenek A: Native `ask_question` Modal (Önerilen) | Seçenek B: VS Code Extension Chat Participant | Seçenek C: Artifact Review (`RequestFeedback`) |
|---|---|---|---|
| **Resmi Destek Durumu** | **VERIFIED (Aktif Ortamda Mevcut)** | PARTIALLY_VERIFIED (VS Code API) | VERIFIED (Artifact Sistemi) |
| **Kullanıcı Deneyimi** | Etkileşimli Modal Dialog (Tekil/Çoklu Seçim + Yazı) | Sidebar Chat Botu (`@director`) | Doküman üstünde "Proceed" Butonu |
| **Director-Only Uyumu** | **%100 Tam Uyum** | Tam Uyum | Kısmi (Yalnızca doküman onayı için) |
| **Seçenekli Soru Desteği** | **Mükemmel (`options` dizisi)** | Metin tabanlı | Yok (Sadece Proceed/Skip) |
| **Engelleme (Blocking)** | **Tam Senkron Bloklama** | Asenkron stream | Asenkron durum bekleme |
| **OtonomMCP'ye Etkisi** | **Sıfır Yeni Bağımlılık (Hazır Araç)** | Yeni `.vsix` paketi yazılmalı | Yalnızca Markdown çıktıları için |
| **Uygulama Karmaşıklığı** | **Çok Düşük** | Yüksek | Düşük |
| **Bakım Maliyeti** | **Çok Düşük** | Yüksek | Düşük |

**Seçenek Değerlendirmesi:** **Seçenek A (`default_api:ask_question`)**, hiçbir ek VS Code extension'ı veya harici GUI yazılımı gerektirmeden OtonomMCP'nin tüm ihtiyaçlarını eksiksiz karşılayan en kararlı ve resmi yoldur.

---

## 9. Mevcut OtonomMCP Mimarisine Etkisi

Mevcut OtonomMCP bileşenleri incelenmiş; hiçbir yeni DAG motoruna, yeni Driver'a veya yeni durum yöneticisine ihtiyaç olmadığı doğrulanmıştır:

1. **[DirectorReasoningEngine](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director-reasoning/director-reasoning-engine.ts):**  
   Mevcut karar motoru `REQUEST_HUMAN_DECISION` kararını üretir. Bu kararın içeriği (`question`, `options`, `recommendedOption`) doğrudan `ask_question` parametrelerine beslenir.
2. **[DirectorActionBuilder](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director-action/director-action-builder.ts):**  
   Kullanıcı yanıtını alıp deterministik `DirectorActionEnvelope` oluşturur.
3. **[DirectorActionDispatcher](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director-action/director-action-dispatcher.ts):**  
   Mevcut dağıtıcı, `REQUEST_HUMAN_DECISION` eylemini `PENDING_AUTHORIZATION` kodu ile güvenli şekilde bekletir (Satır 434-447).
4. **[DirectorContextSnapshot](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/director/director-context-types.ts):**  
   Snapshot'ın `logicalFingerprint` değeri soruya gömülür.
5. **[MCP Server Katmanı](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/mcp/mcp-server.ts):**  
   [`clarification-tools.ts`](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/mcp/tools/clarification-tools.ts) ve [`approval-tools.ts`](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/mcp/tools/approval-tools.ts) araçları halihazırda mevcuttur; kullanıcı cevabı bu araçlar üzerinden AIDM durumuna yazılır.
6. **[ExecutionBridge](file:///d:/%C3%87ALI%C5%9EMALAR-D/OtonomMCP/packages/core/src/execution-bridge/execution-bridge.ts):**  
   Check 6 kapısı korunur; onay imzası tamamlanmadan yürütme başlamaz.

---

## 10. Desteklenmeyen veya Bilinmeyen Yetenekler (Unknowns / Unsupported)

- **Headless Chat Injection (NOT_SUPPORTED):** IDE dışındaki rastgele bir OS sürecinin IDE chat ekranına doğrudan mesaj basması desteklenmemektedir.
- **ChatGPT Cloud PKI Signature (NOT_SUPPORTED):** ChatGPT web oturumunun doğrudan donanım düzeyinde imzalı token üretmesi OpenAI platformunda desteklenmemektedir.
- **Unsolicited MCP Chat Banners (NOT_SUPPORTED):** MCP sunucusunun stdio üzerinden kullanıcının sohbet akışına habersiz etkileşimli banner basması desteklenmemektedir.
- **Süreç İçi Bellek Koruması (UNKNOWN / OS LIMITATION):** Aynı Windows kullanıcısındaki diğer süreçlerin Electron DOM belleğini okuyup okuyamayacağı işletim sistemi DAC sınırlarına bağlıdır; yazılımla engellenemez.

---

## 11. Teknik Riskler

1. **Modal Zaman Aşımı Riski:** Kullanıcı ekrana gelen `ask_question` modalına saatlerce yanıt vermezse ajan turu askıda kalabilir. Bu durum için bir TTL ve iptal (timeout/abort) mekanizması tanımlanmalıdır.
2. **Kullanıcı Tarafından İptal (Skip/Escape):** Kullanıcı modalı yanıtsız kapatırsa (`Skip`), sistem fail-closed davranmalı ve işlemi reddedilmiş saymalıdır.
3. **Model Yanıltması (Prompt Injection):** Eğer soru içeriği kötü niyetli bir kaynak dosyadan geliyorsa, kullanıcı yanıltıcı bir soruyla onay vermeye zorlanabilir. Bu nedenle onaylanan yükün kanonik özütü (SHA-256) modala açıkça yazılmalıdır.

---

## 12. GO / CONDITIONAL GO / NO-GO Kararı

| Alan | Karar | Gerekçe |
|---|:---:|---|
| **Antigravity IDE İçi Director Etkileşimi (`ask_question` Tabanlı)** | **ŞARTLI GO** | Resmi `default_api:ask_question` aracı ile %100 uygulanabilirdir. İkinci bir GUI veya companion gerektirmez. |
| **Harici Headless Chat Push Sunucusu Geliştirilmesi** | **KESİN NO-GO** | IDE'de resmi bir headless push API'si yoktur; kırılgan tersine mühendislik gerektirir. |
| **Ayrı Bir Web / Masaüstü Chat Arayüzü Oluşturulması** | **KESİN NO-GO** | Director-only bağlayıcı kuralına aykırıdır; sistemi iki başlı hale getirir. |
| **P20 Check 6 Güvenlik Kapısının Gevşetilmesi** | **KESİN NO-GO** | Chat cevabı tek başına güven kökü olamaz; donanım kilidi olmadan kapı açılamaz. |

---

## 13. TRUST-ROOT-05 İçin Gerekli Kararlar ve Kabul Kriterleri

Sıradaki mimari karar görevi olan **TRUST-ROOT-05** için bu rapordan çıkan bağlayıcı girdiler şunlardır:

1. **Kullanıcı Arayüzü Kararı Kesinleşti:**  
   Kullanıcı ile etkileşim yeri **Antigravity IDE Sohbeti (`ask_question`)** olacaktır. Harici bir Companion UI yazılmayacaktır.
2. **Güven Kökü Entegrasyon Modeli:**  
   Kullanıcı `ask_question` ile onay verdiğinde, bu onay metni ve snapshot özütü yerel TPM 2.0 anahtarı ile mühürlenecektir.
3. **Zorunlu Kabul Kriterleri:**  
   - `ask_question` seçenekleri deterministik olmalıdır.
   - Kullanıcı reddettiğinde veya modal kapatıldığında `NTE_USER_CANCELLED` benzeri fail-closed dönüş yapılmalıdır.
   - İmzalanan yük ile `ExecutionBridge`'e giren yükün SHA-256 hash'i birebir aynı olmalıdır (WYSIWYS).
   - Hiçbir koşulda `verified: true` istemci beyanı tek başına yeterli sayılmayacaktır.

---

## 14. Sonuç ve Sonraki Adım

Antigravity IDE içinde "Director-only" kullanıcı etkileşimi resmi `ask_question` aracı ile **teknik olarak tamamen uygulanabilir** bulunmuştur.

👉 **Sıradaki Bağlayıcı Görev:** **`TRUST-ROOT-05 — Human Approval Root-of-Trust Decision & Isolated Validation`**  
Bu aşamada TRUST-ROOT-04 ve DIRECTOR-INTERACTION-01 bulguları birleştirilerek, TPM 2.0 donanım anahtarı ile IDE `ask_question` onay akışının izole doğrulama tasarımı tamamlanacaktır.
