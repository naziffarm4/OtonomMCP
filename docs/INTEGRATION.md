# OtonomMCP (Proje A) — Dış Entegrasyon Sözleşmesi (INTEGRATION.md)

**Belge Kodu:** AIDM-DOC-INTEG  
**Sürüm:** 1.0.0  
**Tarih:** 2026-10-04  
**Kapsam:** Proje A (AIDM Çekirdeği) ile Dış Sistemler (Dış İnsan Onayı Sağlayıcıları, Proje B veya Harici İstemciler) Arasındaki Bağlayıcı Genel Entegrasyon Sözleşmesi

---

## 1. Mimari Sorumluluk ve Güven Sınırları

Proje A (AIDM), yazılım projelerinin otonom planlama, bütçeleme, yetkilendirme, kod yürütme ve bağımsız kanıt doğrulama süreçlerini yöneten yetkili orkestrasyon çekirdeğidir. Dış onay sistemleriyle (Proje B veya diğer yerel/donanımsal onay mekanizmaları) entegrasyon bu genel sözleşmeye tabidir:

| Sorumluluk Alanı | Proje A (AIDM Çekirdeği) | Dış Onay Sağlayıcısı (Örn. Proje B) |
|---|---|---|
| **Görev Planlama & Muhakeme** | **Tam Yetkili.** Director Reasoning Engine ile görevleri ayrıştırır ve planlar. | **Yetkisiz.** Planlama yapmaz. |
| **Kullanıcı Karar İletişimi** | Karar ihtiyacını tespit eder, kanonik onay paketini hazırlar ve yayınlar. | **Arayüz Sahibi.** İşlem detaylarını bağımsız bant dışı (out-of-band) ekranda kullanıcıya gösterir, kararı alır. |
| **Bütçe & Harcama Yönetimi** | **Tam Yetkili.** SQLite Nano-USD bütçe ve hold rezervasyonunu yönetir. | Bütçe rakamlarını kullanıcıya gösterir; kural veya bütçe belirlemez. |
| **Politika & Kapsam Denetimi** | **Tam Yetkili.** Project Mandate kurallarına göre izinleri denetler (`ALLOW`, `DENY`, `REQUIRE_HUMAN_APPROVAL`). | Politika kararı vermez; onaylanan işlemin bütünlüğünü garanti eder. |
| **Güvenlik Kapısı (Check 6)** | **Kapı Bekçisi.** Dış kriptografik onay kanıtını doğrular; kanıt yoksa veya geçersizse fail-closed bekletir (`BLOCKED_ON_AUTH_CONTEXT`). | **Kanıt Sağlayıcı.** Kullanıcı onayını imzalı kanıt olarak A'ya sunar. |
| **Kod & Görev Yürütme** | **Tam Yetkili.** ExecutionBridge, Driver ve AGY üzerinden kodları ve testleri yürütür. | **Kesinlikle Yürütmez.** Sistem komutu veya dosya yazma operasyonu yapmaz. |
| **Bağımsız Kanıt Doğrulama** | **Tam Yetkili.** Dosya hash'i (SHA-256) ve Git durumunu EvidenceCollector ile doğrular. | Kanıt toplamaz. |

---

## 2. Bölüm I — Proje A Tarafından Sunulan Genel Entegrasyon Arayüzü

Aşağıdaki şemalar normatif veri sözleşmesi tanımlarıdır; çalışan bir canlı ortam kanıtı değil, entegrasyon formatı kurallarıdır.

### 2.1. Onay Talebi Veri Formatı Şeması (ApprovalRequestPayload)

```json
{
  "protocolVersion": "1.0.0",
  "requestId": "req-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "projectId": "OtonomMCP",
  "workspaceId": "ws-main",
  "directorSessionId": "sess-27a6b156-f2e9-4b83-bf18-9a201690cd26",
  "cycleId": "cycle-14",
  "taskId": "task-security-hardening",
  "actionId": "act-update-policy-rules",
  "actionType": "MODIFY_SECURITY_POLICY",
  "mandateRevision": 3,
  "policyVersion": "1.0",
  "contextFingerprint": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "title": "Güvenlik Politikası Güncellemesi",
  "summary": "Proje mandate kapsamına yeni yetkilendirme kuralı ekleniyor.",
  "riskLevel": "HIGH",
  "impact": {
    "filesModified": ["packages/core/src/policy/policy-engine.ts"],
    "commandsAllowed": ["pnpm test"],
    "budgetImpactNanoUsd": "0"
  },
  "nonce": "a7f1c98e-4d5a-4e89-8123-bc9a12e4f012",
  "issuedAt": "2026-10-04T12:00:00.000Z",
  "expiresAt": "2026-10-04T12:05:00.000Z"
}
```

### 2.2. Kanonik İşlem Özeti (Canonical Transaction Hash) Kapsamı ve Formülü

Kanonik hash, onaylanan işlemin bağlamının karar anında tahrif edilmediğini garanti eder.

**Kapsanan 14 Alan (Alfabetik Anahtar Sıralı):**
1. `actionId`
2. `actionType`
3. `contextFingerprint`
4. `cycleId`
5. `directorSessionId`
6. `expiresAt`
7. `issuedAt`
8. `mandateRevision`
9. `nonce`
10. `policyVersion`
11. `projectId`
12. `requestId`
13. `taskId`
14. `workspaceId`

