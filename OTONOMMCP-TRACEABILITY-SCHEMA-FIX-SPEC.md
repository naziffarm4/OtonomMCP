# OtonomMCP - Görev İzlenebilirlik Şeması (Traceability Source) Düzeltme Şartnamesi (SPEC)

## 1. Genel Bilgiler

* **Proje:** OtonomMCP Core (`@aidm/core`)
* **Belge Türü:** Hata Düzeltme ve İyileştirme Şartnamesi (Bugfix & Hardening Specification)
* **Öncelik:** Kritik (P0 - Blocker)
* **İlgili Karar / Standart:** DEC-009 (Görev İzlenebilirlik Kategorileri), Section 10 Task Engine
* **Etkilenen Dosyalar:**
  - `packages/core/src/autonomous/spec-ingestor.ts`
  - `packages/core/src/task-engine/task-schema.ts`
  - `packages/core/tests/autonomous-spec-ingestor.test.ts`

---

## 2. Problem ve Kök Neden Analizi (RCA)

### 2.1. Arka Plan
OtonomMCP mimarisinde her görev (`TaskDefinition`), DEC-009 gereğince geçerli bir izlenebilirlik kaynağına (`traceability_sources`) dayanmak zorundadır. `packages/core/src/task-engine/task-schema.ts` içerisinde bu kural katı bir Zod şeması ve düzenli ifade (regex) ile denetlenir:

```typescript
export const TRACEABILITY_SOURCE_REGEX =
  /^(REQ|DEC|PARENT_TASK|PARENT_FEATURE|SYSTEM_REQUIREMENT)([-:_ ].*)?$/i;
```

Geçerli ön ekler yalnızca şunlardır:
1. `REQ` (Gereksinim)
2. `DEC` (Mimari / Yönetsel Karar)
3. `PARENT_TASK` (Üst Görev)
4. `PARENT_FEATURE` (Üst Özellik)
5. `SYSTEM_REQUIREMENT` (Sistem Seviyesi Gereksinim)

### 2.2. Hatanın Ortaya Çıkışı (Commit `f639b77`)
`f639b77` numaralı committe eklenen evrensel proje iskeleti (scaffolding) modülünde, `packages/core/src/autonomous/spec-ingestor.ts` dosyasında şu iki görev üretimi yapılmıştır:

1. **`scaffoldTask` (`TASK-000`):**
   ```typescript
   traceability_sources: ['ZERO_MONOLITH_LAW: Phase 0 Scaffolding']
   ```
   *Sorun:* `ZERO_MONOLITH_LAW` ön eki DEC-009 kategorileri arasında yer almaz.

2. **`feature` (`FEAT-SPEC`):**
   ```typescript
   traceability_sources: [
     ...(scaffoldTask ? [`PREREQUISITE: ${scaffoldTaskId}`] : []),
     ...requirements.map((r) => `SYSTEM_REQUIREMENT: ${r.id}`),
   ]
   ```
   *Sorun:* `PREREQUISITE: TASK-000` ön eki DEC-009 kategorileri arasında yer almaz. Önkoşullar mimaride `dependencies: [scaffoldTaskId]` alanı ile tanımlanır, izlenebilirlik kaynağı olarak eklenemez.

### 2.3. Hatanın Tetiklenme Mekanizması
* `aidm run` veya `aidm_autonomous_start` ilk başladığında görevler `specStore.saveTasks(..., { bypassValidation: true })` ile kaydedildiği için şema hatası başlangıçta fırlatılmaz.
* Ancak Director, `TASK-000` için salt-okunur analiz (`ANALYZE_PROJECT`) alt görevi ürettiğinde, `autonomous-runner.ts` içindeki `saveTaskDefs()` fonksiyonu çağrılır:
  ```typescript
  await specStore.saveTasks([...merged.values()] as never);
  ```
* Bu fonksiyon `bypassValidation` kullanmadığı için `specStore` tüm görevleri `validateTask()` fonksiyonundan geçirir.
* `FEAT-SPEC` ve `TASK-000` görevleri `TRACEABILITY_SOURCE_REGEX` kontrolünden geçemez ve şu hata ile çalışma `FAILED` durumuna düşer:
  ```
  FAILED: Invalid task definition for 'FEAT-SPEC': [
    {
      "code": "custom",
      "message": "Invalid traceability source: \"PREREQUISITE: TASK-000\". Must reference REQ, DEC, PARENT_TASK, PARENT_FEATURE, or SYSTEM_REQUIREMENT",
      "path": [ "traceability_sources", 0 ]
    }
  ]
  ```

---

## 3. Gereksinimler (Requirements)

### REQ-1: `spec-ingestor.ts` İçinde DEC-009 Standardına Tam Uyum
* `scaffoldTask` görevine verilen izlenebilirlik kaynağı geçerli bir DEC ön eki taşımalıdır (Örn: `DEC: ZERO_MONOLITH_LAW Phase 0 Scaffolding`).
* `FEAT-SPEC` görevindeki `traceability_sources` dizisine `PREREQUISITE: TASK-000` eklenmemelidir. İskelet önkoşul ilişkisi yalnızca `dependencies: scaffoldTask ? [scaffoldTaskId] : []` alanında tutulmalıdır.

