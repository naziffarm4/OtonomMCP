# Proje A ile Proje B Arasındaki Entegrasyon Sözleşmesi (A_B_INTEGRATION_CONTRACT)

**Sözleşme Tarihi:** 2026-10-04  
**Durum:** `TASLAK VE BAĞLAYICI MİMARİ ENTEGRASYON SÖZLEŞMESİ`  
**Taraflar:**
- **Proje A:** OtonomMCP / AIDM Çekirdeği (Orkestratör, Bütçe, Politika ve Yürütme Köprüsü)
- **Proje B:** Bağımsız Yerel Onay Uygulaması (Windows Yerel Süreci, Bağımsız UI ve Güvenli IPC)

---

## 1. Mimari Sorumluluk Dağılımı

| Sorumluluk Alanı | Proje A (AIDM / Orchestrator) | Proje B (Bağımsız Onay Uygulaması) |
|---|---|---|
| **Görev Planlama & Çıkarım** | **Tam Yetkili.** Director Reasoning Engine ile görevleri ayrıştırır ve planlar. | **Yetkisiz.** Planlama yapmaz. |
| **Kullanıcı Karar İletişimi** | Karar ihtiyacını tespit eder, onay paketini hazırlar ve B'ye iletir. | **Arayüz Sahibi.** İşlem detaylarını bağımsız Windows penceresinde kullanıcıya gösterir, kararı alır. |
| **Bütçe & Token Yönetimi** | **Tam Yetkili.** SQLite Nano-USD bütçe ve rezervasyonunu yönetir. | Bütçe rakamlarını kullanıcıya gösterir; hesaplama veya kural belirlemez. |
| **Politika & Kapsam Denetimi** | **Tam Yetkili.** Project Mandate kurallarına göre izinleri denetler. | Politika kararı vermez; onaylanan işlemin bütünlüğünü garanti eder. |
| **Güvenlik Kapısı (Check 6)** | **Kapı Bekçisi.** B'den gelen kriptografik onay kanıtını doğrular; geçersizse yürütmeyi durdurur (`FAIL-CLOSED`). | **Kanıt Üreticisi.** Kullanıcı onayını TPM donanım anahtarı ve kanonik hash ile mühürleyip A'ya sunar. |
| **Kod & Görev Yürütme** | **Tam Yetkili.** Driver ve AGY üzerinden kodları ve testleri yürütür. | **Kesinlikle Yürütmez.** Sistem komutu veya dosya yazma operasyonu yapmaz. |
| **Bağımsız Kanıt Doğrulama** | **Tam Yetkili.** Dosya hash'i ve Git durumunu EvidenceCollector ile doğrular. | Kanıt toplamaz. |

---

## 2. Entegrasyon ve Çalışma Koşulları

1. **Önce A, Sonra B:** Proje A tamamlanıp doğrulanmadan Proje B entegrasyonu başlamaz.
2. **B Olmadan A'nın Çalışabilirliği:**
   - Proje A, Proje B mevcut olmadığında da mandate kapsamındaki rutin ve yetkilendirilmiş geliştirme görevlerini (kod yazma, test çalıştırma, dosya okuma/yazma) güvenle yürütmeye devam eder.
   - İnsan onayı gerektiren bir durum (`REQUIRE_HUMAN_APPROVAL`) oluştuğunda, geçerli bir B kanıtı bulunmadığı için işlem `WAITING_FOR_APPROVAL` durumuna geçer ve `FAIL-CLOSED` olarak bekletilir.
3. **B'nin Bağımsızlığı:**
   - Proje B hiçbir koşulda Antigravity IDE içindeki sohbet kanalını veya `default_api:ask_question` aracını onay mekanizması olarak kullanmaz.
   - AGY süreci çöktüğünde veya askıya alındığında dahi B uygulaması kullanıcıya açık ve şeffaf kalır.

---

## 3. Veri Sözleşmesi (Data Contract)

### 3.1 AIDM -> B: Onay Talebi Yükü (ApprovalRequestPayload)

