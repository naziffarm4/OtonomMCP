# ADR-12: Modül Sahipliği, Çakışma Yönetimi ve Dışa Aktarma Politikası

**Belge Kodu:** AIDM-DOC-ADR-12  
**Sürüm:** 1.0.0  
**Tarih:** 2026-10-09  
**Durum:** ACCEPTED (Bağlayıcı)  
**Kapsam:** `@aidm/core` modül ayrımı, benzer isimli alt sistemlerin sınırları, public export politikası ve geriye dönük uyumluluk güvencesi.

---

## 1. Bağlam ve Problem Tanımı

AIDM projesinin evrimi sırasında aşamalı olarak geliştirilen alt sistemlerde (P18, P19, P26, P27) benzer isimlendirmelere veya örtüşen kavramsal alanlara sahip modüller ortaya çıkmıştır:

1. **`src/budget/` ↔ `src/token-budget/`:**
   - İki ayrı alt dizin "budget" adını taşımakta ve bu durum geliştiricilerde gereksiz kod tekrarı (duplicate module) algısı yaratmaktadır.
2. **`src/director/` ↔ `src/director-action/`:**
   - Hem `director` hem de `director-action` altında `director-action-types.ts` ve `director-action-errors.ts` dosyaları bulunmaktadır.
3. **`DirectorPromptBuilder` Ayrımı:**
   - Hem `src/director-reasoning/director-prompt-builder.ts` hem de `src/director/director-prompt-builder.ts` sınıfları bulunmaktadır.
4. **Kök Dışa Aktarımlar (`src/index.ts`):**
   - Kök `index.ts` dosyasında yer alan `export *` ifadeleri, alt modüllerde aynı adı taşıyan tipler veya sınıflar olduğunda TypeScript derleyicisinde ad gölgeleme veya belirsiz dışa aktarım (ambiguous export) riski doğurabilmektedir.
5. **Paket Dışa Aktarım Haritası (`packages/core/package.json`):**
   - Public subpath export haritasında bazı modüllerin (`./authorization`, `./execution-integration`) eksik kalması riski.

Bu kararın amacı; söz konusu modüllerin gerçek sorumluluk sınırlarını, yetki hiyerarşisini, canonical uygulamalarını ve dışa aktarım sözleşmesini kesin ve bağlayıcı olarak belirlemektir.

---

## 2. Mevcut Durum ve Sorumluluk Analizi

### 2.1 `src/token-budget/` vs `src/budget/`

| Özellik | `src/token-budget/` | `src/budget/` |
| :--- | :--- | :--- |
| **Geliştirildiği Aşama** | Phase 8 & 9 (Architecture Sec 8-9) | Phase 18 / ADR-05 (P18-03) |
| **Temel Sorumluluk** | **Context Window Token Bütçesi ve Budama** | **Finansal Nano-USD Harcama Otoritesi** |
| **Birim / Hassasiyet** | Token sayısı (`number`, integer) | Nano-USD (`bigint`, 1 USD = 1.000.000.000 nUSD) |
| **Kalıcılık** | Bellek içi (In-Memory per-request) | Yerel SQLite veritabanı (`budget.db`) |
| **Çalışma Prensibi** | P0-P4 öncelik matrisine göre bağlam tutma/budama (`ContextPriority`) | Pre-dispatch `HOLD` rezervasyonu, LLM yanıtı sonrası `SETTLE` / `RELEASE` |
| **Sağlayıcı İlişkisi** | Yaklaşık token tahminleyicisi (`CostCalculator`) | Resmi fiyatlandırma motoru (`PricingEngine`), uç nokta denetimi (`EndpointAudit`) |

> **Sonuç:** `src/token-budget/` ve `src/budget/` birbirinin tekrarı **değildir**. İki modül tamamen farklı iki problemi çözmektedir: Biri LLM pencere sınırını (token), diğeri gerçek parasal harcama tavanını (dolar) yönetir.

### 2.2 `src/director/` vs `src/director-action/`

