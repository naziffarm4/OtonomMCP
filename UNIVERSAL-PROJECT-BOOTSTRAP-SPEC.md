# UNIVERSAL-PROJECT-BOOTSTRAP-SPEC: Otonom Ajan ve AIDM İçin Çatıdan Bağımsız Proje İskeleti Şartnamesi

Bu belge, **AIDM (AI Directed Management)**, otonom planlama motorları ve LLM tabanlı yazılım ajanlarının (Executor/Director) herhangi bir programlama dili veya çatıya (framework) bağlı kalmaksızın, verilen proje gereksinimlerine göre **doğru mimari iskeleti sıfırdan kurmasını** sağlayan evrensel operasyon protokolüdür.

---

## 1. Temel Kural ve Bağlayıcı İlke (Zero-Monolith Law)

1. **İskelet Olmadan İş Mantığı Yazılamaz:** Çalışma dizininde hedef teknolojiye ait resmi yapılandırma ve bağımlılık dosyaları (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` vb.) yoksa, hiçbir iş kuralı (`REQ-xxx`) doğrudan kodlanamaz.
2. **Tek Dosyaya Sıkıştırma Yasağı:** Proje iskeleti eksik olduğu için iş kurallarını ve arayüzü tek bir geçici dosyaya (`src/index.ts`, `main.py`, `app.js` vb.) toplamak kesinlikle yasaktır.
3. **Öncelikli Aşama (Phase 0):** İş kurallarının ayrıştırılmasından (`aidm_task_decompose`) önce mutlaka bağımsız bir **İskelet Kurulum Aşaması (`TASK-000: SCAFFOLD_PROJECT`)** çalıştırılmalı ve doğrulanmalıdır.

---

## 2. LLM Algoritması: Adım Adım İskelet Hattı (Scaffolding Pipeline)

```text
[Gereksinim Belgesi (.md)] 
           │
           ▼
[Adım 1: Teknoloji ve Repo Taraması] ──► Repo Hazır mı? ──► EVET ──► [İş Görevlerine Başla (TASK-001)]
           │ (Hayır / Boş Repo)
           ▼
[Adım 2: Teknoloji Şemasını Çıkar (JSON)]
           │
           ▼
[Adım 3: Teknoloji Biliniyor mu?] ──► HAYIR ──► [İnternetten Resmi Dokümantasyonu Araştır]
           │ (Evet / Araştırıldı)
           ▼
[Adım 4: TASK-000 İskelet Görevini Başlat] (Kapsam: ["*"], Limit: 200 Dosya)
           │
           ▼
[Adım 5: Sağlık Kapısı Doğrulaması] (Build / Type-Check / Lint = Sıfır Hata)
           │
           ▼
[Adım 6: Ağacı Yeniden İndeksle ve İş Mantığını Gerçek Klasörlere Dağıt]
```

---

## 3. Adım 1: Repo Durumu ve Manifest Taraması

LLM, işe başlamadan önce çalışma alanının kök dizinini tarar:

| Dil / Çalışma Zamanı | Manifest Dosyaları (En Az Biri Olmalıdır) |
| :--- | :--- |
| **Node.js / TypeScript / Web** | `package.json`, `tsconfig.json` |
| **Python** | `pyproject.toml`, `setup.py`, `requirements.txt`, `Pipfile` |
| **Go** | `go.mod` |
| **Rust** | `Cargo.toml` |
| **Java / Kotlin** | `pom.xml`, `build.gradle`, `build.gradle.kts` |
| **.NET / C#** | `*.csproj`, `*.sln` |
| **PHP** | `composer.json` |
| **Mobil (Flutter / React Native)** | `pubspec.yaml`, `app.json`, `package.json` |

* **Sonuç:** Yukarıdaki dosyalardan hiçbiri kök dizinde yoksa veya dosya içeriği boş bir taslaktan ibaretse, repo durumu `STATUS = UNINITIALIZED` olarak işaretlenir ve derhal **Adım 2**'ye geçilir.

---

## 4. Adım 2: Dinamik Teknoloji Şeması Çıkarımı

LLM, proje şartnamesini inceleyerek aşağıdaki evrensel JSON veri yapısını doldurur. Değerler asla sabit (hardcoded) değildir; metinden dinamik olarak çıkarılır:

```json
{
  "project_name": "<proje-adi-kebab-case>",
  "runtime": "node | python | go | rust | java | dotnet | php",
  "language": "typescript | javascript | python | go | rust | csharp | kotlin",
  "framework": "<hedef-framework-adi: nextjs | vite-react | fastapi | nestjs | gin | actix-web | django | vue | sveltekit>",
  "router_or_architecture": "<varsa: app-router | pages-router | clean-architecture | mvc>",
  "styling": "<varsa: tailwind | vanilla-css | css-modules | bootstrap | none>",
  "ui_components": "<varsa: shadcn-ui | mui | ant-design | none>",
  "database_orm": "<varsa: supabase | prisma | drizzle | sqlalchemy | gorm | none>",
  "package_manager": "pnpm | npm | yarn | poetry | pipenv | cargo | go-modules",
  "scaffold_command": "<otomatik-belirlenecek-veya-arastirilacak-komut>",
  "confidence_score": 0.0 - 1.0
}
```

---

## 5. Adım 3: Bilinmeyen veya Yeni Teknolojiler İçin Web Araştırma Protokolü

Eğer LLM, çıkarılan teknoloji yığınının güncel başlatma komutunu, en son sürüm parametrelerini veya dizin yapısını kesin olarak bilmiyorsa (`confidence_score < 0.9` veya yeni/bilinmeyen bir kütüphane ise), **özerk araştırma protokolünü** devreye sokar:

### 5.1. Arama Stratejisi ve Sorgu Formatı
Ajan, `search_web` veya dokümantasyon okuma aracını kullanarak yalnızca **resmi kaynakları** hedefler:
* **Sorgu Şablonu:**  
  `"<framework_adi> official documentation create new project CLI non-interactive <en-son-yil>"`  
  *Örnek:* `"Next.js official docs create-next-app non-interactive flags 2026"`  
  *Örnek:* `"FastAPI official project template cookiecutter poetry 2026"`  
  *Örnek:* `"Astro create astro command flags documentation"`

### 5.2. Araştırmada Aranacak Zorunlu Bilgiler
1. **Non-interactive / Unattended Flag:** Kullanıcıya soru sormadan, terminalde takılmadan (`--yes`, `-y`, `--default`, `--no-git` vb.) kurulumu tamamlayan bayraklar.
2. **Geçerli Dizine Kurulum Sözdizimi:** Projeyi bir alt klasöre açmak yerine mevcut dizine kurma parametresi (genellikle `./` veya `.`).
3. **Resmi Klasör Hiyerarşisi:** Kurulum bittiğinde hangi dizinlerin oluşması gerektiği (`app/`, `src/`, `components/`, `routes/` vb.).

### 5.3. Boş Dizin Garantisi, Dosya İzinleri ve Çakışma Önleme Protokolü (Safe Staging & Atomic Promote)
Birçok modern iskelet aracı (`create-next-app`, `npm create vite`, `cargo init` vb.), hedef dizinde `.git`, `.ai-manager`, `SPEC.md` veya `README.md` gibi dosyalar bulunduğunda ya hata vererek durur (`directory is not empty and contains files that could conflict`) ya da etkileşimli soru sorarak (`Ok to proceed? (y/N)`) otonom süreci kilitler.

Bu riski bertaraf etmek için **dört aşamalı koruma protokolü** uygulanır:

1. **Pre-flight Dizin Analizi (Tolerans Matrisi):**
   - Kök dizindeki mevcut dosyalar taranır.
   - Sadece güvenli yönetim/dokümantasyon dosyaları (`.git/`, `.ai-manager/`, `*.md`, `.gitignore`, `.env*`, `LICENSE`) varsa dizin mantıksal olarak **`CLEAN_BOOTSTRAP_ELIGIBLE`** kabul edilir.
   - Eğer dizinde daha önceden var olan kaynak kodlar veya yabancı manifestler (`package.json`, `Cargo.toml`, `pyproject.toml`) varsa işlem durdurulur ve kullanıcıya `CONFLICT_DETECTED` bildirimi yapılır.

2. **İzole Hazırlık ve Güvenli Terfi Deseni (Isolated Staging & Atomic Promote Pattern):**
   - Hedef iskelet CLI'ı mevcut dizinde dosya varken doğrudan çalışmayı desteklemiyorsa veya `--yes` bayrağı çakışmayı aşamıyorsa:
     a. Çalışma alanının içinde geçici bir izole klasör oluşturulur: `.tmp-scaffold/`
     b. CLI komutu bu geçici klasör içinde tam non-interactive modda çalıştırılır (`npx create-next-app@latest .tmp-scaffold --yes ...`).
     c. **Staging Temizliği (Git Hijack Koruması):** CLI aracı `.tmp-scaffold/` içinde kendi başına bir `.git` reposu oluşturduysa, kök dizindeki ana deponun geçmişini bozmaması için bu staging `.git` dizini terfi öncesinde silinir (`rm -rf .tmp-scaffold/.git`).
     d. **Atomik Taşıma:** `.tmp-scaffold/` içindeki dosyalar kök dizine taşınır. Kök dizindeki `SPEC.md`, `.git/`, `.ai-manager/` ve `.gitignore` dosyaları kesinlikle ezilmez.
     e. Geçici `.tmp-scaffold/` klasörü temizlenir.

3. **Dosya İzinleri, Çalıştırılabilirlik (chmod) ve Sembolik Bağ Güvenliği:**
   - **Çalıştırılabilir Betik İzinleri (Executable Permissions):** İskeletin ürettiği wrapper betikler (`gradlew`, `mvnw`), shell scriptleri (`*.sh`) ve binary'ler taşınırken POSIX `0o755` (`chmod +x`) izinleri mutlak suretle korunmalıdır (`preserveTimestamps: true`, Node.js `fs.cp` `mode: true`).
   - **Windows Öznitelik Kilidi:** Windows dosya sisteminde salt-okunur (read-only) veya gizli sistem özniteliklerinin kopyalamayı engellememesi için yazma izinleri garanti edilir (`chmod u+w`).
   - **Sembolik Bağ (Symlink) Koruması:** İskelet araçlarının üretebileceği sembolik bağlar denetlenir; proje kök dizini dışına işaret eden sızıntılar (*Path Traversal via Symlink*) reddedilir.

4. **Özel ve Uç Derleme Araçları Fallback Protokolü (Makefile / Bazel / CMake / Monorepo):**
   - Eğer proje standart 8 paket yöneticisi yerine `Makefile`, `BUILD.bazel`, `CMakeLists.txt` veya Monorepo (`Turborepo`, `Nx`) ile yapılandırılıyorsa:
     - Şartnameden `build_system: "makefile" | "bazel" | "cmake" | "monorepo" | "custom"` şeması çıkarılır.
     - Şartnamede tanımlanan özel hazırlık komutu (örn. `make setup`, `bazel sync`) çalıştırılır.
     - Güven skoru < 0.9 ise Adım 3 (Dokümantasyon Araştırma Protokolü) veya kullanıcı onayı (`Ask First`) devreye girer.

5. **Platform ve Araç Bazında Non-Interactive Bayrak Standartları:**
   - CLI'lara her zaman etkileşimi bastıran kesin bayraklar eklenir (örn. `create-next-app` için `--yes --disable-git`, Vite için `-- --template <tpl>`, Cargo için `--vcs none`).

---

## 6. Adım 4: İskelet Görevinin Oluşturulması ve Yürütülmesi (`TASK-000`)

AIDM Motoru ve Görev Yöneticisi, iş kurallarından önce bu görevi oluşturur:

```json
{
  "task_id": "TASK-000",
  "parent_feature_id": "ROOT",
  "task_class": "SCAFFOLD",
  "title": "Universal Project Scaffolding & Bootstrap",
  "priority": "BLOCKING_PREREQUISITE",
  "implementation_scope": ["*"],
  "max_file_modifications": 250,
  "dependencies": [],
  "instructions": "Proje şartnamesinde belirtilen teknoloji yığınına uygun resmi iskeleti kök dizinde başlat. Non-interactive CLI kullan. Konfigürasyon dosyalarını (tsconfig, lint, tailwind vb.) eksiksiz yapılandır."
}
```

### 6.1. Bağımlılık Kilidi (DAG Enforcing)
`TASK-001`, `TASK-002` ve sonraki tüm iş mantığı görevlerine zorunlu olarak şu kural eklenir:
```json
"dependencies": ["TASK-000"]
```
`TASK-000` başarıyla tamamlanıp `ACCEPTED` onayı alana kadar, hiçbir iş görevi yürütücüye atanmaz.

---

## 7. Adım 5: Evrensel Sağlık ve Kalite Kapısı (Health Verification Gate)

İskelet oluşturulduktan sonra LLM, dosya içeriğinden bağımsız olarak sistemin çalıştığını aşağıdaki evrensel komut zinciriyle doğrular:

```bash
# 1. Sözdizimi ve Tip Denetimi (Zero Error)
[Node/TS]        : pnpm type-check (veya npx tsc --noEmit)
[Python/MyPy]    : poetry run mypy . (veya uv run mypy .)
[Go]             : go vet ./...
[Rust]           : cargo check
[Flutter/Dart]   : flutter analyze
[Expo/RN]        : npx expo-doctor (veya npx tsc --noEmit)
[Embedded Rust]  : cargo check --target thumbv7em-none-eabihf (veya hedef mimari)
[Embedded/PIO]   : pio check

# 2. Kodlama Standartları ve Lint (Zero Warning)
[Node]           : pnpm lint (veya npx eslint .)
[Python]         : poetry run ruff check .
[Go]             : golangci-lint run
[Rust]           : cargo clippy
[Flutter]        : dart analyze --fatal-warnings
[Expo/RN]        : npm run lint

# 3. Derleme / Paketleme Testi
[Node/Web]       : pnpm build (veya npm run build)
[Go]             : go build -o /dev/null ./...
[Rust]           : cargo build
[Flutter]        : flutter build bundle (veya flutter test)
[Expo/RN]        : npx expo export --dump-sourcemap (veya test)
[Embedded/PIO]   : pio run
```

* **Kabul Kriteri:** Çıkış kodu `0` olmalı; derleme veya tip hatası bulunmamalıdır. Hata varsa iskelet düzeltilmeden (`REPAIR`) iş mantığına geçilemez.

---

## 8. Adım 6: Dinamik Dizin Ağacı Yeniden İndeksleme ve Eşleme

İskelet görevi `ACCEPTED` olduktan sonra AIDM Motoru:

1. **Çalışma Alanını Yeniden Tarar (`aidm_project_discover`):** Kurulum ile oluşan gerçek dosya ağacını belleğe alır (`app/`, `components/`, `lib/`, `controllers/`, `models/` vb.).
2. **İş Görevlerinin Kapsamını Günceller (`Scope Remap`):**
   * Örnek: `REQ-002: Randevu Sistemi` görevi artık `src/index.ts` dosyasına yönlendirilmez.
   * Çatı Next.js ise: `app/randevu/page.tsx`, `components/randevu-form.tsx`, `lib/randevu-service.ts`.
   * Çatı FastAPI ise: `routers/randevu.py`, `models/randevu.py`, `schemas/randevu.py`.
   * Çatı Go ise: `handlers/randevu.go`, `services/randevu.go`, `repository/randevu.go`.
   * Çatı Flutter ise: `lib/features/randevu/screens/randevu_screen.dart`, `lib/features/randevu/services/randevu_service.dart`.
   * Çatı Expo ise: `app/(tabs)/randevu.tsx`, `components/randevu-card.tsx`.

---

## 9. Yaygın Çatılar ve Platform Bazında Test Edilmiş Başlatma Kılavuzu

> **Not:** Kök dizinde `SPEC.md`, `.git` vb. bulunması durumunda çakışma hatası almamak için doğrudan kurulum desteklenmiyorsa Bölüm 5.3'teki **Isolated Staging** kuralı uygulanmalıdır.

| Çatı / Platform | Standart Non-Interactive Başlatma Komutu | Dosya Çakışması / Boş Dizin Kuralı | Tipik Klasör Yapısı |
| :--- | :--- | :--- | :--- |
| **Next.js (App Router, TS, Tailwind)** | `npx -y create-next-app@latest ./ --typescript --tailwind --eslint --app --src-dir=false --import-alias="@/*" --use-pnpm --yes` | Kökte dosya varsa `.tmp-scaffold` üzerinden taşınır | `app/`, `public/`, `next.config.ts`, `tailwind.config.ts` |
| **Vite + React (TypeScript, Tailwind)** | `npm create vite@latest ./ -- --template react-ts` | Kökte dosya varsa `--overwrite` veya staging kullanılır | `src/`, `src/components/`, `vite.config.ts`, `index.html` |
| **NestJS (TypeScript)** | `npx -y @nestjs/cli new ./ --skip-git --package-manager pnpm` | Kökte dosya varsa `.tmp-scaffold` kullanılır | `src/`, `src/app.module.ts`, `test/` |
| **FastAPI (Poetry / Uv)** | `poetry init -n && poetry add fastapi uvicorn[standard]` veya `uv init --app .` | Mevcut dosyalara dokunmaz, kökte güvenlidir | `app/`, `app/main.py`, `app/routers/`, `pyproject.toml` |
| **Go (Standard Layout)** | `go mod init <module_path> && mkdir -p cmd/api internal/handlers` | Mevcut dosyalara dokunmaz, kökte güvenlidir | `cmd/`, `internal/`, `go.mod` |
| **Rust (Cargo)** | `cargo init --vcs none .` | Mevcut dosyalara dokunmaz (`--vcs none` önerilir) | `src/`, `src/main.rs`, `Cargo.toml` |
| **Mobil / Flutter** | `flutter create --org com.example --project-name app --platforms android,ios,web .` | Mevcut dosya toleransı yüksektir; kökte çalışabilir | `lib/`, `android/`, `ios/`, `pubspec.yaml` |
| **Mobil / React Native (Expo)** | `npx -y create-expo-app@latest . --template blank-typescript --yes` | Kökte dosya varsa `.tmp-scaffold` staging kullanılır | `app/` (veya `src/`), `assets/`, `app.json`, `package.json` |
| **Mobil / Bare React Native** | `npx -y @react-native-community/cli init AppName --skip-git-init --directory .` | Staging veya alt dizin terfisi önerilir | `android/`, `ios/`, `src/`, `package.json` |
| **Gömülü / Embedded (PlatformIO)** | `pio project init --board esp32dev` (veya hedef kart) | Kökte `platformio.ini` ve `src/` üretir, çakışmaz | `src/`, `include/`, `lib/`, `platformio.ini` |
| **Gömülü / Embedded (Rust no_std)** | `cargo init --bin --vcs none .` | `Cargo.toml` ve `src/main.rs` üretir | `src/`, `Cargo.toml`, `.cargo/config.toml` |

---

## 10. LLM / Sistem Ajanı İçin Doğrudan Talimat Bloğu (System Instruction Prompt)

AIDM veya herhangi bir kodlama ajanı yeni bir göreve başladığında, sistem komut istemine şu blok doğrudan dahil edilir:

> **CRITICAL DIRECTIVE FOR THE AUTONOMOUS AGENT:**  
> Before writing any functional or business logic code, inspect the root directory for standard project manifest files. If the repository lacks a configured framework (e.g., no `package.json`, `Cargo.toml`, or `pyproject.toml`), DO NOT dump implementation code into a single arbitrary file. Instead:  
> 1. Read the specification to extract the requested technology stack.  
> 2. If the setup CLI or flags are unfamiliar, search official documentation using web search.  
> 3. Execute the official non-interactive CLI to scaffold the full project skeleton directly in the root directory.  
> 4. Verify that the project compiles cleanly (`build` / `type-check`).  
> 5. Map all subsequent requirement tasks into the newly created architectural directories.
