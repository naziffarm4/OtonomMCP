# Otonom çalışma (`aidm run --spec`, `aidm_autonomous_start`) — doğrulama, deneme, izleme, talimat

## 1. Görev doğrulaması ve son kabul kapısı (fail-closed)

- **Görev başına**: görevin kendi kabul kriterleri + spec `## Komutlar` içindeki komutlardan
  **referans verdiği dosyaların hepsi zaten var olanlar**. (`npm/pnpm/yarn/bun …` → `package.json`;
  diğer komutlarda `/`, `\` ya da uzantı içeren işlenenler, bayraklar ve URL'ler hariç.) Henüz
  oluşturulmamış bir dosyaya bağlı komut o görev için **ertelenir** ve raporda
  `deferredCommands` altında görünür. Dosya referansı tespit edilemeyen komutlar her görevde koşar.
- Global `## Kabul Kriterleri` artık her göreve kopyalanmaz (kriteri olmayan göreve varsayılan
  "Implementation exists and project verification checks pass" verilir).
- **Son kabul kapısı** (`report.finalGate`): tüm görevler kabul edildikten sonra `## Komutlar`
  içindeki TÜM komutlar + global kabul kriterlerindeki backtick içindeki komutlar (`node …`,
  `npm …` vb.) zorunlu olarak çalıştırılır. Başarısızsa en çok 2 `GATE-FIX-n` onarım alt görevi
  (bu görevler için tüm komutlar zorunlu) açılır. Hâlâ başarısızsa çalışma `PARTIAL` biter
  ("Final acceptance gate failed: …"). Kapı geçmeden `COMPLETED` olunmaz.

## 2. Deneme hakkı

- Varsayılan **3 deneme / görev** (`--max-cycles` ile değişir). Spec içinde görev bazında:

  ```markdown
  ### Ödeme formu
  `src/pay.ts` …
  - Deneme: 5
  ```

  Kabul edilen yazımlar (madde işaretli ya da değil, 1–10): `Deneme: N`, `Deneme sayısı: N`,
  `Maksimum deneme: N`, `Max attempts: N`. Bu satır kabul kriteri sayılmaz.
- Başarısız deneme → onarım döngüsü: AIDM'nin kendi topladığı başarısız komut çıktılarının
  (stdout/stderr kuyrukları, sırlar maskeli, kısaltılmış) Director'a "Attempt x/y … failed" olarak
  verilir. İlk denemedeki hata artık `BLOCKED_ON_HUMAN` değildir.
- Her deneme ayrı bir dispatch'tir (idempotency anahtarı deneme başına); onarım denemesi yeni
  bağlamda yeni bir Director kararı olarak kaydedilir.
- `filesChanged`, başarısız denemelerde de bağımsız kanıttaki (izlenmeyen yeni dosyalar dahil)
  değişiklikleri içerir.

## 2a. Salt-okunur inceleme (analiz) adımı — hız

Director bir görevden önce `ANALYZE_PROJECT` (ya da `DISCOVER_PROJECT` / `REVIEW_EVIDENCE`) isterse AGY'ye
ayrı bir salt-okunur alt görev (`TASK-00N-A1`) gider; bu görev başına birkaç dakika sürer. Varsayılan
(`gerektiğinde`) bu adım yalnızca:

- çalışmanın (ya da devam ettirilen bölümün) **ilk** görevinde ve
- bir görevin **başarısız denemesinden sonra** (onarım döngüsü)

çalışır. Diğer görevlerde Director'a istem içinde analiz istememesi, doğrudan `IMPLEMENT_TASK` vermesi
söylenir. Yine de isterse AGY çalıştırılmaz; Director'a "şu an ayrı analiz yok, IMPLEMENT_TASK ver"
denir (deneme sayılmaz). Aynı görevde ikinci kez isterse bu normal kurallarla işlenir (deneme sayılır),
yani döngüye giremez. Analiz alt görevi yine görev başına en çok 2'dir.

Spec'in herhangi bir yerinde tek satırla değiştirilebilir (madde işaretli ya da değil; kabul kriteri sayılmaz):

