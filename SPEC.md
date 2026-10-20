# SPEC: AIDM Universal Project Bootstrap & Scaffolding Engine

## 1. Amaç ve Kapsam (Objective)
Bu şartname, `UNIVERSAL-PROJECT-BOOTSTRAP-SPEC.md` belgesinde tanımlanan "Zero-Monolith Law" ve "Evrensel İskelet Kurulum Protokolü"nün AIDM (`@aidm/core`) çekirdek motoruna entegre edilmesini tanımlar.

### Temel Hedefler:
1. **Zero-Monolith Güvencesi:** Boş veya yapılandırılmamış bir depoda (`STATUS = UNINITIALIZED`), iş kuralları (`REQ-xxx`) kodlanmadan önce resmi çatı iskeletinin (`TASK-000: SCAFFOLD_PROJECT`) kurulmasını zorunlu kılmak. Kodların tek bir geçici dosyaya (`src/index.ts`, `main.py` vb.) yığılmasını önlemek.
2. **Çoklu Çalışma Zamanı (Multi-Runtime) Manifest Taraması:** Node.js/TS, Python, Go, Rust, Java/Kotlin, .NET/C#, PHP ve Mobil (Flutter/RN) manifestlerini tanımak.
3. **Dinamik Teknoloji Şeması Çıkarımı:** Şartnameden JSON tabanlı teknoloji yığını ve non-interactive kurulum komutunu türetmek.
4. **DAG Zorlama (Dependency Enforcement):** `TASK-000` tamamlanıp doğrulanana kadar sonraki tüm iş mantığı görevlerinin (`TASK-001`, `TASK-002`, ...) başlamasını engellemek (`dependencies: ["TASK-000"]`).
5. **Evrensel Sağlık Kapısı (Health Verification Gate):** İskelet kurulduktan sonra syntax/type-check, lint ve build komutlarıyla sıfır hata doğrulaması yapmak.
6. **Dinamik Dizin Ağacı Eşleme (Scope Remap):** İskelet oluştuktan sonra iş mantığı görevlerinin hedef dosya yollarını gerçek çatı dizinlerine (`app/`, `routers/`, `cmd/`, `components/`) yönlendirmek.
7. **Ajan Yönergesi (Critical Directive):** LLM Director ve Executor istemlerine Zero-Monolith kurallarını enjekte etmek.

---

## 2. Kabiliyet Haritası ve Uygulama Sırası (Capability Map & Build Order)

```text
[Modül 1: Manifest & Repo Scanner]
           │
           ▼
[Modül 2: Tech Stack Schema Extractor]
           │
           ▼
[Modül 3: TASK-000 Scaffolding Task Generator & DAG Enforcer]
           │
           ▼
[Modül 4: Universal Health Gate Validator]
           │
           ▼
[Modül 5: Scope Remapper & Workspace Re-Indexer]
           │
           ▼
[Modül 6: Director Directive & Prompt Injection]
```

### Modül Detayları:
- **MOD-01 (Manifest Scanner):** `packages/core/src/adapters/project-adapter.ts` veya `repo-manifest-scanner.ts`
  - Standart 8 ekosistem (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `*.csproj`, `composer.json`, `pubspec.yaml`, `platformio.ini`) ve özel derleme manifestlerini (`Makefile`, `BUILD.bazel`, `CMakeLists.txt`, `turbo.json`) tarar.
  - Hiçbiri yoksa veya boşsa repo durumunu `UNINITIALIZED` olarak işaretler.
- **MOD-02 (Tech Stack Extractor):** `packages/core/src/autonomous/tech-stack-extractor.ts`
  - Şartnamedeki `TECH`, `PURPOSE`, `REQUIREMENTS` bölümlerinden runtime, framework, build_system (standart veya make/bazel/cmake), paket yöneticisi ve non-interactive bootstrap komutunu tespit eder.
  - Web/Backend, Mobil (Flutter, Expo) ve Gömülü (PlatformIO, Rust no_std) için platform bazında test edilmiş `--yes` ve unattended bayrak şablonları sunar; güven skoru hesaplar.
