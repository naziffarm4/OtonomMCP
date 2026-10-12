# OtonomMCP — AI Development Manager (AIDM)

OtonomMCP (AIDM), yazılım projelerinde otonom geliştirme yaşam döngüsünü (Director ↔ Orkestratör ↔ Uygulayıcı) güvenli sınırlar, deterministik harcama bütçesi ve bağımsız kanıt doğrulaması altında yöneten kurumsal düzeyde bir otonom proje yöneticisidir.

Antigravity IDE içinde Model Context Protocol (MCP) `stdio` JSON-RPC 2.0 arayüzü üzerinden yerel olarak çalışır; harici sunucu veya ikinci bir kullanıcı arayüzü gerektirmez.

---

## 🎯 Hangi Problemi Çözer?

Yapay zeka tabanlı otonom kod geliştirme süreçlerinde karşılaşılan temel yapısal riskler şunlardır:
- **Kontrolsüz Kod ve Komut İcrası:** Ajanların projenin belirlenen sınırları dışına çıkarak kritik dosyaları veya güvenlik kurallarını bozması.
- **Sözel Beyan Yanılsaması (Halüsinasyon / Sahte Başarı):** Uygulayıcı modelin "kod yazıldı ve tüm testler geçti" şeklinde gerçeği yansıtmayan sözel başarı beyanlarında bulunması.
- **Bütçe ve Maliyet Aşımı:** API token harcamalarının denetlenememesi veya beklenmeyen fatura artışları.
- **Yetki Aşımı ve Sahte Kimlik:** Dil modellerinin prompt enjeksiyonu veya rol varsayımıyla insan adına onay üretmeye kalkışması (`actor: "USER"`).

OtonomMCP, bu riskleri **kapalı döngü koordinasyonu (closed-loop orchestration)**, **Zero Executor Trust (sıfır uygulayıcı güveni)**, **bağımsız delil doğrulama (SystemExecutionEvidence)** ve **fail-closed güvenlik kapıları** ile çözüme kavuşturur.

---

## 🏛 Çekirdek Bileşenler ve Görev Dağılımı

OtonomMCP mimarisi, net olarak ayrılmış 7 ana aktör üzerine kuruludur:

1. **Director (ChatGPT Director / Karar Verici):**
   - Kullanıcı ile doğal dilde etkileşim kuran tek planlama ve mimari karar otoritesidir.
   - Proje hedeflerini değerlendirir, taze sistem bağlamını inceler ve eylem kararı üretir (`DirectorAction`).
   - Doğrudan dosya yazamaz veya kabuk komutu çalıştıramaz; tüm taleplerini MCP üzerinden Orkestratöre iletir.

2. **Orchestrator (AIDM Çekirdeği):**
   - Sistemin tek durum otoritesidir (State Authority).
   - FSM durum makinesini, görev çizgesini (Task DAG), proje yetki belgesini (Project Mandate) ve olay günlüğünü (`history.jsonl`) yönetir.

3. **MCP Server (Model Context Protocol Denetim Düzlemi):**
   - `stdio` üzerinden JSON-RPC 2.0 protokolü ile dış dünyaya ve Director'a sunulan kontrol arayüzüdür.
   - İkinci bir orkestratör **değildir**; FSM durumunu doğrudan değiştiremez, kendi başına görev oluşturamaz. Tüm çağrıları AIDM çekirdek servislerine ve politika süzgecine iletir.

4. **Driver (DriverEngine & DriverRuntime):**
   - Görevlerin adım adım güvenli yürütülmesini yöneten durum makinesidir.
   - Tekil PID kilidi (`.ai-manager/runtime.lock`) altında tekil süreç güvenliğini sağlar.

5. **AGY (Antigravity CLI Uygulayıcısı):**
   - Dosya oluşturma, düzenleme ve yerel test/build komutlarını yürüten alt süreç uygulayıcısıdır (`child_process`).
   - Kendi durumunu başarılı ilan etme yetkisi yoktur; çıktısı yalnızca ham icra telemetrisidir.

6. **Evidence (EvidenceCollector & FileHashCollector):**
   - AGY tarafından yapılan değişiklikleri işletim sistemi ve Git seviyesinde denetleyen bağımsız hakemdir.
   - SHA-256 dosya hash'leri, Git diff ve bağımsız test çıkış kodlarını toplayarak `SystemExecutionEvidence` üretir.

