# OtonomMCP — AI Development Manager (AIDM)

OtonomMCP (AIDM), yazılım projelerinde otonom geliştirme yaşam döngüsünü (Director ↔ Orkestratör ↔ Uygulayıcı) güvenli sınırlar, deterministik harcama bütçesi ve bağımsız kanıt doğrulaması altında yöneten kurumsal düzeyde bir orkestrasyon motorudur.

Antigravity IDE içinde Model Context Protocol (MCP) `stdio` protokolü üzerinden çalışır.

---

## 📚 Temel Dokümantasyon

Projenin tüm mimari, operasyonel ve güvenlik dokümantasyonu `docs/` dizini altında 5 ana belgede toplanmıştır:

1. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
   *Sistem Mimarisi ve Bileşen Tasarımı.* Çekirdek modüller, veri akışı, kapalı döngü koordinatörü ve çalışma zamanı modeli.
2. **[docs/ROADMAP.md](docs/ROADMAP.md)**
   *Resmî Tamamlama Yol Haritası.* A1'den A8'e aşama bazlı güncel durumlar, eksik işler, kabul kriterleri ve Proje A dondurma (FROZEN) koşulları.
3. **[docs/INTEGRATION.md](docs/INTEGRATION.md)**
   *Dış Entegrasyon Sözleşmesi.* Dış onay sağlayıcıları için normatif JSON veri yükleri, kanonik SHA-256 hash formülü ve Check 6 güvenlik kapısı şartnamesi.
4. **[docs/SECURITY.md](docs/SECURITY.md)**
   *Güvenlik Modeli ve Tehdit Sınırları.* Windows NT DAC sınırları, bant içi proxy riski, kör imza sınırlamaları ve fail-closed güvenlik kapıları.
5. **[docs/DECISIONS.md](docs/DECISIONS.md)**
   *Bağlayıcı Mimari Karar Kayıtları (ADR).* Alınmış ve bağlayıcılığı devam eden tüm temel mimari kararlar.

---

## 🚀 Hızlı Başlangıç

### Gereksinimler
- **Node.js:** `>= 18.0.0` (Doğrulanan: `v22.19.0`)
- **Paket Yöneticisi:** `pnpm >= 9.0.0` (Doğrulanan: `12.3.4`)
- **İşletim Sistemi:** Windows 10/11 x64

### Kurulum
```bash
pnpm install
```

### Derleme (Build)
```bash
pnpm build
```

### Testleri Çalıştırma (100 Test Süiti / 2.482 Test)
```bash
pnpm test
```

---

## 🔒 Güvenlik İlkesi

OtonomMCP, bağımsız ve güvenilir bir insan onay kanıtı bulunmadığı sürece insan onayı gerektiren tüm eylemlerde **kesin olarak duraklar (`FAIL-CLOSED` / `BLOCKED_ON_AUTH_CONTEXT`)**. Project Mandate kapsamındaki yetkilendirilmiş rutin görevler (`ALLOW`) ise harici sağlayıcı olmadan da tam otonom olarak yürütülür.