- **MOD-03 (TASK-000 & DAG Enforcer):** `packages/core/src/autonomous/spec-ingestor.ts` & `autonomous-runner.ts`
  - Repo `UNINITIALIZED` ise otomatik olarak `TASK-000` (Universal Project Scaffolding) ekler (`task_class: SCAFFOLD`, `priority: BLOCKING_PREREQUISITE`).
  - **Boş Dizin Garantisi, İzin ve Staging Yöneticisi (`scaffold-executor.ts`):**
    - Kök dizindeki `SPEC.md`, `.git`, `.ai-manager` varlığında izole staging (`.tmp-scaffold`) deseni kullanır.
    - CLI'ın oluşturduğu geçici `.tmp-scaffold/.git` klasörünü silerek kökteki ana git geçmişinin ezilmesini önler.
    - Shell betikleri (`*.sh`) ve derleme sarmalayıcılarının (`gradlew`, `mvnw`) POSIX `0o755` (`chmod +x`) izinlerini atomik terfi sırasında korur.
    - Kök dışına sızan sembolik bağları (*Symlink Path Traversal*) denetler ve engeller.
  - Tüm sonraki `TASK-001+` görevlerine `"dependencies": ["TASK-000"]` ekler.
  - `autonomous-runner.ts` içindeki kuyruk mantığını `TASK-000` onaylanmadan diğer görevlerin çalıştırılmayacağı şekilde doğrular.
- **MOD-04 (Universal Health Gate):** `packages/core/src/autonomous/web-checks.ts` & `evidence/`
  - Kurulan çatıya özgü derleme, tip denetimi ve lint komutlarını (örn. `pnpm typecheck`, `poetry run mypy .`, `cargo check`, `flutter analyze`, `pio run`, `make check`) `TASK-000` doğrulama kapısına ekler.
- **MOD-05 (Scope Remapper):** `packages/core/src/autonomous/autonomous-runner.ts`
  - `TASK-000` başarıyla `ACCEPTED` olduktan sonra diskteki gerçek dizin ağacını tarar (`app/`, `src/`, `routers/`, `lib/` vb.).
  - İş mantığı görevlerinin `targetFiles` alanlarını bu dizinlere göre günceller.
- **MOD-06 (Agent Directives):** `packages/core/src/director/director-prompt-builder.ts` & `spec-clarification.ts`
  - Şartname Bölüm 10'daki `CRITICAL DIRECTIVE FOR THE AUTONOMOUS AGENT` metnini sistem istemlerine ekler.

---

## 3. Komutlar (Commands)

- **Tip Denetimi:** `pnpm --filter @aidm/core typecheck`
- **Birim & Entegrasyon Testleri:** `pnpm --filter @aidm/core test`
- **Derleme:** `pnpm --filter @aidm/core build`
- **Lint:** `pnpm lint`
- **Otonom Test Çalıştırma:** `node packages/core/bin/aidm.js run --spec <spec-path>`

---

## 4. Proje Yapısı ve Etkilenecek Dosyalar (Project Structure)

```text
packages/core/src/
├── adapters/
│   ├── project-adapter.ts          # [Güncellenecek] 8 ekosistem + özel manifest tespiti
│   └── build-adapter.ts            # [Genişletilecek] Çoklu çatı derleme desteği
├── autonomous/
│   ├── spec-ingestor.ts            # [Güncellenecek] TASK-000 üretimi ve DAG bağımlılıkları
│   ├── tech-stack-extractor.ts     # [YENİ] Dinamik teknoloji şeması ve test edilmiş CLI şablonları
│   ├── scaffold-executor.ts        # [YENİ] Boş dizin garantisi, dosya izinleri ve Isolated Staging
│   ├── autonomous-runner.ts        # [Güncellenecek] DAG enforcing & post-scaffold scope remap
│   └── spec-clarification.ts       # [Güncellenecek] Directive ve netleştirme entegrasyonu
├── director/
│   └── director-prompt-builder.ts  # [Güncellenecek] Zero-Monolith kural istemi enjeksiyonu
└── task-engine/
    └── dag-engine.ts               # [Doğrulama] TASK-000 bağımlılık sıralaması
```

---

## 5. Kodlama ve Mimari Standartları (Code Style & Standards)

