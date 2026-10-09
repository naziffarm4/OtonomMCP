# OtonomMCP (AIDM) — OM-10 Öncesi Teknik Borç ve Kabul Kapısı Takip Raporu

**Belge Kodu:** AIDM-DOC-TECHDEBT-GATE  
**Sürüm:** 1.0.0  
**Tarih:** 2026-10-09  
**Hedef:** OM-10 Öncesi Teknik Borç, Depo Hijyeni ve Kabul Açıklarının Doğrulanması, Çözümlenmesi ve Mühürlenmesi  
**Kural:** OM-10'a geçilmeden önce tüm teknik borçlar doğrulanmalı, kanıtlanmalı; harici koşul eksikliği durumunda dürüstçe `BLOCKED` işaretlenmeli ve sahte kabul üretilmemelidir.

---

## 1. Başlangıç Durum Tespiti ve Bulgular Matrisi

| No | Alan | İddia / Konu | İlk Durum | Sınıf | İnceleme ve Kanıt Notu |
|:---|:---|:---|:---:|:---:|:---|
| B-01 | Node.js Sözleşmesi | `node:sqlite` ve `--experimental-strip-types` kullanımı Node 18 ile uyumsuz | Node 18 docs var, fiili runtime v22.19.0, `engines` eksik | `CONFIRMED` | `node:sqlite` Node >=22.5.0, `--experimental-strip-types` Node >=22.6.0 gerektirir. Node 18 desteği teknik olarak imkansızdır. |
| B-02 | Depo Hijyeni | LICENSE, .gitattributes, .editorconfig, CI workflow eksik | Dosyalar mevcut değil | `CONFIRMED` | MIT LICENSE, LF odaklı .gitattributes, .editorconfig ve GitHub Actions CI oluşturulmalı. |
| B-03 | .gitignore | `.mcp-protect-*`, `coverage/`, `.vscode/`, `.idea/`, `.DS_Store` eksik, tekrarlar mevcut | Eksik kurallar var | `CONFIRMED` | `.mcp-protect-*` ve IDE/sistem desenleri eklenecek, gereksiz alt satırlar temizlenecek. |
| B-04 | Tip Kontrolü | Kök `typecheck` komutu yalnızca `build` yapıyor; testler tip kontrolünde yok | `package.json` satır 8: `pnpm --filter @aidm/core build`, `tsconfig.json` `tests` hariç | `CONFIRMED` | `tsconfig.test.json` oluşturulup `typecheck` komutu gerçek `tsc --noEmit` yapacak şekilde ayrıştırılmalı. |
| B-05 | Deterministik Test | Varsayılan test süitinde canlı LLM / agy çağrıları çöküyor veya deterministik değil | 2987 PASS, 4 FAIL (`antigravity-real-executor`, `p10-06`, `real-evidence`, `single-task`) | `CONFIRMED` | Canlı AGY CLI ve dış servis bağımlılıkları `AIDM_LIVE_E2E=1` opt-in bayrağına ve `pnpm test:live` komutuna bağlanmalı; varsayılan `pnpm test` %100 çevrimdışı ve deterministik olmalı. |
| B-06 | Ortam Değişkenleri | `.env.example` eksik, öncelik ve üretim davranışları belgesiz | `.env.example` yalnızca 49 bayt | `CONFIRMED` | Tam ortam değişkeni sözleşmesi ve dokümantasyonu oluşturulmalı. |
| B-07 | Modül Yinelenmesi | `director` ↔ `director-action`, `budget` ↔ `token-budget`, geniş `export *` | Çoklu yinelenen export ve sorumluluk | `CONFIRMED` | ADR-12 ile modül sınırları belirlenip geriye dönük uyumla yönetilmeli. |
| B-08 | Tür Güvenliği Borcu | Kod tabanında yoğun `any` kullanımı | ~360+ adet `any` mevcut | `CONFIRMED` | Kritik güvenlik/yetki/delil modüllerinde `any` temizlenmeli ve ESLint uyarısı devreye alınmalı. |
| B-09 | Yapılandırılmış Loglama | MCP stdio JSON-RPC çıktısının loglarla bozulma riski | Ham `console` çıktıları mevcut | `CONFIRMED` | stdio MCP protokolünün bozulmaması için stderr/dosya yönlendirmeli ve gizli bilgi temizleyen loglama sözleşmesi mühürlenmeli. |
| B-10 | OM Kabul Açıkları | OM-03/05/06/07/09 canlı ortam kanıtları | Mock testler mevcut, canlı ortam kanıtı eksik | `CONFIRMED` | Kabul matrisi hazırlanmalı; harici API/CLI eksikliği olan canlı kriterler `BLOCKED` işaretlenmeli. |

---

## 2. İş Paketleri Durum Özeti

- [ ] **WP-1: Node.js ve Depo Hijyeni** (Sözleşme, engines, .nvmrc, LICENSE, .gitattributes, .editorconfig, .gitignore, CI, doküman düzeltmeleri)
- [ ] **WP-2: Gerçek Tip Kontrolü ve Deterministik Testler** (tsconfig.test.json, kök script'leri, test:live ayrımı)
- [ ] **WP-3: Ortam Değişkenleri ve Yapılandırma Sözleşmesi** (.env.example, ENVIRONMENT dokümantasyonu, fail-closed sözleşmesi)
- [ ] **WP-4: Yinelenen Modüller ve Dışa Aktarımlar** (ADR-12, export temizliği, geriye dönük uyumluluk)
- [ ] **WP-5: Tür Güvenliği Borcu** (Kritik modüllerde any azaltımı, tip doğrulama)
- [ ] **WP-6: Yapılandırılmış Loglama** (MCP stdio protokol bütünlüğü, log seviyeleri, sır maskeleme)
- [ ] **WP-7: OM-03/05/06/07/09 Kabul Matrisi ve Karar Kapısı** (Objektif kabul matrisi ve OM-10 nihai kararı)
