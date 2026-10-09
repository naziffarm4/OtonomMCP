# OtonomMCP (AIDM) — Ortam Değişkenleri ve Yapılandırma Sözleşmesi (ENVIRONMENT.md)

**Belge Kodu:** AIDM-DOC-ENV  
**Sürüm:** 1.0.0  
**Tarih:** 2026-10-09  
**Kapsam:** AIDM Çalışma Zamanı Ortam Değişkenleri, Tüketen Bileşenler, Öncelik Hiyerarşisi, Üretim Modu ve Güvenlik Sözleşmesi

---

## 1. Ortam Değişkenleri Referans Tablosu

| Değişken Adı | Zorunluluk | Varsayılan Değer | Tüketen Bileşenler | Öncelik Hiyerarşisi | Açıklama ve Güvenlik Sözleşmesi |
|:---|:---:|:---|:---|:---|:---|
| `AIDM_LLM_API_KEY` | Opsiyonel | `null` | `DirectorReasoningEngine`<br>`HttpLlmTransport` | `config.apiKey` > `AIDM_LLM_API_KEY` > `OPENAI_API_KEY` | AIDM'ye özel birincil LLM API anahtarı. Tanımlandığında `OPENAI_API_KEY` değerini ezer. Loglara ve hata mesajlarına asla yazılmaz. |
| `OPENAI_API_KEY` | Opsiyonel | `null` | `DirectorReasoningEngine`<br>`HttpLlmTransport` | `AIDM_LLM_API_KEY` yoksa kullanılır. | Standart OpenAI API anahtarı. Canlı OpenAI uç noktalarına erişimde kullanılır. |
| `AIDM_LLM_ENDPOINT` | Opsiyonel | Uç nokta OpenAI ise `https://api.openai.com/v1/chat/completions`, aksi halde `undefined` | `DirectorReasoningEngine`<br>`BudgetAwareLlmAdapter`<br>`endpoint-audit.ts` | `config.endpoint` > `AIDM_LLM_ENDPOINT` > `OPENAI_BASE_URL` | Tam HTTP çağrı URL'si. `OPENAI_BASE_URL` ile çelişen origin veya yol tespit edilirse fail-closed olarak `ERR_UNSUPPORTED_BILLING_MODE` fırlatılır. |
| `OPENAI_BASE_URL` | Opsiyonel | `https://api.openai.com` | `BudgetAwareLlmAdapter`<br>`endpoint-audit.ts` | `AIDM_LLM_ENDPOINT` tam URL'si yoksa taban adres olarak çözülür. | OpenAI uyumlu sağlayıcı taban URL'si. Yalnızca standart ve kayıtlı ana bilgisayarlar doğrulanır; bilinmeyen proxy ana bilgisayarları sözleşmesiz kabul edilmez. |
| `AIDM_LLM_MODEL` | Opsiyonel | `gpt-4o` (OpenAI için), `director-reasoning-v1` (özel adaptörler için) | `DirectorReasoningEngine`<br>`DirectorRuntime` | `config.model` > `AIDM_LLM_MODEL` > `OPENAI_MODEL` > Varsayılan | AIDM model tanımlayıcısı. `OPENAI_MODEL` değerinden önce gelir. |
| `OPENAI_MODEL` | Opsiyonel | `gpt-4o` | `DirectorReasoningEngine`<br>`DirectorRuntime` | `AIDM_LLM_MODEL` yoksa kullanılır. | Standart OpenAI model seçimi (ör. `gpt-4o`, `gpt-4o-mini`). |
| `AIDM_MCP_AUTH_TOKEN` | Opsiyonel | `null` / `undefined` | `DirectorMcpClient`<br>`McpServer` | `options.authToken` > `process.env.AIDM_MCP_AUTH_TOKEN` | MCP `stdio` JSON-RPC veya HTTP taşıyıcısı üzerinde istemci/sunucu kimlik doğrulama belirteci. |
| `NODE_ENV` | Opsiyonel | `development` | `DirectorRuntime` | Doğrudan okunur. | Çalışma ortamı modu (`development`, `production`, `test`). Üretimde (`production`) mock sağlayıcılar kesinlikle engellenir. |
| `AIDM_LIVE_E2E` | Opsiyonel | `0` | Test Süitleri (`*.live.test.ts`), Test Runner (`run-tests.js`) | Komut satırı `--live` bayrağı veya doğrudan ortam değişkeni | Canlı harici LLM ve canlı Antigravity CLI testlerinin çalıştırılması için açık opt-in anahtarı. Varsayılan testlerde sıfırdır (`0`). |
| `ANTIGRAVITY_BIN_PATH` | Opsiyonel | Sistem PATH'i | `antigravity-process-runner.ts` | `configuredBinaryPath` > `ANTIGRAVITY_BIN_PATH` > `AGY_BIN_PATH` > `AGY_PATH` > Sistem PATH | Antigravity CLI (`agy` / `agy.exe`) ikili dosya yolu geçersiz kılma. |
| `AGY_BIN_PATH` | Opsiyonel | Sistem PATH'i | `antigravity-process-runner.ts` | `ANTIGRAVITY_BIN_PATH` yoksa kullanılır. | İkincil `agy` yolu ortam değişkeni. |
| `AGY_PATH` | Opsiyonel | Sistem PATH'i | `antigravity-process-runner.ts` | `AGY_BIN_PATH` yoksa kullanılır. | Üçüncül `agy` yolu ortam değişkeni. |

