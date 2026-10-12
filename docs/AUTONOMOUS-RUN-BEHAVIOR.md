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
