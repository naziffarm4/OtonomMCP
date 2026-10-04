# OtonomMCP (AIDM) — Bağlayıcı Mimari Karar Kayıtları (DECISIONS.md)

**Belge Kodu:** AIDM-DOC-ADR  
**Sürüm:** 1.0.0  
**Tarih:** 2026-10-04  
**Kapsam:** OtonomMCP Geliştirme Sürecinde Alınmış ve Halen Bağlayıcı Olan Tüm Temel Mimari Kararlar (ADR)

---

## ADR-01: Bağımsız Çekirdek ve Sıfır Dış Çalışma Bağımlılığı
- **Tarih:** 2026-10-01 (P18-00)
- **Karar:** AIDM çekirdeği harici bir veritabanı (Postgres/Redis), harici bulut servisi veya ağ soketi gerektirmeksizin Node.js 18+ yerel modülleri ve yerleşik SQLite ile çalışacaktır.
- **Gerekçe:** Geliştiricinin kendi yerel makinesinde sıfır altyapı maliyeti ve tam veri egemenliği sağlamak.

---

## ADR-02: SQLite Atomik Bütçe Motoru ve Nano-USD Hassasiyeti
- **Tarih:** 2026-10-02 (P18-03)
- **Karar:** Token ve maliyet bütçesi SQLite veritabanında `BigInt` (Nano-USD, $1 = 1.000.000.000 nUSD) cinsinden tutulacaktır. Her LLM çağrısından önce zorunlu `HOLD` rezervasyonu yapılacak, yanıt sonrası `SETTLE` edilecek; yetersiz bakiyede `BUDGET_EXCEEDED` hatasıyla ağ çağrısı engellenecektir.
- **Gerekçe:** Kayan noktalı sayı (floating-point) yuvarlama hatalarını önlemek ve modelin bütçeyi aşmasını fail-closed olarak durdurmak.

---

## ADR-03: Tekil Kullanıcı Arayüzü — Yalnızca Director
- **Tarih:** 2026-10-04 (DIRECTOR-INTERACTION-01 / 02)
- **Karar:** Kullanıcının doğal dil ile konuşacağı tek muhatap ChatGPT Director'dır. AIDM veya AGY için IDE içinde ikinci bir sohbet penceresi, ayrı bir GUI veya CLI etkileşim modu açılmayacaktır.
- **Gerekçe:** Kullanıcının kafa karışıklığını önlemek, tekil karar hiyerarşisini korumak ve sahte yetki yükseltme saldırılarını engellemek.

---

## ADR-04: Proje A ve Proje B Ayrımı ("Önce A, Sonra B")
- **Tarih:** 2026-10-04 (A_CURRENT_STATE_AUDIT)
- **Karar:** Proje A (AIDM Çekirdeği) ile Proje B (Bağımsız Yerel Onay Uygulaması) iki ayrı proje olarak yönetilecektir. Proje A tamamlanıp dondurulmadan (FROZEN) Proje B geliştirmesi başlamayacaktır.
- **Gerekçe:** Çekirdek orkestratörün tamamlanmasını geciktirmemek, iki projenin kod tabanlarını birbirine karıştırmamak ve A'nın B olmadan da rutin işleri yürütebilmesini garanti etmek.

---

## ADR-05: P22 Adlandırma Çakışmasının Çözümü
- **Tarih:** 2026-10-04 (A_CURRENT_STATE_AUDIT Bölüm 5)
- **Karar:** Git geçmişinde `744f2c2` nolu commit'te "P22" adı Trusted IDE Authentication için kullanılmıştı. Resmî ana plana göre bu çakışma kesin olarak çözülmüştür:
  - **P22 (Proje A):** `Director MCP Control Plane` (A5 aşaması — Director'ın kullanacağı üst düzey MCP kontrol araçları).
  - **Trusted IDE Authentication / Dış Onay:** Proje A kapsamından çıkarılmış ve gelecekteki **Proje B** kapsamına devredilmiştir.

---

## ADR-06: IDE İçi Onay Mekanizmasının Reddi (TRUST-ROOT-08 KESİN NO-GO)
- **Tarih:** 2026-10-04 (TRUST-ROOT-08)
- **Karar:** Antigravity IDE sohbeti veya `default_api:ask_question` aracı üzerinden insan onayı alınması yaklaşımı kesin olarak reddedilmiştir. P18-04 ve P20 Check 6 kapısı bağımsız bir out-of-band güven kökü olmadan açılamaz ve fail-closed kalacaktır.
- **Gerekçe:** AGY'nin aradaki tek iletişim hattı (in-band proxy) olması sebebiyle soru tahrifatı ve onay taklidinin matematiksel olarak engellenememesi.

---

## ADR-07: Sağlayıcıdan Bağımsız Wire Formatı ve Telemetri Ayrıştırması
- **Tarih:** 2026-10-04 (A2)
- **Karar:** `ReferenceLlmAdapter`, OpenAI Chat Completions API formatı ile iç referans formatını `wireFormat: 'auto' | 'openai' | 'reference'` bayrağı ile dinamik olarak yönetecektir. OpenAI uç noktasına kök düzeyinde fazlalık metaveri gönderilmeyecek; `prompt_tokens_details.cached_tokens` ve `completion_tokens_details.reasoning_tokens` alanları telemetriye dahil edilecektir.
- **Gerekçe:** Canlı LLM sağlayıcılarında HTTP 400 Bad Request hatalarını önlemek ve önbellek/muhakeme maliyet uzlaştırmasını kuruşu kuruşuna doğru yapmak.

---

## ADR-08: Rutin Mandate Görevlerinin Bağımsız Yürütülmesi
- **Tarih:** 2026-10-04 (A_INTEGRATION_CONTRACT)
- **Karar:** Proje A, dış onay sağlayıcısı mevcut olmadığında da Project Mandate kapsamındaki rutin ve yetkilendirilmiş geliştirme görevlerini (`ALLOW`) otonom olarak yürütmeye devam edecektir. Yalnızca insan onayı gerektiren durumlarda fail-closed bekleyecektir.
- **Gerekçe:** Dış onay uygulamasının yokluğunun, rutin kod yazma ve test yürütme kabiliyetlerini kilitlemesini önlemek.

---

## ADR-09: Tek Çalışma Alanı PID Kilitlenmesi ve Zombi Önleme
- **Tarih:** 2026-10-02 (P18-02)
- **Karar:** `.ai-manager/runtime.lock` dosyası PID tabanlı doğrulanacak; çalışan canlı bir süreç varken ikinci bir instance başlatılamayacaktır. Zombie process takeover yapılmayacak; eski kilitler yalnızca sürecin öldüğü işletim sistemi düzeyinde (`process.kill(pid, 0)`) teyit edildikten sonra temizlenecektir.
- **Gerekçe:** Eşzamanlı iki AIDM sürecinin dosya sistemini ve SQLite bütçe tabanını bozmasını engellemek.
