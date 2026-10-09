# AIDM — Yapılandırılmış Loglama ve MCP stdio Bütünlüğü Sözleşmesi (LOGGING.md)

**Belge Kodu:** AIDM-DOC-LOGGING  
**Sürüm:** 1.0.0  
**Tarih:** 2026-10-09  
**Durum:** ACCEPTED (Bağlayıcı)  
**Kapsam:** `@aidm/core` yapılandırılmış loglama mimarisi, MCP stdio taşıyıcı koruması, log seviyeleri, sır maskeleme ve teşhis sözleşmesi.

---

## 1. Temel İlke ve MCP stdio Protokol Güvenliği

AIDM, Antigravity IDE, Claude Desktop, Cursor veya ChatGPT gibi istemcilerle **Model Context Protocol (MCP)** üzerinden `stdio` taşıyıcısı ile haberleşir.

### 1.1 Değişmez Kural: Sıfır stdout Kirliliği (Zero stdout Pollution)
- `process.stdout` **yalnızca ve kesinlikle** JSON-RPC 2.0 protokol mesajlarına (satır bazlı JSON dizgileri) ayrılmıştır.
- Herhangi bir bileşenin `console.log(...)` veya `process.stdout.write(...)` ile ham metin basması, istemci tarafında JSON ayrıştırma hatasına (`JSON.parse error: Unexpected token...`) ve MCP bağlantısının kopmasına yol açar.
- Bu nedenle, AIDM bünyesindeki tüm operasyonel, hata ve teşhis logları **kesinlikle `process.stderr` akışına veya `.ai-manager/logs/` altındaki dosyalara** yönlendirilir.

---

## 2. Log Seviyeleri (Leveled Logging)

Log seviyeleri hiyerarşik öncelik sırasına sahiptir. `AIDM_LOG_LEVEL` ortam değişkeni veya kod içi `setLevel()` metodu ile filtrelenir (varsayılan: `info`):

| Seviye | Öncelik | Açıklama | Örnek Senaryo |
| :--- | :---: | :--- | :--- |
| `debug` | 10 | Ayrıntılı dahili akış, token tahminleri, ayrıştırma ara adımları | Prompt token kırpma detayları, ara durum geçişleri |
| `info` | 20 | Normal operasyonel kilometre taşları | Oturum başlatma, görev seçimi, başarılı doğrulama |
| `warn` | 30 | Kurtarılabilir uyarılar, yeniden denemeler, bütçe uyarıları | Bütçe limitine yaklaşma, kilit bekleme süresi aşımı |
| `error` | 40 | Güvenlik ihlalleri, altyapı çökmeleri, başarısızlıklar | Yetkisiz eylem engelleme, bozuk durum algılama |

---

## 3. Log Hedefleri (Destinations)

Loglayıcı (`StructuredLogger`) aşağıdaki hedeflere yazacak şekilde yapılandırılabilir:

1. **`stderr` (Varsayılan):** Terminal ve IDE konsoluna tek satırlık yapılandırılmış JSON çıktısı basar. `process.stdout` akışını kesinlikle etkilemez.
2. **`file`:** `.ai-manager/logs/aidm.log` (veya belirtilen `logFilePath`) dosyasına atomic/güvenli biçimde ekleme (append-only) yapar. Dizin yoksa otomatik oluşturur.
3. **`both`:** Hem `stderr` hem de `.ai-manager/logs/aidm.log` dosyasına eşzamanlı yazar.
4. **`custom`:** Test süitleri veya telemetri sistemleri için özel bir `customWriter(entry, serialized)` işlevi kabul eder.

---

## 4. Otomatik Sır ve Kimlik Bilgisi Maskeleme (Secret Sanitization)

Log çıktıları hiçbir koşulda hassas kimlik bilgilerini sızdıramaz:
- `sk-[a-zA-Z0-9_-]{10,}` kalıbı `***REDACTED_KEY***` ile değiştirilir.
- `Bearer [token]` kalıbı `Bearer ***REDACTED_TOKEN***` ile değiştirilir.
- Bağlam nesnelerinde (`context` ve `details`) anahtar adı `key`, `secret`, `token`, `password`, `auth` içeren tüm alanların değerleri doğrudan `***REDACTED***` olarak maskelenir.
- Hata nesnelerindeki (`error.message` ve `error.stack`) hassas metinler de otomatik temizlenir.

---

## 5. Yapılandırılmış Bağlam ve İlişkilendirme (Correlation)

Her log girdisi aşağıdaki standart şemaya uygundur:

```json
{
  "timestamp": "2026-10-09T12:00:00.000Z",
  "level": "info",
  "message": "Task execution authorized",
  "context": {
    "projectId": "proj-alpha",
    "sessionId": "sess-12345",
    "taskId": "TASK-01",
    "executionId": "exec-789",
    "correlationId": "corr-456",
    "component": "AuthorizationPolicyEngine"
  }
}
```

### 5.1 Alt Loglayıcılar (`child`)
`logger.child({ taskId: 'TASK-01', component: 'DagEngine' })` çağrısı, üst loglayıcının bağlamını devralan ve her log mesajına otomatik ekleyen izole bir alt loglayıcı üretir.

---

## 6. Fail-Safe Tasarım Güvencesi

Loglama mekanizmasında oluşabilecek herhangi bir hata (örneğin disk dolu, dosya izni hatası, `stderr` borusunun kapanması):
- Asla bir exception fırlatmaz.
- Asla AIDM FSM durum makinesini veya güvenlik kapılarını kesintiye uğratmaz.
- Sessizce fail-safe modda yutularak temel sistemin çalışırlığını korur.

---

## 7. Kullanım Örnekleri

```typescript
import { createLogger, getDefaultLogger } from '@aidm/core/logging';

// 1. Varsayılan singleton loglayıcı (stderr hedefli)
const logger = getDefaultLogger();
logger.info('AIDM MCP Server started');

// 2. Proje bağlamlı ve dosyaya yazan loglayıcı
const projectLogger = createLogger({
  level: 'debug',
  destination: 'both',
  baseDir: '/path/to/project',
  defaultContext: { projectId: 'my-project' },
});

// 3. Göreve özgü alt loglayıcı
const taskLogger = projectLogger.child({ taskId: 'TASK-P20-01' });
taskLogger.debug('Evaluating rule set', { ruleCount: 15 });
```