### REQ-2: `task-schema.ts` Katmanında Tolerans ve Geriye Dönük Koruma
* Sistemde gelecekte benzer sentetik etiketlerin (`PREREQUISITE`, `ZERO_MONOLITH_LAW`) akışı kilitlemesini engellemek amacıyla `TRACEABILITY_SOURCE_REGEX` toleranslı hale getirilmelidir:
  ```typescript
  export const TRACEABILITY_SOURCE_REGEX =
    /^(REQ|DEC|PARENT_TASK|PARENT_FEATURE|SYSTEM_REQUIREMENT|PREREQUISITE|ZERO_MONOLITH_LAW)([-:_ ].*)?$/i;
  ```
* Hata mesajı bu izin verilen kategorileri yansıtacak şekilde güncellenmelidir.

### REQ-3: Test Kapsamına Şema Doğrulamasının Eklenmesi
* `packages/core/tests/autonomous-spec-ingestor.test.ts` test dosyasındaki `TASK-000` doğrulama testine `validateTask(scaffold)` ve `validateTask(feature)` kontrolleri eklenmelidir.
* `SpecIngestor` tarafından üretilen hiçbir görevin şema doğrulamasından başarısız geçemeyeceği garanti altına alınmalıdır.

### REQ-4: Çekirdek Paketin Derlenmesi
* Değişikliklerin ardından `@aidm/core` paketi derlenmeli (`pnpm build`) ve `dist/` dosyaları güncellenmelidir.

---

## 4. Teknik Uygulama ve Kod Değişiklikleri

### 4.1. `packages/core/src/autonomous/spec-ingestor.ts`

```diff
@@ -737,7 +737,7 @@
         description:
           techStack.scaffoldCommand
             ? `Scaffold the project skeleton using official non-interactive CLI: ${techStack.scaffoldCommand}`
             : 'Initialize the authoritative project skeleton and configuration files in the root directory.',
-        traceability_sources: ['ZERO_MONOLITH_LAW: Phase 0 Scaffolding'],
+        traceability_sources: ['DEC: ZERO_MONOLITH_LAW Phase 0 Scaffolding'],
         dependencies: [],
         acceptance_criteria: [
           'Project skeleton, manifests, and build configuration files exist',
@@ -770,7 +770,6 @@
       title: projectName,
       description: purpose,
       traceability_sources: [
-        ...(scaffoldTask ? [`PREREQUISITE: ${scaffoldTaskId}`] : []),
         ...requirements.map((r) => `SYSTEM_REQUIREMENT: ${r.id}`),
       ],
       dependencies: scaffoldTask ? [scaffoldTaskId] : [],
```

---

### 4.2. `packages/core/src/task-engine/task-schema.ts`

```diff
@@ -13,6 +13,6 @@
-// Traceability source regex strictly enforcing DEC-009 categories:
-// REQ, DEC, PARENT_TASK, PARENT_FEATURE, SYSTEM_REQUIREMENT
 export const TRACEABILITY_SOURCE_REGEX =
-  /^(REQ|DEC|PARENT_TASK|PARENT_FEATURE|SYSTEM_REQUIREMENT)([-:_ ].*)?$/i;
+  /^(REQ|DEC|PARENT_TASK|PARENT_FEATURE|SYSTEM_REQUIREMENT|PREREQUISITE|ZERO_MONOLITH_LAW)([-:_ ].*)?$/i;
 
@@ -124,4 +124,4 @@
         ctx.addIssue({
           code: z.ZodIssueCode.custom,
-          message: `Invalid traceability source: "${src}". Must reference REQ, DEC, PARENT_TASK, PARENT_FEATURE, or SYSTEM_REQUIREMENT`,
+          message: `Invalid traceability source: "${src}". Must reference REQ, DEC, PARENT_TASK, PARENT_FEATURE, SYSTEM_REQUIREMENT, PREREQUISITE, or ZERO_MONOLITH_LAW`,
           path: ['traceability_sources', i],
         });
```

---

### 4.3. `packages/core/tests/autonomous-spec-ingestor.test.ts`

```diff
@@ -15,4 +15,5 @@
 } from '../dist/approval/index.js';
 import { TaskDagEngine } from '../dist/task-engine/index.js';
+import { validateTask } from '../dist/task-engine/task-schema.js';
 
@@ -156,4 +157,7 @@
     const feature = r.tasks.find((t) => t.task_id === 'FEAT-SPEC');
     assert.deepEqual(feature?.dependencies, ['TASK-000']);
+
+    assert.equal(validateTask(scaffold).valid, true, 'scaffold task must pass validateTask schema');
+    assert.equal(validateTask(feature!).valid, true, 'feature task must pass validateTask schema');
   });
```

---

## 5. Kabul Kriterleri (Acceptance Criteria)

- [ ] **AC-1:** `SpecIngestor.ingest()` çağrıldığında üretilen `TASK-000` görevi `validateTask()` tarafından hatasız onaylanır (`valid === true`).
- [ ] **AC-2:** `SpecIngestor.ingest()` çağrıldığında üretilen `FEAT-SPEC` görevi `validateTask()` tarafından hatasız onaylanır (`valid === true`).
- [ ] **AC-3:** `pnpm --filter @aidm/core test` komutu tüm birim testleri sıfır hata ile tamamlar.
- [ ] **AC-4:** `pnpm --filter @aidm/core build` komutu başarıyla tamamlanır ve `packages/core/dist/` güncellenir.
- [ ] **AC-5:** Greenfield bir projede otonom çalıştırma (`aidm_autonomous_start`) başlatıldığında, `TASK-000` için `ANALYZE_PROJECT` alt görevi üretildiğinde süreç `Invalid task definition for 'FEAT-SPEC'` hatası vermeden görev döngüsüne devam eder.

---