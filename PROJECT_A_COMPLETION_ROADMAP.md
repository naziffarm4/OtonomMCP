# Proje A — Kesin Tamamlama Yol Haritası (PROJECT_A_COMPLETION_ROADMAP)

**Proje:** OtonomMCP / AIDM (Proje A)  
**Tarih:** 2026-10-04  
**Hedef:** Proje B (Bağımsız Onay Sistemi) geliştirilmesine başlamadan önce, mevcut AIDM çekirdeğini güvenli sınırlar içinde çalışan, rutin işleri otonom yürütebilen, onay gerektiren işlerde fail-closed bekleyen eksiksiz bir orkestratör haline getirmek.

---

## 1. Kritik Yol ve Bağımlılık Sıralaması Gerekçesi

Proje A'nın aşamaları rastgele seçilmemiş; kod bağımlılıkları ve mimari önkoşullar doğrultusunda kesinleştirilmiştir:

```
[A1: Denetim & Kabul] ──► [A2: Reasoning Runtime] ──► [A3: Action & Policy Bütünlüğü]
                                                                  │
                                                                  ▼
[A6: Durable Session & Recovery] ◄── [A5: MCP Control Plane] ◄── [A4: Closed-loop Coordinator]
             │
             ▼
[A7: Gerçek Uçtan Uca Doğrulama] ──► [A8: Production Hardening & A Kabulü]
```

**Sıralama Gerekçeleri:**
1. **A1 (Denetim):** Neyin gerçekten çalıştığını (P18-03, P19, P21) ve neyin eksik olduğunu bilmeden kod yazılmasını engeller.
2. **A2 (Reasoning Runtime):** Karar verici motorun bütçe ve sağlayıcı bağlantısının kesinleşmesi gerekir; aksi halde A4 kapalı döngüsünde neyin yürütüleceği bilinemez.
3. **A3 (Action & Policy):** A2 çıktısının zarflanması (envelope) ve mandate politikasıyla doğrulanması A4'ün güvenli giriş kapısıdır.
4. **A4 (Closed-loop Coordinator):** ExecutionBridge, Driver, EvidenceCollector ve StateIntegrator tek bir kapalı döngüde birleşmeden dışarıya bir kontrol yüzeyi (A5) sunulamaz.
5. **A5 (Director MCP Control Plane - Resmî P22):** Kapalı döngü hazır olduktan sonra Director'ın çağıracağı üst düzey MCP araçları (`aidm.director.*`) açılır.
6. **A6 (Durable Session & Recovery):** Oturum yaşam döngüsü ve kilitlenme güvenliği, A7 uçtan uca testlerinden önce tamamlanmalıdır ki kesinti testleri yapılabilsin.
7. **A7 (Gerçek E2E):** Tüm bileşenlerin birleşik entegrasyon doğrulaması.
8. **A8 (Hardening & Kabul):** Güvenlik, secret saklama ve nihai kabul.

---

## 2. Aşama Aşama Kesin Yol Haritası

### A1 — Mevcut Durum ve Kabul Denetimi
- **Mevcut Durum:** `DONE`. Repodaki tüm mimari bileşenler, Git durumu, 8 TRUST-ROOT raporu, 2 etkileşim raporu ve mevcut testler denetlenmiştir.
- **Eksik İşler:** Yok (Denetim tamamlandı, belgeler oluşturuldu).
- **Bağımlılıklar:** Yok.
- **Gerekli Dosyalar:** `A_CURRENT_STATE_AUDIT.md`, `PROJECT_A_COMPLETION_ROADMAP.md`, `PROJECT_B_INDEPENDENT_APPROVAL_ROADMAP.md`, `A_B_INTEGRATION_CONTRACT.md`.
- **Test ve Doğrulama:** Git komutları, mevcut testlerin çalıştırılması (`node --test`).
- **Açık Riskler:** Yok.
- **Kabul Kriteri:** Kod değiştirilmeden mevcut durumun kanıtlarla ortaya konması, P22 isim çakışmasının çözülmesi.

---