7. **Policy & ExecutionBridge (Yetkilendirme ve Güvenlik Kapıları):**
   - Eylemleri Project Mandate kurallarına göre değerlendirir (`ALLOW`, `DENY`, `REQUIRE_HUMAN_APPROVAL`).
   - Yürütme öncesi 6 katı güvenlik kontrolünü uygular: Context tazeliği, bütçe hold rezervasyonu (P18-03), mandate uyumu, sahte yetki kontrolü, anti-replay ve dış onay kanıtı (P18-04 / Check 6).

---

## 🛠 Teknoloji Yığını

- **Çalışma Zamanı (Runtime):** Node.js (`>= 22.6.0`, Node 22 LTS, ESM)
- **Dil:** TypeScript (`5.8.x+`, katı tip denetimi)
- **Paket Yöneticisi:** pnpm (Workspace / Monorepo)
- **Protokol:** Model Context Protocol (MCP `stdio` JSON-RPC 2.0)
- **Veri Doğrulama:** Zod (`v3.x` / `v4.x`)
- **Veritabanı & Kalıcılık:** Yerleşik Node.js SQLite (`node:sqlite`, `BigInt` Nano-USD atomik bütçe ve durum defteri)
- **Test Çatısı:** Node.js Native Test Runner (`node --test`) & Vitest

---

## 📋 Gereksinimler

- **İşletim Sistemi:** Windows 10 / 11 (x64)
- **Node.js:** `>= 22.6.0` (Doğrulanan: `v22.19.0`, bkz. `.nvmrc`)
- **pnpm:** `>= 9.0.0` (Doğrulanan: `12.3.4`)
- **Git:** Sürüm kontrolü ve bağımsız kanıt doğrulama için yerel Git CLI

---

## 🚀 Kurulum ve Çalıştırma

### Bağımlılıkların Kurulumu
```bash
pnpm install
```

### Derleme (Build)
```bash
pnpm build
```

### Testleri Çalıştırma (Deterministik & Çevrimdışı)
```bash
pnpm test
```

### Canlı E2E Testleri (Opt-in)
```bash
pnpm test:live
```

### Yapılandırma ve Ortam Değişkenleri
Ortam değişkenleri, öncelik hiyerarşisi ve üretim modu güvenlik sözleşmesi için [.env.example](.env.example) ve [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) dokümanına bakınız.

### Operasyonel CLI ve Antigravity IDE / MCP Entegrasyonu

`packages/core/bin/aidm.js` OtonomMCP'nin operasyonel CLI giriş noktasıdır. Sistem yönetimini ve çalışma zamanını denetlemek için şu operasyonel komutları sağlar:
- `aidm init`: Yeni bir AIDM çalışma alanı/projesi başlatır.
- `aidm status`: Proje yaşam döngüsünü ve Git durumunu görüntüler.
- `aidm checkpoint`: Git kontrol noktalarını yönetir (list, create, rollback).
- `aidm driver`: Yönetilen Otonom Sürücü çalışma zamanını yürütür (`run`, `status`, `stop`).
- `aidm run`: Otonom yaşam döngüsü yürütmesini başlatır.
- `aidm run --spec <dosya.md>`: Tek bir Markdown spesifikasyonundan projeyi soru sormadan uçtan uca geliştirir (aşağıya bakın).
- `aidm mcp`: Antigravity IDE ile entegrasyonu sağlayan yetkili MCP sunucusunu başlatır.

> [!IMPORTANT]
> `aidm` interaktif bir doğal dil sohbet istemcisi veya terminal kabuğu **değildir**. Kullanıcı ile doğal dilde muhakeme, hedef analizi ve görev planlaması yalnızca ChatGPT Director tarafından yürütülür; Director ise sisteme MCP araçları üzerinden bağlanır.

#### Antigravity IDE MCP Yapılandırması

MCP sunucusunu başlatmak için `mcp` alt komutu gereklidir (`node packages/core/bin/aidm.js mcp`).

Antigravity IDE yapılandırma dosyanıza (`mcp_config.json`) gerçek entegrasyon formatına uygun olarak şu şekilde eklenir:

```json
{
  "mcpServers": {
    "OtonomMCP": {
      "command": "node",
      "args": [
        "packages/core/bin/aidm.js",
        "mcp"
      ],
      "env": {},
      "disabled": false,
      "disabledTools": []
    }
  }
}
```

> [!NOTE]
> Proje kök dizinine göre göreli yol yerine tam mutlak yol kullanmak isterseniz `args` alanında `d:/ÇALIŞMALAR-D/OtonomMCP/packages/core/bin/aidm.js` belirtebilirsiniz.

---

## 🤖 Tam Otonom Geliştirme: `aidm run --spec`

