# A2 — Director Reasoning Runtime Tamamlama ve Sağlayıcı Entegrasyonu Raporu

**Proje:** OtonomMCP (Proje A)  
**Tarih:** 2026-10-04  
**Durum:** TAMAMLANDI (Teknik Hazırlık Doğrulandı / Canlı Çağrı: `NOT_VERIFIED_IN_PROD`)  
**İlgili Modüller:** `packages/core/src/director-reasoning`, `packages/core/src/llm-bridge`, `packages/core/src/budget`

---

## 1. İncelenen Mevcut Mimari

Görev kapsamında aşağıdaki temel bileşenler satır satır ve mimari bütünlük açısından incelenmiştir:

1. **`director-reasoning-engine.ts`**:
   - `DirectorReasoningEngine` orkestrasyon motoru; snapshot snapshot doğrulaması, correlation ID üretimi, prompt oluşturma, LLM çağrısı, AbortSignal/timeout denetimi ve yanıt ayrıştırma akışını yürütür.
   - P18-02 güvenlik ve fail-closed kurallarını uygular; production modunda `BudgetAwareLlmAdapter` sarmalaması, `TransportSecurityRegistry` kontrolü ve `DirectorDecisionEngine` doğrulaması zorunludur.
2. **`director-prompt-builder.ts`**:
   - `DirectorContextSnapshot` verisini sistem kuralları ve `<project_context>` blokları ile yapılandırılmış prompt'a dönüştürür.
   - P0 kontekstini (authorization, approval, clarification, active task) korur; P1-P4 kontekstini deterministik bütçe sınırları (`maxRequirements`, `maxDecisions`, `maxTasks`, `maxFieldLength`, `hardMaxPromptTokens`) dahilinde budar (`pruning`).
3. **`director-response-parser.ts`**:
   - Model çıktısını JSON nesnesine ayrıştırır (saf JSON veya markdown code fence).
   - Yetki yükseltme (authority escalation) girişimlerini (`actor: USER`, `hasImplementationAuthority: true`, sahte PO onayı) Zod şemasından önce engelleyerek fail-closed davranır.
   - `DirectorDecisionContractZodSchema` ile strict şema doğrulaması ve `logicalFingerprint` tazelik denetimi yapar.
4. **`http-llm-transport.ts`**:
   - Native Node.js 18+ `fetch` kullanan sıfır bağımlılıklı production HTTP taşıyıcısıdır.
   - P18-03 bütçe doğrulamasını (`x-budget-reservation-id`, `claimReservationForDispatch`) atomik olarak zorunlu kılar.
   - Secret sanitization (`sanitizeSecrets`, `sanitizeSecretsInObject`), deterministik timeout/AbortSignal ve HTTP durum kodu eşlemesi içerir.
5. **`base-llm-adapter.ts`**, **`reference-llm-adapter.ts`**, **`secondary-llm-adapter.ts`**:
   - `LLMProvider` sözleşmesini uygulayan sağlayıcı adaptör katmanıdır.
   - `ReferenceLlmAdapter`, OpenAI referans protokolünü ve genel wire formatını izole eder.
6. **`transport-security-registry.ts`**:
   - Module-private `WeakSet` ve unforgeable `Symbol('AIDM_TRANSPORT_INTEGRITY_BRAND')` ile sahte mock taşıyıcıların production moduna sızmasını ve nesne tahrifatını engeller.
7. **`budget-manager.ts`**, **`budget-reservation-engine.ts`**, **`reconciliation-engine.ts`**:
   - P18-03 SQLite tabanlı atomik rezervasyon, settlement, rollback ve `LIMIT_OVERRUN` maliyet kontrolü altyapısıdır.

---

## 2. Mevcut Kodda Tespit Edilen Eksiklikler

Yapılan teknik inceleme sonucunda gerçek bir LLM sağlayıcısına (özellikle OpenAI Chat Completions API) bağlanırken ortaya çıkacak şu somut eksiklikler tespit edilmiştir:

1. **Wire Payload Uyuşmazlığı (HTTP 400 Riski)**:
   - `ReferenceLlmAdapter.translateToWire`, kök JSON gövdesine `director_context`, `project_id`, `task_id`, `correlation_id` ve `metadata` alanlarını eklemekteydi.
   - Gerçek OpenAI `https://api.openai.com/v1/chat/completions` uç noktası bilinmeyen üst düzey parametreler içeren isteklere HTTP `400 Bad Request` ("Extra inputs are not permitted") yanıtı dönmektedir.
   - `temperature: null` ve `max_tokens: null` değerleri gönderildiğinde OpenAI şema doğrulayıcısı `null is not of type 'number'` hatası vermektedir.
   - Yapılandırılmış çıktılar (`json_schema`) için OpenAI, `{ type: 'json_schema', json_schema: { name, strict, schema } }` hiyerarşisini beklerken, önceki referans formatı düz `{ type: 'json_schema', schema, schema_name }` yapısındaydı.