### A2 — Director Reasoning Runtime'ın Tamamlanması
- **Mevcut Durum:** `PARTIAL`. `director-reasoning-engine.ts`, `director-prompt-builder.ts`, `http-llm-transport.ts` ve `budget-manager.ts` yazılmış ve 63+18+53 testle doğrulanmıştır. Ancak canlı harici LLM sağlayıcısı (OpenAI API) ile gerçek ağ çağrısı henüz yapılmamıştır.
- **Eksik İşler:** 
  1. Gerçek sağlayıcı kimlik bilgisi (API Key) enjeksiyon sözleşmesinin doğrulanması (kaynak kodda/git'te tutulmadan çevre değişkeni üzerinden).
  2. Kullanıcının açık onayı ile tek bir canlı, ücretli provider çağrısı (smoke test) yapılması veya kullanıcı onayı yoksa bu durumun `NOT_VERIFIED_IN_PROD` olarak resmîleştirilmesi.
  3. Bütçe hold/settlement hattının canlı API yanıt meta-verisi (usage token) ile uyumunun kesinleştirilmesi.
- **Bağımlılıklar:** A1.
- **Gerekli Bileşenler/Dosyalar:**
  - `packages/core/src/director-reasoning/director-reasoning-engine.ts`
  - `packages/core/src/llm-bridge/http-llm-transport.ts`
  - `packages/core/src/budget/budget-manager.ts`
  - `packages/core/src/budget/budget-reservation-engine.ts`
- **Test ve Doğrulama:** 
  - `tests/director-reasoning.test.ts`
  - `tests/http-llm-transport.test.ts`
  - `tests/budget-llm-integration.test.ts`
  - İzinli Canlı Provider Smoke Testi (isteğe bağlı/opt-in).
- **Açık Riskler:** Gerçek sağlayıcı API format değişiklikleri, token hesaplama farklılıkları.
- **Kabul Kriteri:** Canlı provider entegrasyonu izinli testle kanıtlanmalı; kullanıcı açık izin vermezse mock/fixture testlerinin gerçek test yerine geçmediği açıkça belgelenmelidir.

---

### A3 — Director Action Protocol ve Authorization Policy Bütünlüğü
- **Mevcut Durum:** `DONE`. P19 (Action protocol/dispatcher) ve P21 (Authorization policy/mandate) tamamlanmış ve 48+25 testle kabul edilmiştir.
- **Eksik İşler:**
  1. A2'den çıkan Director yanıtlarının doğrudan `DirectorActionBuilder`'a beslenerek Zod ve policy doğrulamasına girmesinin tekil entegrasyon hattı olarak kilitlenmesi.
  2. Mandate kapsamında rutin eylemlerin (`ALLOW`) ve insan onayı gerektiren eylemlerin (`REQUIRE_HUMAN_APPROVAL`) fail-closed davranışının korunması.
- **Bağımlılıklar:** A1, A2.
- **Gerekli Bileşenler/Dosyalar:**
  - `packages/core/src/director-action/director-action-pipeline.ts`
  - `packages/core/src/director-action/director-action-dispatcher.ts`
  - `packages/core/src/authorization/authorization-policy-engine.ts`
  - `packages/core/src/authorization/project-mandate-store.ts`
- **Test ve Doğrulama:**
  - `tests/director-action-protocol.test.ts`
  - `tests/p19-02-director-action-pipeline.test.ts`
  - `tests/p21-authorization-policy.test.ts`
- **Açık Riskler:** Stale context veya revizyon uyumsuzluğu durumunda sessizce işlem yapılması (mevcut testlerle engellenmiştir).
- **Kabul Kriteri:** Yetkisiz veya eski bağlama dayanan her eylem AIDM tarafından fail-closed reddedilmeli; istemci payload'ındaki sahte onaylar asla kabul edilmemelidir.

---

### A4 — Closed-loop Coordinator
- **Mevcut Durum:** `PARTIAL`. `ExecutionBridge` (P20-01), `DriverEngine`, `DirectorLoopEngine` ve `EvidenceCollector` ayrı ayrı mevcuttur ve test edilmiştir. Ancak bunların tek bir kesintisiz döngüde birbirini tetiklemesi (`Director Loop -> Action -> Bridge -> Driver -> AGY -> Evidence -> Verification -> Loop Context Refresh`) tam olarak birleştirilmelidir.
- **Eksik İşler:**
  1. `ExecutionBridge`'in Driver'ı tetiklemesi ve `DriverRuntime` tamamlandığında `EvidenceCollector` ile bağımsız doğrulama yapması.
  2. AGY'nin sözel başarı beyanının tek başına kabul edilmeyip bağımsız dosya/git kanıtıyla doğrulanması.
  3. Doğrulama başarısız olursa veya AGY timeout verirse döngünün güvenli biçimde `EXECUTION_UNKNOWN` / `FAILED` durumuna geçmesi ve Director'a düzeltici görev oluşturma seçeneği sunması.
  4. İnsan onayı bekleyen adımlarda döngünün `WAITING_FOR_APPROVAL` durumunda fail-closed duraklaması.
- **Bağımlılıklar:** A2, A3.
- **Gerekli Bileşenler/Dosyalar:**
  - `packages/core/src/execution-bridge/execution-bridge.ts`
  - `packages/core/src/driver/driver-engine.ts`
  - `packages/core/src/driver/driver-runtime.ts`
  - `packages/core/src/director-loop/director-loop-engine.ts`
  - `packages/core/src/evidence/evidence-collector.ts`
- **Test ve Doğrulama:**
  - `tests/p20-01-execution-bridge.test.ts`
  - `tests/autonomous-driver.test.ts`
  - `tests/director-executor-loop.test.ts`
  - Yeni birleşik kapalı döngü koordinasyon testi.
- **Açık Riskler:** Sonsuz düzeltme döngüsü, AGY'nin takılı kalması, TOCTOU.
- **Kabul Kriteri:** Rutin bir görev AGY'ye gönderilebilmeli, çıktısı bağımsız doğrulanabilmeli ve başarısızlık halinde sınırlı (bounded) düzeltme döngüsü güvenle çalışmalıdır. İnsan onayı gerektiren işler fail-closed beklemelidir.

---

### A5 — Director MCP Control Plane (Resmî P22)
- **Mevcut Durum:** `PARTIAL`. MCP server ve alt seviye araçlar mevcuttur (`packages/core/src/mcp/tools/*`). Ancak Director'ın kullanacağı yüksek seviyeli kontrol sözleşmesi resmî P22 hedefine göre finalize edilmelidir.
- **Eksik İşler:**
  1. Director odaklı yüksek seviye araçların resmi sözleşmesi:
     - `aidm_director_open` (veya `aidm.director.open`)
     - `aidm_director_context`
     - `aidm_director_act`
     - `aidm_director_cycle`
     - `aidm_director_result`
     - `aidm_director_status`
     - `aidm_director_decisions`
     - `aidm_director_resolve`
     - `aidm_director_pause`
     - `aidm_director_resume`
     - `aidm_director_stop`
  2. Bu araçların Zod şemalarının ve stdio JSON-RPC taşımasının doğrulanması.
  3. Sınırsız shell erişimi verilmemesi; tüm çağrıların session ve mandate yetkisine tabi tutulması.
- **Bağımlılıklar:** A4.
- **Gerekli Bileşenler/Dosyalar:**
  - `packages/core/src/mcp/mcp-server.ts`
  - `packages/core/src/mcp/tools/director-session-tools.ts`
  - `packages/core/src/mcp/tools/director-loop-tools.ts`
  - `packages/core/src/mcp/tools/driver-tools.ts`
- **Test ve Doğrulama:**
  - `tests/mcp-server-foundation.test.ts`
  - `tests/p18-01-mcp-real-bootstrap.test.ts`
  - Yeni MCP Control Plane sözleşme ve yetki testleri.
- **Açık Riskler:** Araç adlarının Antigravity veya istemci kısıtlarıyla çakışması.
- **Kabul Kriteri:** Director, AIDM'yi tanımlı MCP sözleşmesi üzerinden başlatabilmeli, durumunu sorgulayabilmeli ve döngüyü kontrol edebilmelidir.

---

### A6 — Durable Session ve Recovery (Resmî P23)
- **Mevcut Durum:** `PARTIAL`. `HistoryManager`, `DurableStateManager` ve `.ai-manager/runtime.lock` mevcuttur.
- **Eksik İşler:**
  1. Süreç kesintisi veya sistem çökmesi sonrası yeniden başlatıldığında, yarım kalmış (in-flight) AGY eylemlerinin tespit edilmesi ve `EXECUTION_UNKNOWN` olarak işaretlenmesi.
  2. Kesintiye uğrayan işin körlemesine yeniden çalıştırılmaması; durumun Director'a bildirilmesi.
  3. Tekil instance kilidinin (`runtime.lock`) çökme sonrası güvenli temizlenme kurallarının doğrulanması (zombie takeover yapılmadan).
- **Bağımlılıklar:** A4, A5.
- **Gerekli Bileşenler/Dosyalar:**
  - `packages/core/src/storage/durable-state.ts`
  - `packages/core/src/storage/runtime-state.ts`
  - `packages/core/src/storage/history-manager.ts`
  - `packages/core/src/recovery/recovery-engine.ts`
- **Test ve Doğrulama:**
  - `tests/storage.test.ts`
  - `tests/recovery.test.ts`
  - Simüle edilmiş crash/restart kurtarma testleri.
- **Açık Riskler:** Kilit dosyasının takılı kalması, mükerrer yürütme riski.
- **Kabul Kriteri:** Sistem yeniden başlatıldığında önceki oturumu tanımalı, yarım kalan işleri körlemesine tekrarlamamalı ve durum bütünlüğünü korumalıdır.

---

### A7 — Gerçek Uçtan Uca Doğrulama (Resmî P24)
- **Mevcut Durum:** `NOT STARTED`.
- **Eksik İşler:**
  Aşağıdaki senaryoların gerçek ortamda adım adım koordine edilerek test edilmesi:
  1. Rutin ve yetkilendirilmiş bir geliştirme görevinin başarıyla tamamlanması.
  2. Başarısız görev ve kontrollü düzeltme döngüsü.
  3. AGY süre aşımı (timeout) ve bilinmeyen durum uzlaştırması.
  4. Stale context / revizyon uyuşmazlığında fail-closed duruş.
  5. İnsan onayı gerektiren bir eylemde sistemin fail-closed olarak `WAITING_FOR_APPROVAL` durumuna geçmesi ve yetkisiz ilerlememesi.
  6. Süreç kapanması ve recovery döngüsü.
- **Bağımlılıklar:** A1–A6.
- **Gerekli Bileşenler/Dosyalar:**
  - Entegre test harness ve CLI/MCP test istemcisi.
- **Test ve Doğrulama:**
  - Gerçek çalışma akışı senaryo testleri.
- **Açık Riskler:** Harici bileşen gecikmeleri, ortam uyumsuzlukları.
- **Kabul Kriteri:** Senaryoların beklenen güvenli duruşları ve bağımsız kanıtları raporda somut olarak gösterilmelidir.

---

### A8 — Production Hardening ve A Kabulü (Resmî P25)
- **Mevcut Durum:** `NOT STARTED`.
- **Eksik İşler:**
  1. Dosya yolu ve komut kapsamı kısıtlamalarının (path traversal koruması) son denetimi.
  2. Secret ve API anahtarlarının loglara veya disk dosyalarına sızmadığının doğrulanması.
  3. Windows ortamı için çalıştırma ve operasyon kılavuzunun hazırlanması.
  4. Proje A kabul raporunun hazırlanması.
- **Bağımlılıklar:** A1–A7.
- **Gerekli Bileşenler/Dosyalar:**
  - Operasyon ve kurulum dokümantasyonu, CLI giriş noktası.
- **Test ve Doğrulama:**
  - Tam test paketinin regresyonsuz çalıştırılması (`npm test`).
- **Açık Riskler:** Yok.
- **Kabul Kriteri:** Tüm kabul kriterleri karşılanmış olmalı, Proje A kullanıcının tek Windows bilgisayarında kararlı ve güvenli çalışmalıdır.

---

## 3. Nihai Kabul Kuralı

> [!IMPORTANT]
> **Proje A kabul edilmeden Proje B'nin uygulama geliştirmesine kesinlikle başlanamaz.**  
> Proje A, bağımsız onay uygulaması (B) olmadan da rutin ve yetkilendirilmiş görevleri otonom yürütebilmeli; gerçek insan onayı gereken durumlarda ise güvenli biçimde beklemelidir (`FAIL-CLOSED`).