API anahtarı + tek bir Markdown dosyası verildiğinde AIDM, kullanıcıya soru sormadan LLM'i Director, AGY'yi uygulayıcı olarak kullanır ve projeyi uçtan uca geliştirir. Örnek spesifikasyon: [docs/examples/ornek-proje-spesifikasyonu.md](docs/examples/ornek-proje-spesifikasyonu.md).

```bash
# OpenAI
export AIDM_LLM_API_KEY="sk-..."
export AIDM_LLM_MODEL="gpt-6-luna"        # varsayılan (OpenAI DirectorRuntime ile aynı); doğrulanmış fiyatı yerleşik
export AIDM_LLM_REASONING_EFFORT="medium" # none|minimal|low|medium|high|xhigh|max (varsayılan medium; geçersiz değer = fail-closed)

# veya Grok / xAI (OpenAI uyumlu chat completions)
export XAI_API_KEY="xai-..."              # ya da AIDM_LLM_API_KEY
export AIDM_LLM_ENDPOINT="https://api.x.ai/v1/chat/completions"
export AIDM_LLM_MODEL="grok-4"
export AIDM_LLM_INPUT_USD_PER_MTOK="3"    # 1M token başına USD (xAI ve özel uçlar için ZORUNLU)
export AIDM_LLM_OUTPUT_USD_PER_MTOK="15"

export AIDM_AGY_PATH="agy"                # Antigravity CLI yolu

# Önce plan (hiçbir dosya yazılmaz, LLM/AGY çağrılmaz)
node packages/core/bin/aidm.js run --spec ./benim-projem.md -C ./hedef-proje --dry-run

# Gerçek çalışma
node packages/core/bin/aidm.js run --spec ./benim-projem.md -C ./hedef-proje --budget-usd 5   # ADR-16: en fazla 10 USD (dönem tavanı); üstü CONFIGURATION_ERROR
```

Reasoning modellerinde (gpt-6-luna, gpt-5*, o-serisi) istek gövdesi `reasoning_effort` ve `max_completion_tokens` içerir; `temperature` yalnızca `AIDM_LLM_REASONING_EFFORT=none` iken gönderilir; strict `json_schema` korunur. Her `aidm run --spec` çağrısı kendi `budget.db` dosyasında açıkça yetkilendirilmiş bir ADR-16 bütçe dönemi olarak kaydedilir.