1. **Katı Tiplendirme:** `any` kullanılmaz; `Zod` ve TypeScript `strict` kurallarına tam uyum.
2. **Determinizm ve Offline Güvenlik:** `SpecIngestor` deterministik kalır; LLM çıktısına bağımlı olmadan çalışabilir.
3. **Kapsam Güvenliği (Path Traversal Koruması):** İskelet dosyaları proje kök dizini sınırları içinde tutulur; `.git` ve `.ai-manager` dizinleri korunur.
4. **Geriye Dönük Uyumluluk:** Zaten başlatılmış (mevcut `package.json` bulunan) repolarda `TASK-000` zorlanmaz, mevcut akış kesintisiz devam eder.
5. **Boş Dizin Garantisi ve Çakışma Direnci:** `create-next-app` veya `npm create vite` gibi araçların mevcut dosyalarla çakışmasını engellemek için izole staging (`.tmp-scaffold`) deseni kullanılır; kökteki `SPEC.md` gibi dosyalar asla ezilmez.
6. **Dosya İzinleri ve Öznitelik Bütünlüğü:** Yürütülebilir dosyaların (`gradlew`, `*.sh`) POSIX `0o755` izinleri taşınırken korunur; Windows'ta kilitli öznitelikler açılır; kök dışı sembolik bağlar engellenir.

---

## 6. Test Stratejisi (Testing Strategy)

1. **Manifest Scanner Testi:**
   - Boş klasör -> `STATUS = UNINITIALIZED`
   - `package.json` olan klasör -> `STATUS = INITIALIZED` (Node)
   - `pyproject.toml`, `go.mod`, `Cargo.toml`, `pubspec.yaml`, `platformio.ini`, `Makefile` tespit testleri.
2. **Tech Stack Extractor Testi:**
   - Markdown metninden Next.js, FastAPI, Go, Rust, Flutter, Expo, PlatformIO, Makefile şemalarının doğru JSON'a dönüştürülmesi.
   - Bilinmeyen veya eksik çatılarda düşük güven skoru üretilmesi.
3. **SpecIngestor TASK-000 & DAG Testi:**
   - Boş repo durumunda `tasks[0].task_id === 'TASK-000'`.
   - `tasks[1..n].dependencies` içinde `'TASK-000'` bulunması.
   - Zaten başlatılmış repolarda `TASK-000` oluşturulmaması veya atlanması.
4. **Autonomous Runner Döngü & Doğrulama Testi:**
   - `TASK-000` onaylanmadan `TASK-001`'in başlatılamamasının simülasyonu.
   - İskelet oluştuktan sonra dosya ağacının yeniden indekslenmesi.
5. **Çakışma Önleme ve Staging Testi (Conflict Resilience Test):**
   - Kök dizinde `SPEC.md` ve `.git/` varken `TASK-000` iskelet kurulumunun hatasız tamamlanması ve dosyaların korunması testi.
6. **İzin ve Git Hijack Koruma Testi:**
   - Staging'de oluşan `.git` dizininin ana depoyu ezmemesi ve yürütülebilir dosyaların (`gradlew`, `*.sh`) `+x` izinlerinin korunması testi.

---

## 7. Sınırlar ve Kurallar (Boundaries)

### Always (Her Zaman Yapılacaklar):
- Çalışma alanında manifest yoksa iş kodlarının yazılmasını engelle.
- `TASK-000` için `implementation_scope: ["*"]` ve `max_file_modifications: 250` sınırını uygula.
- Bağımsız doğrulama kanıtı (System Evidence) topla; ajanın "kuruldu" iddiasını doğrudan kabul etme.
- İskelet araçları için platform bazında test edilmiş `--yes` / unattended bayraklarını zorunlu kıl.
- Kök dizinde önceden var olan dokümantasyon veya git dosyaları varsa çakışmayı önlemek için Isolated Staging protokolünü uygula.
- Staging'den dosya taşırken yürütülebilir (`0o755`) izinleri koru ve staging içinde oluşan alt `.git` dizinlerini derhal temizle.

### Ask First (Önce Kullanıcıya Sorulacaklar):
- Güven skoru 0.9'un altındaki bilinmeyen veya özel derleme sistemlerinde (Makefile/Bazel/özel CLI) internet araması yapılamıyorsa onay/seçim iste.
- Mevcut bir projenin kök dizininde çakışan veya geçersiz manifestler tespit edildiğinde temizleme/ezme onayı.

### Never (Asla Yapılmayacaklar):
- İskelet kurulmadan `src/index.ts` veya `main.py` içine tüm projeyi sıkıştırmak (Zero-Monolith ihlali).
- `TASK-000` sağlık kapısından (build/lint/type-check) geçmeden `TASK-001`'e geçmek.
- İskelet komutlarını etkileşimli (`interactive`) modda terminali kilitleyecek şekilde çalıştırmak.
- İskelet oluşturulurken kök dizindeki mevcut `SPEC.md`, `.git` veya `.ai-manager` dosyalarını silmek veya ezmek.
- Proje kök dizini sınırları dışına çıkan sembolik bağları (symlinks) kabul etmek.