2. **Provider Usage Metaverisi & Cached/Reasoning Token Eksikliği**:
   - Gerçek OpenAI yanıtlarında önbelleğe alınan girdiler `usage.prompt_tokens_details.cached_tokens`, muhakeme token'ları ise `usage.completion_tokens_details.reasoning_tokens` altında dönmektedir.
   - Önceki `ReferenceLlmAdapter.normalizeWireResponse` yalnızca düz `wire.usage.cached_tokens` alanını okumaktaydı; bu nedenle OpenAI'ın önbellek indirimi telemetry'de `null` kalıyor ve reconciliation motoru sub-cent indirimini kaçırıyordu.
   - Reasoning token metaverisi normalize edilen telemetri nesnesine aktarılmıyordu.
3. **Environment Uç Nokta ve Model Varsayılanları**:
   - `DirectorReasoningEngine`, `process.env.OPENAI_API_KEY` tanımlı olduğunda `config.endpoint` belirtilmemişse uç noktayı `undefined` bırakıyor, bu da doğrudan `MISSING_ENDPOINT` hatasına yol açıyordu.
   - OpenAI uç noktasına bağlanıldığında geçerli bir model adı (örn. `gpt-4o` veya `o3-mini`) yerine var olmayan `director-reasoning-v1` varsayılan kalıyordu.

---

## 3. Yapılan Değişiklikler ve Gerekçeleri

Mevcut çalışan kod ve P18-03 bütçe mimarisi korunarak, yalnızca eksik olan sağlayıcı entegrasyonu noktalarında cerrahi düzenlemeler yapılmıştır:

### A. `packages/core/src/llm-bridge/reference-llm-adapter.ts`
- **`ReferenceWireUsage` Genişletildi**:
  - `prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number }`
  - `completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number }` alanları tip tanımına eklendi.
- **OpenAI Wire Format Desteği (`isOpenAiFormat` & `translateToOpenAiWire`)**:
  - `wireFormat: 'reference' | 'openai' | 'auto'` konfigürasyon seçeneği eklendi.
  - Hedef uç nokta `openai.com` içerdiğinde veya sağlayıcı adı OpenAI olduğunda otomatik olarak temiz OpenAI Chat Completions gövdesi oluşturulur:
    - Kök seviyedeki orkestrasyon metaverileri gövdeden çıkarıldı; bu bilgiler HTTP başlıklarında (`x-correlation-id`, `x-project-id`, `x-budget-reservation-id`, `x-budget-provider-id`, `x-budget-model-id`) güvenle iletilir.
    - `temperature` ve `max_tokens` alanları tanımsız/null ise gövdeye eklenmez.
    - `response_format`, standart OpenAI `{ type: 'json_schema', json_schema: { name, strict, schema } }` formatına dönüştürülür.
    - Mevcut testlerin beklediği dahili referans formatı geriye dönük %100 uyumlulukla korundu.
- **Kapsamlı Token Telemetrisi Normalizasyonu**:
  - `normalizeWireResponse` içinde `cachedTokens`, `wire.usage.cached_tokens ?? wire.usage.prompt_tokens_details?.cached_tokens ?? null` şeklinde çözümlenir.
  - `completion_tokens_details` ve `prompt_tokens_details` nesneleri `usage` üzerine taşınarak `BudgetAwareLlmAdapter` uzlaştırma motorunun muhakeme token'larını hesaba katması sağlandı.

### B. `packages/core/src/director-reasoning/director-reasoning-engine.ts`
- **Akıllı Sağlayıcı ve Uç Nokta Çözümlemesi**:
  - `OPENAI_API_KEY` veya `config.apiKey` mevcut olduğunda ve açık uç nokta verilmemişse, `defaultEndpoint` otomatik olarak `https://api.openai.com/v1/chat/completions` olarak atanır.
  - Model seçimi hiyerarşik olarak `config.model ?? process.env.AIDM_LLM_MODEL ?? process.env.OPENAI_MODEL ?? (defaultEndpoint.includes('openai.com') ? 'gpt-4o' : 'director-reasoning-v1')` şeklinde çözümlenir.
  - OpenAI uç noktasına bağlanıldığında `ReferenceLlmAdapter` otomatik olarak `wireFormat: 'openai'` modunda başlatılır.