AIDM, onay gerektiren bir işlem için B uygulamasına aşağıdaki değişmez JSON veri yapısını iletir:

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
  "summary": "Ürün gereksinimleri kapsamına yeni ödeme kütüphanesi ekleniyor.",
  "riskLevel": "HIGH",
  "impact": {
    "filesModified": ["packages/core/src/policy/policy-engine.ts"],
    "commandsAllowed": ["npm test"],
    "budgetImpactNanoUsd": "0"
  },
  "nonce": "a7f1c98e-4d5a-4e89-8123-bc9a12e4f012",
  "issuedAt": "2026-10-04T12:00:00.000Z",
  "expiresAt": "2026-10-04T12:05:00.000Z"
}
```

### 3.2 Kanonik İşlem Özeti (Canonical Transaction Hash)

Payload içerisindeki kritik alanlar deterministik (alfabetik sıralı ve boşluksuz) olarak serileştirilir ve SHA-256 özeti alınır:

$$\text{canonicalTransactionHash} = \text{SHA256}(\text{projectId} \parallel \text{workspaceId} \parallel \text{directorSessionId} \parallel \text{taskId} \parallel \text{actionId} \parallel \text{mandateRevision} \parallel \text{contextFingerprint} \parallel \text{nonce} \parallel \text{actionType})$$

Kullanıcının yerel B arayüzünde gördüğü işlem özeti bu hash ile birebir eşleşir.

### 3.3 B -> AIDM: Onay Yanıt Yükü (ApprovalResponsePayload)

Kullanıcı yerel Windows arayüzünde işlemi inceleyip karar verdiğinde B tarafından AIDM'ye iletilen yanıt:

```json
{
  "protocolVersion": "1.0.0",
  "requestId": "req-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "decision": "APPROVED", // "APPROVED" | "REJECTED" | "CANCELLED"
  "canonicalTransactionHash": "8c591a27e742880d8591f8691f64f434a94966d54cf8e309cbba6b8e8b0b9736",
  "nonce": "a7f1c98e-4d5a-4e89-8123-bc9a12e4f012",
  "decidedAt": "2026-10-04T12:01:15.000Z",
  "authProof": {
    "proofType": "WINDOWS_TPM_ECDSA_SHA256",
    "keyFingerprint": "tpm-ksp-ed25519-c782b1",
    "signature": "MEQCIC0bK8q...3kL9qA==",
    "signedData": "canonicalTransactionHash + decidedAt + APPROVED"
  }
}
```

---

## 4. ExecutionBridge Check 6 Doğrulama Kriterleri

AIDM `ExecutionBridge`, B'den gelen yanıtı aldığında şu kontrollerin tamamı başarıyla geçmelidir:

1. **Nonce & Replay Denetimi:** `nonce`, daha önce kullanılmış bir nonce olmamalıdır (`NonceStore` üzerinden doğrulanır).
2. **Süre Aşımı Denetimi:** `decidedAt <= expiresAt` ve mevcut zaman aralığı geçerli olmalıdır.
3. **Kanonik Hash Eşleşmesi:** AIDM'in kendi hazırladığı `canonicalTransactionHash` ile yanıttaki hash bit düzeyinde eşit olmalıdır. Karar sonrasında görevde en ufak bir dosya veya bağlam değişikliği olduysa hash uyuşmaz ve işlem reddedilir.
4. **Kriptografik İmza Denetimi:** İmza, B'nin tescilli public key'i üzerinden doğrulanmalıdır.
5. **Karar Kontrolü:** `decision === "APPROVED"` olmalıdır. Eğer `REJECTED` veya `CANCELLED` ise işlem fail-closed olarak iptal edilir.
6. **İstemci Beyanlarının Reddi:** Yanıt bir MCP istemcisinden veya LLM çıktısından gelmişse, içinde `isTrustedHumanAuth: true` veya `authStatus: VERIFIED_HUMAN` yazsa dahi kesin olarak reddedilir.

---

## 5. Engellenemeyen Tehditler ve Kalan Riskler

Bu sözleşme aşağıdaki sistem sınırlamalarını açıkça beyan eder:

1. **Same-User DAC Sınırı:** Kullanıcının bilgisayarında aynı kullanıcı oturumunda çalışan kötü niyetli bir yazılım belleği okuyabilir (`ReadProcessMemory`) veya UI Automation ile pencerelere tıklayabilir. Bu risk, harici donanım ekranı veya ayrı Windows hesabı olmaksızın işletim sistemi gereği %100 engellenemez.
2. **Kör İmzalama Azaltımı:** B arayüzü sayesinde kullanıcı neyi onayladığını ekranda detaylarıyla görür; böylece Windows Hello modalının işlem detayı göstermeme açığı kapatılmış olur (WYSIWYS sağlanır).
3. **AGY Yalıtımı:** AGY hiçbir şekilde bu kanalın tarafı veya taşıyıcısı olamaz.