**Serileştirme Kuralı:** Alanlar alfabetik anahtar sırasına göre, boşluksuz (compact) ve UTF-8 formatında JSON nesnesi olarak serileştirilir. Ardından SHA-256 kriptografik özeti alınır:

$$\text{canonicalTransactionHash} = \text{SHA256}(\text{CanonicalCompactJson}(\text{fields}))$$

### 2.3. Onay Yanıtı Veri Formatı Şeması (ApprovalResponsePayload)

```json
{
  "protocolVersion": "1.0.0",
  "requestId": "req-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "decision": "APPROVED",
  "canonicalTransactionHash": "8c591a27e742880d8591f8691f64f434a94966d54cf8e309cbba6b8e8b0b9736",
  "nonce": "a7f1c98e-4d5a-4e89-8123-bc9a12e4f012",
  "decidedAt": "2026-10-04T12:01:15.000Z",
  "authProof": {
    "proofType": "GENERIC_ASYMMETRIC_SIGNATURE",
    "keyFingerprint": "key-fp-782b1c",
    "signature": "BASE64_SIGNATURE_STRING",
    "signedData": "8c591a27e742880d8591f8691f64f434a94966d54cf8e309cbba6b8e8b0b9736:a7f1c98e-4d5a-4e89-8123-bc9a12e4f012:2026-10-04T12:01:15.000Z:APPROVED"
  }
}
```

**İmzalanan Standart Veri Biçimi:**
$$\text{signedData} = \text{canonicalTransactionHash} \parallel \text{":"} \parallel \text{nonce} \parallel \text{":"} \parallel \text{decidedAt} \parallel \text{":"} \parallel \text{decision}$$

---

## 3. Bölüm II — Henüz Karşılanmamış Güvenlik Gereksinimleri

Aşağıdaki yetenekler Proje A çekirdeğinde henüz canlı üretimde doğrulanmış bir altyapıya sahip değildir; gelecekteki dış onay sisteminin sağlaması gereken zorunlu kriterlerdir:

1. **Güvenilir Açık Anahtar Kaydı (Trusted Key Enrollment):** Dış sağlayıcının imza doğrulama açık anahtarının AIDM'e güvenli, tahrif edilemez ve bant dışı (out-of-band) kaydedilmesi mekanizması.
2. **Fiziksel İnsan Varlığı Doğrulaması:** Kötü niyetli bir sürecin aynı kullanıcı oturumunda yazılımsal sahte imza üretmesini engelleyen ve fiziksel insanın işlem detaylarını görerek onayladığını (WYSIWYS) kanıtlayan altyapı.
3. **Bağımsız Kullanıcı Kimlik Kökü:** Antigravity IDE ve AGY uygulayıcısından tamamen izole edilmiş kimlik kanıtı.

Bu gereksinimler karşılanana kadar, hiçbir dış onay paketi "doğrulanmış" kabul edilmez.

---

## 4. Bölüm III — Mevcut Çalışma Davranışı ve Check 6 Kuralı

Mevcut Proje A kodunda `ExecutionBridge` Check 6 şu şekilde çalışır:

1. **Mevcut Durum:** `BLOCKED_ON_AUTH_CONTEXT`.
2. **Fail-Closed Davranış:** Bir işlem Product Owner onayı veya insan yetkilendirmesi gerektiriyorsa (`REQUIRE_HUMAN_APPROVAL`), güvenilir kimlik kanıtı bulunmadığı için yürütme kesin olarak engellenir.
3. **Check 6 Doğrulama Kriterleri:** Bir dış onay sağlayıcısı bağlandığında Check 6'nın geçebilmesi için şu kontrollerin tamamı sağlanmalıdır:
   - *Anti-Replay:* Nonce `NonceStore` tablosunda taze olmalı, daha önce kullanılmamış olmalıdır.
   - *Süre Aşımı:* `decidedAt <= expiresAt` ve sistem zaman penceresi geçerli olmalıdır.
   - *Kanonik Eşleşme:* Yanıttaki `canonicalTransactionHash` ile AIDM'in hesapladığı hash bit düzeyinde eşit olmalıdır.
   - *Kriptografik İmza:* `signedData` üzerindeki imza kayıtlı açık anahtarla doğrulanmalıdır.
   - *Karar Denetimi:* `decision === "APPROVED"` olmalıdır; `REJECTED` veya `CANCELLED` ise işlem fail-closed iptal edilir.
   - *Sözel Beyan Reddi:* İstemci/model beyanları (`isTrustedHumanAuth: true`, `actor: "USER"`) asla geçerli onay sayılmaz.

---

## 5. Proje A Genel API, MCP ve Lifecycle Sözleşmesi

1. **MCP Standart Araçları:** AIDM, dış kontrol için `aidm.director.*`, `aidm.task.*`, `aidm.evidence.*` standart JSON-RPC 2.0 araçlarını sunar.
2. **Olay Kaydı (Events):** Tüm durum geçişleri `HistoryManager` tarafından atomik JSONL dosyasına append-only olarak yazılır.
3. **Kanıt Sözleşmesi:** Bir görevin tamamlandı sayılması için AGY beyanı yetersizdir; `EvidenceCollector` tarafından bağımsız dosya hash'i ve Git diff doğrulaması şarttır.
4. **Sürümleme:** Bu sözleşme Semantic Versioning (SemVer 2.0) kurallarına tabidir. `protocolVersion` uyuşmazlığı durumunda istekler reddedilir.