---

## 4. Gerçek Sağlayıcı Entegrasyonunun Teknik Durumu

Aşağıdaki 10 teknik kriter incelenmiş ve doğrulanmıştır:

| # | Teknik Kriter | Durum | Teknik Kanıt |
|---|---|---|---|
| 1 | Gerçek sağlayıcı uç nokta ve HTTP istek formatı | **DOĞRULANDI** | OpenAI Chat Completions şemasına tam uyumlu; gövde kirletilmez, başlıklar taşınır (`A2-01` testi). |
| 2 | Güvenli API anahtarı enjeksiyonu | **DOĞRULANDI** | `apiKey` private saklanır, yalnızca giden `Authorization: Bearer <token>` başlığına eklenir. |
| 3 | Secret sızma koruması | **DOĞRULANDI** | URL'ler, başlıklar, hata gövdeleri `sanitizeSecrets` ve `sanitizeSecretsInObject` ile temizlenir (`A2-04` testi). |
| 4 | Timeout ve AbortSignal kontrolü | **DOĞRULANDI** | AbortController ve `setTimeout` yarışı ile `LlmTimeoutError` üretilir (`A2-05` testi). |
| 5 | HTTP hata kodlarının sınıflandırılması | **DOĞRULANDI** | 400, 401, 403, 408, 429, 500, 502, 503, 504 kodları açıklayıcı hata sınıflarına dönüştürülür. |
| 6 | Geçersiz JSON ve beklenmeyen yanıtlar | **DOĞRULANDI** | 200 OK altında dönen HTML veya bozuk JSON doğrudan `MalformedLlmResponseError` fırlatır (`A2-06` testi). |
| 7 | Provider usage metaverisi ayrıştırma | **DOĞRULANDI** | `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` eksiksiz ayrıştırılır (`A2-02` testi). |
| 8 | Bütçe sistemine token aktarımı | **DOĞRULANDI** | Önbellek indirimi ve muhakeme token'ları `BudgetManager.settle` motoruna tam aktarılır (`A2-03` testi). |
| 9 | Director karar şeması doğrulaması | **DOĞRULANDI** | `DirectorResponseParser` ve `DirectorDecisionContractZodSchema` yetki yükseltmeyi ve şema dışı alanları reddeder (`A2-07` testi). |
| 10 | Fail-closed davranış | **DOĞRULANDI** | Sağlayıcı ulaşılamadığında veya kimlik bilgisi eksik olduğunda sahte yanıt üretilmez, işlem durdurulur (`A2-09` testi). |

---

## 5. API Anahtarı ve Secret Güvenliği

1. **Bellek İzolasyonu**: API anahtarları nesne durumunda private alanda saklanır; serileştirilmez, diske kaydedilmez.
2. **Çıktı Sanitizasyonu**:
   - `HttpLlmTransport` giden veya gelen nesneleri loglamaz.
   - Hata durumunda sağlayıcıdan dönen gövde `sanitizeSecretsInObject` fonksiyonundan geçirilir. Şifre, anahtar, token veya secret benzeri alanlar `***REDACTED***` ile maskelenir.
   - Hata URL'leri `sanitizeSecrets(targetUrl)` ile maskelenir.
3. **Depolama ve Git Korunumu**:
   - Kod tabanında, test dosyalarında veya fixture'larda hiçbir gerçek API anahtarı saklanmamıştır.
   - `.gitignore` kuralları ve ortam değişkenleri korunmaktadır.

---

## 6. Bütçe Entegrasyonu

P18-03 altyapısı aynen korunmuş ve tam uyum sağlanmıştır:
- **Pre-Dispatch Rezervasyon**: Çağrı öncesinde `budgetManager.preDispatchValidate` ve `budgetManager.reserve` çalıştırılarak fon PREPARED olarak bloke edilir.
- **Atomik Dispatch Doğrulaması**: `HttpLlmTransport.send`, `x-budget-reservation-id` başlığını ve SQLite rezervasyon durumunu doğrulamadan ağ isteği göndermez.
- **Gerçek Kullanım ile Uzlaştırma (Settlement)**: Yanıt alındığında gerçek `reportedUsage` metaverisi hesaplanır ve `budgetManager.settle` ile hesap bakiyelerine committed spend olarak yansıtılır.
- **Eksik Kullanımda UNKNOWN Koruması**: Sağlayıcı yanıtında token kullanım verisi bulunmuyorsa maliyet sıfır varsayılmaz; rezervasyon UNKNOWN hold olarak tutulur.
- **Timeout Koruması**: Ağ zaman aşımında veya belirsiz bağlantı kopmalarında harcama peşinen iptal edilmez; fon güvenliği için UNKNOWN olarak işaretlenir.
- **Çift Harcama Önleme**: Her dispatch benzersiz bir `dispatchClaimId` token'ı ile korunur; aynı rezervasyonla ikinci bir HTTP isteği ALREADY_CONSUMED ile reddedilir.
- **Bypass Engeli**: `BudgetManager` veya rezervasyon başlığı olmaksızın doğrudan HTTP transport veya Provider çağrısı yapmak `ERR_BUDGET_REQUIRED` ile fail-closed engellenir.