Director çıktısı: LLM yalnızca karar alanlarını üretir (`actionType`, `rationale`, `confidence`, görev yükü, `assumptions`); `protocolVersion`, `actionId`, `projectId`, `directorSessionId`, `basedOnContextFingerprint` gibi zarf alanlarını sistem doldurur. LLM bunlardan farklı bir proje/oturum/fingerprint değeri gönderirse eylem reddedilir (fail-closed). `AIDM_LLM_RESPONSE_FORMAT=auto|json_schema|json_schema_loose|json_object` (varsayılan `auto`: strict `json_schema`, sağlayıcı desteklemezse `json_object`), `AIDM_LLM_REPAIR_ATTEMPTS=0..3` (varsayılan 1: doğrulama hatası LLM'e geri beslenir; her istek ayrı bütçe rezervasyonu alır).

Ek seçenekler: `--max-cycles N` (görev başına döngü, varsayılan 3), `--mandate-hours H` (mandate geçerliliği, varsayılan 8, en fazla 24), `--no-commit`, `--llm-endpoint URL`, `--llm-model AD`, `--json`, `--verbose`. MCP üzerinden aynı akış `aidm_autonomous_start` aracıyla çalışır.

**Akış:** `SpecIngestor` (MD → `InitialProjectUnderstanding` + `ProposedDevelopmentPlan` + görevler, SHA-256 ile spec'e bağlı) → otomatik Project Mandate (yalnızca `IMPLEMENTATION` sınıfı = `ALLOW`) → ApprovalPackage → her görev için `ClosedLoopCoordinator` (Director/LLM → Policy → ExecutionBridge → Driver → AGY → bağımsız `SystemExecutionEvidence`) → kabul edilen her görev için commit → `.ai-manager/reports/autonomous-<run>.json|.md` özet raporu (değişen dosyalar, kanıtlar, doğrulama komutları, bütçe, commitler, varsayımlar).

**Yetki nereden gelir?** Mandate'i LLM değil, komutu kendi terminalinden çalıştıran **insan operatör** yetkilendirir: CLI, yerel (işletim sistemi kullanıcısına bağlı) Ed25519 kimliğiyle kısa ömürlü, nonce'lu, projeye ve spec hash'ine bağlı bir `OPERATOR_CLI_INVOCATION` bağlamı imzalar; mandate mevcut `ProjectMandateStore.saveMandate` güvenilir kimlik doğrulamasından geçerek mühürlenir. MCP çağıranları (LLM ajanı olabilir) bu yolu kullanamaz; canlı çalışma için doğrulanabilir bir insan `authContext`'i (dış IdP / Trusted IDE) gerekir, yoksa `BLOCKED_ON_AUTH_CONTEXT`.

**Hâlâ insan onayı gerektirenler (fail-closed):** politika/mandate değişikliği, bütçe artırma/aşımı, yeniden planlama (`REPLAN`), `REQUEST_HUMAN_DECISION`, kapsam dışı/güvenlik sınırı dışı eylemler, ağ erişimi, bağımlılık kurulumu. Proje kökü dışı, `.ai-manager`, push/force-push ve yıkıcı işlemler `DENY`. Bütçe olmadan canlı çalışma başlamaz; fiyatı bilinmeyen model için istek gönderilmeden durulur.

**Soru sormama modu:** Director'ın netleştirme talepleri (`REQUEST_CLARIFICATION`) kayıtlı varsayımlara çevrilir ve çalışma devam eder; insan kapısı, politika reddi, bilinmeyen yürütme durumu veya bütçe tükenmesi çalışmayı durdurur (çıkış kodu `4`).

> [!NOTE]
> Yerel kimlik anahtarı şu an Windows DPAPI ile korunur; diğer işletim sistemlerinde canlı çalışma `BLOCKED_ON_AUTH_CONTEXT` ile güvenli şekilde durur (`--dry-run` her yerde çalışır). Gerçek API anahtarı ve gerçek AGY ile canlı E2E henüz çalıştırılmamıştır.

---

## ⚠️ Mevcut Çalışma Sınırları

- **Yetkilendirilmiş Rutin Görevler:** Project Mandate kapsamında tanımlı `ALLOW` yetkisindeki rutin geliştirme görevleri tam otonom olarak yürütülür.
- **İnsan Onayı ve Güvenlik Kilidi (P18-04 / Check 6):** İnsan onayı gerektiren işlemler (`REQUIRE_HUMAN_APPROVAL`), bağımsız bir bant dışı kimlik kanıtı doğrulanmadığı sürece fail-closed olarak bekletilir (`BLOCKED_ON_AUTH_CONTEXT`). P18-04 (Trusted Identity Context) henüz tamamlanmamış olup, gerçek güvenilir insan kimliği doğrulaması mevcut olmadığı sürece fail-closed davranışı korunur. İstemcinin veya modelin `isTrustedHumanAuth: true` beyanı kesinlikle kabul edilmez.
- **Doğrulama Durumu:** Sistem mimarisi, kapalı döngü koordinatörü ve birim/entegrasyon testleri (PASS) tamamlanmıştır; canlı LLM API ve IDE uçtan uca kabul aşamaları devam etmektedir.

---

## 📚 Temel Dokümantasyon

Tüm mimari, entegrasyon, güvenlik ve operasyonel detaylar `docs/` dizini altındaki 5 ana belgede toplanmıştır:

1. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
   *Sistem Mimarisi ve Bileşen Tasarımı.* Çekirdek modüller, bileşen konumları, 4 seviyeli doğrulama hiyerarşisi, kapalı döngü iş akışı ve çalışma zamanı modeli.

2. **[docs/ROADMAP.md](docs/ROADMAP.md)**
   *OtonomMCP Tamamlama ve Dondurma Yol Haritası.* OM-01–OM-10 aşama durumları (`DONE`, `PARTIAL`, `BLOCKED`, `NOT_STARTED`, `VERIFIED_IN_PRODUCTION`), bağımlılıklar, güvenlik engelleri ve dondurma koşulları.

3. **[docs/INTEGRATION.md](docs/INTEGRATION.md)**
   *Entegrasyon ve MCP Sözleşmesi.* Gerçek MCP JSON-RPC arayüzü, kayıtlı araçlar, domain tipleri (`ApprovalPackage`, `ProjectApprovalRecord`, `BridgeExecutionIntent`), idempotency ve hata kodları.

4. **[docs/SECURITY.md](docs/SECURITY.md)**
   *Güvenlik Modeli ve Tehdit Sınırları.* Zero Executor Trust, Windows NT DAC sınırları, sahte yetki engelleri, secret sanitization, bütçe hold rezervasyonu ve fail-closed kapıları.

5. **[docs/DECISIONS.md](docs/DECISIONS.md)**
   *Bağlayıcı Mimari Karar Kayıtları (ADR).* Kesinleşmiş mimari kararlar, tekil durum/Director yetkisi, bütçe ve kilit yönetimi.