---

## 2. Üretim Modu Sözleşmesi (`NODE_ENV=production`)

`DirectorRuntime` başlatıldığında veya muhakeme döngüsü (`reason`) işletildiğinde `NODE_ENV` denetlenir:

1. **Mock Sağlayıcı Yasağı:**
   Eğer `NODE_ENV === 'production'` ise, `llmProvider.isMock === true` olan hiçbir sağlayıcı kabul edilmez. `allowMockProvider: true` açıkça enjekte edilmediği sürece sistem fail-closed olarak anında `DirectorLlmProviderUnavailableError` fırlatır:
   ```text
   Mock LLM provider is strictly prohibited in production mode. A real LLM provider must be configured.
   ```
2. **Sağlayıcı Zorunluluğu:**
   Üretim ortamında `llmProvider` tanımlı değilse veya `null` ise, herhangi bir varsayılan simülasyon fallback'i çalıştırılmaz; `DirectorLlmProviderUnavailableError` ile icra durdurulur.
3. **Kullanılabilirlik Denetimi (`checkAvailability`):**
   Canlı sağlayıcının ağ bağlantısı veya kimlik bilgileri doğrulanmadan hiçbir eylem icra hattına gönderilmez.

---

## 3. Uç Nokta Çözümleme ve Bütçe Denetimi Sözleşmesi

`BudgetAwareLlmAdapter` ve `resolveEffectiveBillingEndpoint` (`packages/core/src/budget/endpoint-audit.ts`):

1. **Çelişen Uç Nokta Koruması:**
   Eğer hem tam `requestEndpoint` (veya `AIDM_LLM_ENDPOINT`) hem de `requestBaseUrl` (veya `OPENAI_BASE_URL`) sağlanmışsa:
   - Origin değerleri (protokol, host, port) birebir eşleşmek zorundadır.
   - Farklı origin tespit edilirse `ERR_UNSUPPORTED_BILLING_MODE` hatasıyla çağrı fail-closed durdurulur.
2. **Bilinmeyen / Proxy Ana Bilgisayarlar:**
   Resmî `api.openai.com` veya `api.anthropic.com` dışındaki özel/proxy adresler, `PricingEngine` içinde yetkili bir fiyat tarifesi ve açık kullanım sözleşmesi (`usageContract`) bulunmadıkça yetkilendirilmez.
3. **Sır Maskeleme:**
   Hata nesneleri ve telemetri logları içindeki URL parametreleri, kimlik bilgileri ve API anahtarları `sanitizeSecrets` süzgecinden geçirilir; asla düz metin olarak dışarı sızdırılmaz.