```markdown
- İnceleme: her görev     # her görevden önce analiz serbest (eski davranış)
- İnceleme: gerektiğinde  # varsayılan
- İnceleme: hiç           # ayrı analiz adımı hiç çalışmaz
```

Kabul edilen yazımlar: `her görev` / `her-gorev`, `gerektiğinde` / `gerektiginde`, `hiç` / `hic`
(İngilizce: `Analysis policy: every-task | on-demand | never`). Tanınmayan değer uyarı verir ve varsayılan kullanılır.

## 3. Deneme hakkı bittiğinde sistem kararı

Kararı Director değil **runner** açar (Director cevaplayamaz, kendine hak veremez):

- Soru (Türkçe): görev, kullanılan deneme sayısı, son başarısız doğrulama özeti, Director'ın kısa teşhisi.
- Seçenekler: `retry_2` "Bu göreve 2 deneme daha ver" (yalnızca bütçe kaldıysa önerilir),
  `skip` "Görevi atla (bağımlı görevler de atlanır)", `stop` "Çalışmayı durdur". Serbest metin
  açık; Director'a PO yönlendirmesi olarak iletilir.
- Yalnızca doğrulanmış cevap geçerlidir (aynı `IdpDecisionResolver` yolu, `operation
  AUTONOMOUS_DECISION`, packageId/revision bağlı) ya da mevcut TTY kuralları.
- `retry_2` tam olarak +2 deneme verir; tekrar verilebilir ama her seferinde yeni insan cevabı
  gerekir. Bütçe tavanı asla yükseltilmez. Bekleme sırasında bağımsız görevler sürer.
- Yalnızca serbest metin (seçenek yok) hiçbir hak vermez → `BLOCKED_ON_HUMAN`.
- `AIDM_DECISION_MODE=assume`, kanal yok ya da süre doldu → `BLOCKED_ON_HUMAN` (otomatik tekrar yok).

## 4. Canlı izleme (IdP `#/runs`)

`docs/EXTERNAL-IDP-RUN-MONITOR.md` sözleşmesi. `AIDM_IDP_URL` + `AIDM_IDP_CLIENT_TOKEN` varsa
açık, `AIDM_IDP_RUN_MONITOR=off` ile kapalı. Tek yönlü, ateşle-unut: istek başı 2 sn zaman aşımı,
sınırlı kuyruk (500, en eski düşer), 50'lik paketler, tek `seq` sayacı, çalışma sonunda en çok 3 sn
son gönderim. Hiçbir hata çalışmayı etkilemez. Sır, prompt ve dosya içeriği gönderilmez; metinler
maskelenir, kontrol/bidi karakterleri temizlenir, kısaltılır. CLI `Canlı izleme: <url>` yazar;
MCP `aidm_autonomous_start` cevabı `monitorUrl` döndürür ve onay beklerken `PENDING_APPROVAL`
anlık görüntüsü gönderilir.

## 5. Canlı PO talimatları

`docs/EXTERNAL-IDP-INSTRUCTION-CONTRACT.md` sözleşmesi. Yalnızca `status=PENDING_DELIVERY`
yoklanır; her token mevcut doğrulayıcıyla (ES256, nonce tekrar deposu, bağlam bağları,
`operation AUTONOMOUS_INSTRUCTION`, en çok 900 sn ömür) doğrulanır. Token'daki `taskId` bir
**hedeftir** (null olabilir); var olmayan göreve işaret ederse `REJECTED`.

- `NOTE`: bir sonraki Director çağrısına yönlendirme olarak eklenir → `APPLIED`.
- `PAUSE_AND_APPLY`: çalışan AGY adımı kesilmez; bir sonraki adım sınırında Director mühürlü
  mandate içinde yeniden planlayabilir → `APPLIED`; kapsam dışı/uygulanamaz → `REJECTED`.
- `STOP` (metin boş olabilir): düzgün durdurma, durum `STOPPED`, rapor yazılır → `APPLIED`.
- Mandate dışı her şey (bütçe, yetki, kapsam) mevcut onay/karar akışından geçer; asla kendiliğinden
  verilmez. Mandate değişikliği yeni onaylı bir çalışma gerektirir (bilinen sınır).

## 6. Sağlayıcı ön kontrolü