---

## 7. Mock / Production Ayrımı

1. **Production'da Mock Yasağı**:
   - `DirectorReasoningEngine` `mode: 'production'` modunda çalışırken mock sağlayıcı veya mock taşıyıcı tespiti durumunda derhal `LlmProviderUnavailableError` fırlatır.
2. **Sahte Taşıyıcı Tahrifatına Karşı Güvenlik Kökü**:
   - `TransportSecurityRegistry`, `network_http` olduğunu iddia eden duck-typed nesneleri veya proxy sarmalayıcıları reddeder.
   - Taşıyıcılar `TransportSecurityRegistry.registerLiveNetworkTransport` üzerinden kaydedilmeli, module-private `WeakSet` içinde yer almalı ve dondurulmuş (`Object.freeze`) olmalıdır.
3. **Test / Local Fixture Ayrımı**:
   - Testlerde kullanılan yerel HTTP sunucuları (`127.0.0.1:port`) gerçek socket seviyesinde çalışan gerçek ağ testleridir; mock transport ile karıştırılmamıştır.
   - Gerçek dış sağlayıcı çağrısı ile yerel fixture testleri açıkça ayrılmıştır.

---

## 8. Çalıştırılan Testler ve Gerçek Sonuçları

Aşağıdaki testler Node.js test runner (`node --test --experimental-strip-types`) ile gerçek zamanlı olarak çalıştırılmış ve tamamı başarıyla geçmiştir:

```
Test Dosyası                                            Test Sayısı   Sonuç
-----------------------------------------------------------------------------
tests/director-reasoning.test.ts                                 63   BAŞARILI (63/63)
tests/http-llm-transport.test.ts                                 18   BAŞARILI (18/18)
tests/budget-manager.test.ts                                     15   BAŞARILI (15/15)
tests/budget-llm-integration.test.ts                             38   BAŞARILI (38/38)
tests/llm-provider-adapter.test.ts                               22   BAŞARILI (22/22)
tests/llm-bridge.test.ts                                         25   BAŞARILI (25/25)
tests/token-budget.test.ts                                       28   BAŞARILI (28/28)
tests/a2-provider-integration.test.ts (Yeni A2 Test Paketi)     10   BAŞARILI (10/10)
-----------------------------------------------------------------------------
TOPLAM                                                          219   BAŞARILI (219/219)
```

**`tests/a2-provider-integration.test.ts` Detaylı Sonuçları:**
1. `A2-01: OpenAI Chat Completions wire request formats cleanly without internal metadata pollution` -> **ok** (58.4ms)
2. `A2-02: Provider usage metadata correctly extracts cached and reasoning tokens` -> **ok** (12.4ms)
3. `A2-03: Budget subsystem reconciles exact spend with cached tokens discount and reasoning tokens` -> **ok** (32.9ms)
4. `A2-04: API keys and credentials are never exposed in error messages, headers, or telemetry` -> **ok** (11.7ms)
5. `A2-05: Timeout triggers LlmTimeoutError fail-closed` -> **ok** (122.3ms)
6. `A2-06: Malformed non-JSON response from provider fails closed with MalformedLlmResponseError` -> **ok** (19.7ms)
7. `A2-07: Provider response attempting authority escalation is rejected` -> **ok** (2.7ms)
8. `A2-08: Mock transport pretending to be real network transport is strictly rejected in production` -> **ok** (1.6ms)
9. `A2-09: Missing provider and missing credentials strictly fails closed at initialization` -> **ok** (1.9ms)
10. `A2-10: Confirms zero live external network calls were executed (NOT_VERIFIED_IN_PROD)` -> **ok** (0.8ms)

---

## 9. Build Sonucu

TypeScript proje derlemesi (`npm run build` / `tsc -b`) hatasız ve uyarı vermeden tamamlanmıştır:

```bash
> @aidm/core@0.1.0 build
> tsc -b
# Exit code: 0
```

---

## 10. Gerçek API Çağrısı Yapılmadığına Dair Açık Kayıt

> [!IMPORTANT]
> **Canlı Sağlayıcı Doğrulama Durumu: `NOT_VERIFIED_IN_PROD`**
> 
> Kullanıcı talimatları ve güvenlik kuralı 6 gereğince bu görev boyunca:
> - Hiçbir harici ücretli LLM sağlayıcısına (OpenAI, Anthropic vb.) canlı çağrı yapılmamıştır.
> - Hiçbir gerçek API kredisi veya bütçe harcanmamıştır.
> - Kullanıcının ortamındaki API anahtarları ekrana veya rapora yazılmamıştır.
> - Tüm entegrasyon doğrulamaları yerel HTTP soketleri, HTTP fixture'ları ve offline test paketleri ile yapılmıştır.
> 
> Canlı sağlayıcı smoke testi yapılmamış olup, bu durum açıkça **`NOT_VERIFIED_IN_PROD`** olarak kayıt altına alınmıştır. Bu durum teknik kod hazırlığının ve protokol uyumluluğunun eksik olduğu anlamına gelmez.

---

## 11. Kalan Eksiklikler ve Riskler

1. **Canlı Ağ Koşulları ve Hız Limitleri (Rate Limits)**:
   - Yerel HTTP fixture testleri HTTP 429 ve 5xx davranışını doğrulamış olsa da, gerçek OpenAI uç noktasında karşılaşılacak `Retry-After` başlığına dayalı otomatik exponential backoff stratejisi üst katman loop'larında (A3/A4) ele alınmalıdır.
2. **Model Adı Değişiklikleri**:
   - Gelecekte OpenAI tarafından çıkarılacak yeni model aileleri (örn. reasoning modelleri için özel `max_completion_tokens` gereksinimleri) için adaptör esnek tutulmuştur; ancak model bazlı spesifik kısıtlamalar runtime ortam değişkenleri ile izlenmelidir.
3. **A3/A4 Bağlantı Sınırı**:
   - Director'ın ürettiği `ParsedDirectorDecision`, yönerge gereği henüz doğrudan AGY'ye veya execution driver'ına gönderilmemektedir. Bu aşama A3 ve A4 kapsamında bağlanacaktır.

---

## 12. A2 Kabul Kriterlerinin Tek Tek Sonucu

| Kabul Kriteri | Durum | Açıklama |
|---|---|---|
| **Kriter 1: Gerçek Sağlayıcı Transport Hazırlığı** | **KABUL EDİLDİ** | `ReferenceLlmAdapter` ve `HttpLlmTransport`, OpenAI Chat Completions API formatına tam uyumlu hale getirildi. Gereksiz üst düzey alanlar temizlendi, HTTP başlıkları korundu. |
| **Kriter 2: Provider Yanıtlarının Güvenli Doğrulanması** | **KABUL EDİLDİ** | JSON şema doğrulaması, tazelik (fingerprint) kontrolü ve yetki yükseltme engeli tam korundu. |
| **Kriter 3: Mock ve Production Ayrımı** | **KABUL EDİLDİ** | `TransportSecurityRegistry` ve unforgeable symbol kontrolü ile mock taşıyıcıların production modunda çalışması kesin olarak engellendi. |
| **Kriter 4: Bütçe Entegrasyonunun Korunması** | **KABUL EDİLDİ** | P18-03 SQLite bütçe motoru aynen korundu; atomik rezervasyon, claim, settlement, UNKNOWN hold ve önbellek/reasoning token hesaplamaları doğrulandı. |
| **Kriter 5: Fail-Closed Hata ve Timeout Davranışı** | **KABUL EDİLDİ** | Ağ hatası, geçersiz JSON, eksik kimlik bilgisi ve zaman aşımlarında sahte yanıt üretilmediği, hatanın anında fail-closed fırlatıldığı kanıtlandı. |
| **Kriter 6: Test ve Build Başarısı** | **KABUL EDİLDİ** | Tüm testler (219 adet) ve `tsc -b` derlemesi sıfır hata ile geçti. |
| **Kriter 7: Canlı Çağrı Beyanı** | **KABUL EDİLDİ** | Canlı API çağrısı yapılmadığı `NOT_VERIFIED_IN_PROD` olarak şeffaf şekilde beyan edildi. |

---

**Sonuç:** A2 görevi teknik olarak eksiksiz tamamlanmıştır. A3 aşamasına geçilmemiş olup kullanıcı incelemesi beklenmektedir.