| Özellik | `src/director/` | `src/director-action/` |
| :--- | :--- | :--- |
| **Geliştirildiği Aşama** | Phase 9 (TASK-P9-01) & Phase 26/27 (P26/P27) | Phase 19 (TASK-P19-01 & TASK-P19-02) |
| **Katman Rolü** | **Director Oturum ve Karar Alan Modeli** | **Protokol Zarfı, Doğrulama ve Dağıtım Hattı** |
| **Çıktı / Veri Yapısı** | `DirectorAction` (LLM'in ürettiği saf niyet ve eylem tipi) | `DirectorActionEnvelope` (İmza, parmak izi, revizyon ve idempotency içeren tel protokolü zarfı) |
| **Güvenlik Otoritesi** | Director bağlam senkronizasyonu ve insan onayı motoru | Yetki doğrulaması, Zod şeması, sahte kimlik engelleme (`DirectorActionValidator`) |
| **Yürütme Entegrasyonu** | Karar motoru (`DirectorDecisionEngine`) ve oturum deposu | Dağıtım hattı (`DirectorActionPipeline`, `DirectorActionDispatcher`) |

> **Sonuç:** `src/director/` alan varlıklarını (Domain Entities) tanımlar; `src/director-action/` ise bu varlıkların güvenli biçimde taşındığı ve doğrulandığı protokol zarfı ve dağıtım hattıdır (Wire Protocol & Pipeline). `DirectorActionBuilder`, `DirectorAction`'ı alır ve `DirectorActionEnvelope` içine sarar.

### 2.3 `DirectorPromptBuilder` Ayrımı

1. **`src/director-reasoning/director-prompt-builder.ts` (Canonical):**
   - Director Reasoning Runtime'ın temel taşını oluşturur (TASK-P18-02).
   - Bağlam anlık görüntüsünü (`DirectorContextSnapshot`) alır; katı token bütçesi (`TokenBudgetOptions`), alan kırpma ve gizli bilgi temizliği (`sanitizeSecrets`) uygulayarak OpenAI / LLM JSON-schema uyumlu istem üretir.
   - Kök pakette `@aidm/core` üzerinden dışa aktarılan **birincil (canonical) `DirectorPromptBuilder`** sınıfıdır.
2. **`src/director/director-prompt-builder.ts` (Runtime Action Builder):**
   - Phase 27 (P27) kapsamında DirectorRuntime'a özgü tetikleyiciler (`DirectorReasoningTrigger`) ve doğrudan eylem teklif sözleşmesi için özelleştirilmiştir.
   - Kök pakette çakışmayı önlemek için **`DirectorActionPromptBuilder`** adıyla dışa aktarılır.

---

## 3. Değerlendirilen Seçenekler

- **Seçenek A — Körlemesine Modül Birleştirme:**
  - `src/budget` ve `src/token-budget`'ı tek bir dizine almak; `director` ve `director-action`'ı tek bir klasörde toplamak.
  - *Red Gerekçesi:* Tek Sorumluluk İlkesi (SRP) çiğnenir. Finansal muhasebe ile LLM token hesaplaması birbirine karışır. Zarf protokolü ile iş alanı mantığı iç içe geçer. Mevcut onlarca iç ve dış import kırılarak yüksek geriye dönük uyumsuzluk ve regresyon riski doğar.
- **Seçenek B — Durumu Belgesiz Bırakmak:**
  - Dosyaları mevcut haliyle bırakıp herhangi bir mimari sınır koymamak.
  - *Red Gerekçesi:* Geliştiriciler hangi modülü ne zaman tüketeceklerini bilemez; yanlışlıkla finansal bütçe yerine token bütçesi kullanılabilir veya kök export çakışmaları sessiz hatalara yol açabilir.
- **Seçenek C — Kesin Mimari Sınırlar, Canonical Roller ve Tam Subpath Kapsamı (Seçilen):**
  - Modüllerin bağımsız sorumluluklarını ADR ile kesinleştirmek.
  - Canonical sınıfları ve alias'ları kök dışa aktarımlarda açıkça sabitlemek.
  - `package.json` exports haritasındaki tüm alt yolları (`./authorization`, `./execution-integration` dahil) eksiksiz tanımlamak.
  - Geriye dönük uyumluluğu %100 korumak.

---

## 4. Alınan Kararlar

1. **Finansal Bütçe ve Token Bütçesi Ayrı Kalacaktır:**
   - Parasal harcama, bakiye, rezervasyon ve faturalandırma uç nokta denetimi için tek yetkili modül `packages/core/src/budget/` (`@aidm/core/budget`)'tir.
   - Prompt context window sınırları, token tahminleme ve P0-P4 öncelikli budama için tek yetkili modül `packages/core/src/token-budget/` (`@aidm/core/token-budget`)'tir.
2. **Director Alan Modeli ve Zarf Protokolü Ayrı Kalacaktır:**
   - Oturum yaşam döngüsü, insan onayı ve temel `DirectorAction` modeli `packages/core/src/director/` altındadır.
   - Eylemlerin zarflanması (`DirectorActionEnvelope`), Zod doğrulayıcısı ve dağıtım hattı `packages/core/src/director-action/` altındadır.
3. **Canonical İstem Oluşturucu:**
   - `@aidm/core` kökünden içe aktarılan `DirectorPromptBuilder`, `src/director-reasoning/director-prompt-builder.ts` sınıfıdır.
   - `src/director/director-prompt-builder.ts` sınıfı kök dışa aktarımda `DirectorActionPromptBuilder` adıyla sunulur.
4. **Eksiksiz Subpath Export Haritası:**
   - `packages/core/package.json` dosyasındaki `exports` haritası, `packages/core/src` altındaki tüm 32 fonksiyonel modülü eksiksiz kapsar.
   - `./authorization` ve `./execution-integration` yolları resmi olarak subpath haritasına eklenmiştir.
5. **Geriye Dönük Uyumluluk Garantisi:**
   - Mevcut hiçbir alt yol veya kök dışa aktarım kaldırılmamış ya da imzası değiştirilmemiştir.

---

## 5. Sonuçlar ve Geçiş Planı

- **Derleme Zamanı Güvenliği:** Kök dışa aktarımlarda isim çatışmaları (`DirectorActionError`, `DirectorPromptBuilder`) açık re-export tanımlarıyla çözümlenmiş ve `tsc -b` ile doğrulanmıştır.
- **Tüketici Kolaylığı:** Modül tüketicileri hem alt yolları (`@aidm/core/budget`, `@aidm/core/token-budget`) hem de kök paketi (`@aidm/core`) tutarlı biçimde kullanabilir.
- **Geçiş Gereksinimi:** Hiçbir mevcut kodun değiştirilmesi gerekmez; sıfır breaking change ile tam uyumluluk sağlanmıştır.