IdP onay isteği oluşturulmadan **önce** LLM sağlayıcı yapılandırması (uç nokta, model, API
anahtarı var mı, doğrulanmış fiyat) ağ çağrısı yapmadan kontrol edilir; hata `CONFIGURATION_ERROR`
olarak döner ve hiçbir onay isteği/mandate oluşmaz.

## 7. Varsayılan proje kökü ve spec koruması

- Hedef verilmezse proje kökü **spec .md dosyasının bulunduğu klasördür**:
  `aidm run --spec yol/proje.md` (`-C`/`--project-root` yoksa) ve `aidm_autonomous_start`
  (`workspaceRoot` yoksa). Açık hedef her zaman önceliklidir. (Önceki varsayılan: CLI'da çalışma
  dizini, MCP'de sunucunun proje kökü, o da yoksa `process.cwd()`.) MCP cevabı kullanılan
  `workspaceRoot`'u döndürür; `aidm_autonomous_resume/status` çağrılarına aynı değeri verin.
- Spec dosyası, spec onu açıkça yazılabilir yol (`## Dizinler`) ya da hedef dosya olarak
  listelemedikçe AGY tarafından değiştirilemez: her denemeden sonra sha256 kontrol edilir; değişmişse
  orijinali geri yazılır ve çalışma `BLOCKED_ON_HUMAN` durur.


## Kesintiden sonra devam (resume)

Çalışma yarıda kesilirse (süreç öldürüldü, Antigravity kapandı, bilgisayar yeniden başladı) aynı
çalışmaya kaldığı yerden devam edilebilir.

- **Algılama:** canlı çalışma `.ai-manager/state/autonomous-run.lock` dosyasına PID + 10 sn'de bir
  heartbeat yazar; ilerlemesini `.ai-manager/state/autonomous-runs/<runId>.json` checkpoint'ine
  kaydeder. PID yaşamıyorsa (veya heartbeat 10 dakikadan eskiyse) kilit *bayat* sayılır ve çalışma
  `INTERRUPTED` olur. PID'i yaşayan bir çalışma asla ikinci kez başlatılmaz.
- **Yeni başlatma:** kesilmiş bir çalışma varken yeni `aidm run --spec` `CONFIGURATION_ERROR` ile durur
  ve devam komutunu söyler. Bilerek sıfırdan başlamak için `--abandon-interrupted`
  (MCP: `abandonInterrupted: true`) — eski çalışma `ABANDONED` işaretlenir.
- **Devam:** CLI `aidm run --spec <md> --resume [runId]` (runId verilmezse en son kesilen),
  MCP `aidm_autonomous_start { specPath, resumeRunId }` veya `aidm_autonomous_resume { runId }`.
  - Aynı `runId` kullanılır; izleme ekranında aynı çalışma "bölüm N" olarak devam eder (seq kaldığı
    yerin üstünden sürer).
  - Kabul edilmiş (commit'lenmiş) görevler atlanır. Yarıda kalan görevin commit'lenmemiş değişiklikleri
    `git stash` ile kenara alınır (`aidm-resume <runId>: interrupted attempt`, silinmez) ve görev son
    AIDM commit'inden temiz başlar. Tamamlanmış denemeler sayılır; süreç ölürken yarıda kalan deneme
    sayılmaz.
  - Bütçe: aynı bütçe defteri ve aynı tavan; harcanan tutar devreder (yeni dönem açılmaz). Farklı
    `--budget-usd` reddedilir. Ölen sürecin açık rezervasyonları kurtarılır (hazırlanmış olanlar
    serbest, gönderilmiş olanlar "bilinmiyor" olarak sayılmaya devam eder).
  - Spec dosyası değiştiyse (sha256 farklı) devam reddedilir.
  - **Yetki asla sessizce yeniden kullanılmaz:** her devam yeni bir yetki ister. IdP ile onaylanmış bir
    çalışma yalnızca yeni bir passkey onayıyla devam eder; onay isteği `pkg-resume-…` paketiyle, özette
    `resumeOfRunId` ile ve bağlam parmak izine `resumeOfRunId` katılarak o çalışmaya bağlanır.

## Antigravity'den bağımsız çalışma (detached worker)

`aidm_autonomous_start` / `aidm_autonomous_resume` canlı çalışmaları MCP sunucusunun içinde değil, ayrık
bir Node sürecinde (`dist/autonomous/worker-main.js`) çalıştırır (`detached`, `windowsHide`, `unref`;
çıktı `.ai-manager/logs/worker-<id>.log`). MCP aracı hemen `runId`, `approvalUrl`, `monitorUrl`,
`workerPid` ve `logPath` döner. IdP onayı gerekiyorsa worker onayı kendisi bekler (ayrıca `resume`
çağırmak gerekmez); `aidm_autonomous_status` her şeyi diskten okur (`approvals[].workerAlive`,
`runs[].liveness`: `ALIVE` / `INTERRUPTED` / `FINISHED`). Karar cevabı tokenları
(`aidm_autonomous_resume { decisionId, token }`) worker'a disk üzerinden iletilir ve yine doğrulanır.
`AIDM_MCP_DETACHED_RUNS=off` eski (süreç içi) davranışa döner.

## Windows: konsol penceresi açılmaz

AIDM'in başlattığı her alt süreç (git, AGY, doğrulama komutları, DPAPI PowerShell, taskkill/tasklist,
bağımsız worker) `windowsHide: true` ile başlatılır; çalışma sırasında konsol pencereleri açılıp kapanmaz.
Worker `cmd` üzerinden değil doğrudan `node` (process.execPath) ile, `detached` ve çıktısı log dosyasına
yönlendirilmiş olarak başlar. `tests/windows-hide-spawn.test.ts` kaynak koddaki tüm çağrıları denetler.

## Spec netleştirme (uygulamadan önce Director incelemesi)

Çalışma onaylandıktan sonra, **hiçbir görev başlamadan önce** Director spec'i ve görev planını bütün olarak
inceler (amaç, kapsam, mimari, teknoloji seçimi, ortak parçalar — örn. menünün sayfalara nasıl ekleneceği,
tek/sayfa başına CSS, klasör yapısı, görev sırası, riskler, nasıl doğrulanacağı) ve:

- **Netleştirilecek noktalar:** spec'in açık bıraktığı, yanlış tahminin yeniden iş çıkaracağı konular;
- **Önerilen iyileştirmeler:** daha iyi bir yol görürse kabul/ret edebileceğin plan değişiklikleri

hazırlar. Her soru sade **Türkçe**dir, "neden soruyorum" açıklaması ve önerilen seçeneği vardır (Türkçe
olmayan sorular bir kez düzeltilmeye gönderilir, yine olmazsa atılır). Her seçeneğin altında, seçersen
görevlere eklenecek **ölçülebilir kabul kriterleri** yazar.

- Tek IdP etkileşimi: tüm sorular tek sayfada (`SPEC_CLARIFICATION`, sözleşme v1.2); önerilenler işaretli
  gelir, değiştirip **Windows Hello** ile bir kez gönderirsin. AGY'ye ya da IdP dışında sana hiçbir şey sorulmaz.
- Cevaplar: kriterler ilgili görevlerin Director talimatına bağlayıcı olarak eklenir; nesnel kontroller
  `scripts/aidm-checks/spec-clarifications.mjs` (bağımlılıksız node betiği; içeriği veri, LLM kodu değil)
  olarak üretilip commit edilir ve **son kabul kapısına** eklenir; kabul edilen iyileştirmeler izinli yollar
  içinde yeni görev (`TASK-C01`…) olarak eklenir. Sadece serbest metinle verilen cevaplar Director tarafından
  bir LLM çağrısıyla kritere çevrilir.
- Soru yoksa (Director "her şey açık" derse) hiçbir şey sorulmaz. IdP yoksa ya da `AIDM_DECISION_MODE=assume`
  ise önerilen seçenekler varsayım olarak uygulanır ve raporda yazılır.
- 15 dk içinde cevap gelmezse çalışma **BLOCKED_ON_HUMAN** biter, hiçbir görev çalışmaz. Aynı spec ile
  yeniden başlatınca aynı sorular Director yeniden çağrılmadan tekrar gönderilir.
- Cevaplar `.ai-manager/state/spec-clarification/<spec-sha256>.json` içinde ve raporun "Spec netleştirme"
  bölümünde durur; devam/yeniden başlatmada tekrar sorulmaz. Spec değişirse (yeni parmak izi) yeniden incelenir.
- Harcama bütçeden düşer (inceleme 1 çağrı; Türkçe düzeltme ve serbest metin çevirisi gerekirse +1'er).
- Kapatmak için spec'e: `Netleştirme: kapalı` (ascii `Netlestirme: kapali`); varsayılan `açık`.

## Yürütücü modları (executor modes)

Spec satırı `Yürütücü: ide | cli | cli-oturum` (yoksa `AIDM_EXECUTOR_MODE`, varsayılan `ide`).

- **ide** (varsayılan): `agy` başlatılmaz. Runner her görevi `.ai-manager/state/ide/task.json` posta kutusuna koyar.
  Antigravity'de açık ajan döngüsü: `aidm_next_task` → işi IDE'de yap → `aidm_submit_task(seq, summary, changedFiles)`.
  `aidm_submit_task` en fazla ~45 sn bekler (`AIDM_IDE_SUBMIT_WAIT_MS`) ve şunlardan birini döner:
  `ACCEPTED` (+sıradaki görev), `REPAIR` (+Türkçe geri bildirim), `WAIT` (IdP kararı), `DONE`, `PENDING` (sonra `aidm_task_result`).
  IDE'nin iddiası güvenilmez: Director çalışma alanını bağımsız doğrular (SystemExecutionEvidence, kapsam, kontroller).
  IDE süre içinde teslim etmezse (`AIDM_IDE_TIMEOUT_MS`, varsayılan 45 dk, dosya değişikliği oldukça 2 saate kadar uzar)
  görev EXECUTION_UNKNOWN olur, IdP'de Türkçe karar açılır ve çalışma kaldığı yerden devam ettirilebilir.
- **cli**: her görev için `agy` süreci (önceki davranış).
- **cli-oturum**: `agy`, ilk yanıttaki `conversation_id` `.ai-manager/state/agy-session.json`'a kaydedilir ve sonraki görevlerde
  `--conversation <id>` ile aynı oturum sürdürülür.

## aidm watcher

- Her çalışma başlangıcı projeyi `%LOCALAPPDATA%\aidm\watcher-roots.json` listesine ekler; watcher listeyi her turda yeniden okur.
- Tek kopya: `%LOCALAPPDATA%\aidm\aidm-watcher.lock`; ikinci watcher hemen çıkar.
- IdP erişilemezse yalnızca durum değişince loglanır; bekleme 60 sn'ye kadar katlanarak artar.

## Web projeleri: son kontrol, görsel inceleme, tamamlama raporu

- Projede `.html` sayfa varsa son kontrole (final gate) otomatik iki komut eklenir:
  `node .ai-manager/checks/web-site-check.cjs` (ortak menü, tek ortak CSS, kırık iç bağlantı, viewport, tasarım tokenları) ve
  `node .ai-manager/checks/web-browser-check.cjs` (gizli headless Chromium: konsol hataları, telefonda yatay taşma,
  telefon 390x844 ve masaüstü 1366x900 ekran görüntüleri → `.ai-manager/reports/screenshots/`). Böylece sonuç NO_CHECKS değil PASS/FAIL olur.
  Playwright yoksa tarayıcı kontrolü SKIPPED der ve geçer (`AIDM_BROWSER_REQUIRED=1` ile zorunlu); `AIDM_BROWSER_CHECK=0` kapatır; `AIDM_WEB_CHECKS=0` tüm web kontrollerini kapatır.
  Playwright yeri: `AIDM_PLAYWRIGHT_DIR` → `%LOCALAPPDATA%\aidm\browser` → `~/.aidm/browser`.
- Ekran görüntüleri varsa Director en fazla 6 görüntüyü tasarım kurallarına göre görsel olarak inceler (bütçeden düşer, tavsiye niteliğinde; `AIDM_VISUAL_REVIEW=0` kapatır).
- Çalışma sonunda `.ai-manager/reports/tamamlama-<runId>.md` (tek sayfa Türkçe özet) yazılır ve IdP çalışma sayfasına ekran görüntüleriyle birlikte gönderilir.
- Kurulumdan önce: `cd packages/core && npm run smoke` (sahte LLM + simüle IDE ile uçtan uca duman testi).
- Spec şablonu: `docs/spec-sablonu.md`.

## Director iyileştirmeleri (plan, ilerleme notu, hafıza, öz kontrol, paralel kontrol, prompt önbelleği)

- **Yaklaşım planı:** Spec incelemesiyle aynı LLM çağrısında Director kısa bir Türkçe plan (yaklaşım, sıra, riskler, önceki tercihlerden varsayılanlar) üretir. Plan, netleştirme sorularıyla aynı IdP ekranında tek bir passkey onayında sunulur ("Plan uygun" / düzeltme yaz). Düzeltme metni bağlayıcı nottur ve kabul kriterine çevrilir. `AIDM_APPROACH_PLAN=0` kapatır; `Netleştirme: kapalı` olan spec'te plan da sorulmaz.
- **İlerleme notları:** Her N kabul edilen görevde (spec `İlerleme notu: 3` / `kapalı`, ya da `AIDM_PROGRESS_NOTE_EVERY`; varsayılan 3) Director "Ne oldu / Neye dikkat ettim / Sıradaki" notunu IdP çalışma sayfasına yazar (onay gerekmez, bütçeden düşer).
- **Tercih hafızası:** `%USERPROFILE%\.aidm\preferences.json` (`AIDM_PREFERENCES_PATH`, `AIDM_PREFERENCES=0` kapatır). Sizin passkey ile verdiğiniz netleştirme/tasarım cevaplarından ve plan düzeltmelerinden öğrenilir. Sonraki projelerin spec incelemesine verilir: bilinen konular tekrar sorulmaz, varsayılanlar planda gösterilir. IdP'de **Tercihlerim** sayfasında görülür, düzenlenir, silinir (silinen bir daha eklenmez).
- **Öz kontrol:** Otomatik kontroller geçtikten sonra, kabulden önce Director değişen dosyaları spec ve kriterlerle karşılaştırır. Somut eksik görürse görev bir kez onarıma döner. `AIDM_SELF_CHECK=0` kapatır.
- **Paralel son kontrol:** Son kontrol komutları (testler, site kontrolü, tarayıcı) aynı anda çalışır. Görsel inceleme, tarayıcı kontrolü ekran görüntülerini üretir üretmez başlar. `AIDM_GATE_PARALLEL=0` sırayla çalıştırır.
- **Prompt önbelleği:** Çalışma boyunca değişmeyen bağlam (PO kararları, onaylı plan, politika, yetenekler, spec) Director isteğinin başına sabit blok olarak konur. Değişen kısım (görev, kanıt, zaman) sonra gelir. Böylece OpenAI otomatik önbelleği kullanılır. Bağlam artık görev alanının 2000 karakter sınırında kesilmez. Önbellekten gelen token sayısı tamamlama raporunda yazar. Önbellekli girdi fiyatı `AIDM_LLM_CACHED_INPUT_USD_PER_MTOK` ile bildirilir; bildirilmezse bütçe güvenli tarafta kalıp normal girdi fiyatını kullanır. `AIDM_STABLE_PROMPT=0` eski düzene döner.

## Karar günlüğü

Her çalışmada Director/AIDM kararları (plan, görev oluşturma/kabul/düzeltme, kapsam değişikliği, tasarım tercihleri, netleştirme/tercih kaynaklı varsayımlar, öz kontrol şüpheleri, durma) kısa Türkçe gerekçe, zaman (TRT) ve ilgili görevle `.ai-manager/reports/karar-gunlugu-<runId>.md` dosyasına canlı yazılır (devam ettirmede `.json` eşinden sürer). Aynı kayıtlar `DECISION_LOG` olayı olarak IdP çalışma sayfasında salt okunur "Karar günlüğü" bölümünde görünür. Gerekçeler AIDM şablonlarıdır (ürün sahibinin kendi cevapları dahil); ham istem/LLM içeriği yazılmaz, gizli anahtar kalıpları maskelenir. Kapatmak için `AIDM_DECISION_LOG=0`.
