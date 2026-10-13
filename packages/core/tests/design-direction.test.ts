/** Director-owned design direction: proposal normalization, binding brief, CSS token check ('bayan kuaförü sitesi' fixture). */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  normalizeClarificationProposal, resolveClarification, renderChecksScript, normalizeDesign, designBriefText,
  saveDesignBrief, loadDesignBrief, CLARIFICATION_SYSTEM_PROMPT, DESIGN_QUESTION_ID,
} from '../dist/autonomous/index.js';

const KUAFOR = {
  summary: 'Bayan kuaförü için tanıtım ve randevu sitesi.',
  questions: [
    {
      id: DESIGN_QUESTION_ID, kind: 'CLARIFICATION', question: 'Site hangi görsel tasarım yönünde olsun?',
      reason: 'Hedef kitle kadınlar; gözü yormayan, akıcı ama premium bir görünüm önemli.', recommendedOptionId: 'zarif-sakin', allowFreeText: true,
      options: [
        { id: 'zarif-sakin', label: 'Zarif ve sakin', design: {
          name: 'Zarif ve sakin', rationale: 'Kadın müşteriler için gözü yormayan, sakin ve premium bir his.',
          palette: { 'renk-zemin': '#F7F2EC', 'renk-vurgu': '#C9A99A', 'renk-metin': '#2E2A28', 'renk-altin': '#B08D57' },
          fonts: { heading: '"Cormorant Garamond", serif', body: '"Nunito Sans", sans-serif' },
          layout: 'Bol beyaz alan, tek sütunlu akış, belirgin randevu butonu', imagery: 'Gerçek salon fotoğrafları, yumuşak ışık',
          tone: 'Sıcak, güven veren, sade', emoji: 'kullanılmaz' } },
        { id: 'modern-pudra', label: 'Modern pudra', design: {
          name: 'Modern pudra', rationale: 'Daha genç kitle için yumuşak pudra tonları.',
          palette: { 'renk-zemin': '#FFF8F6', 'renk-vurgu': '#E8B4B8', 'renk-metin': '#3A3335' },
          fonts: { heading: '"Playfair Display", serif', body: '"Inter", sans-serif' }, layout: 'Asimetrik', imagery: 'Detay çekimleri', tone: 'Neşeli', emoji: 'yalnızca hizmet etiketlerinde ✂️' } },
      ],
    },
  ],
};

// Values are read from the fixture input, never hardcoded in assertions.
const OPT0 = KUAFOR.questions[0]!.options[0]!.design;
const OPT1 = KUAFOR.questions[0]!.options[1]!.design;
const [k0, v0] = Object.entries(OPT0.palette)[0]!;
const [k1, v1] = Object.entries(OPT1.palette)[1]!;
const metin = Object.entries(OPT0.palette).find(([k]) => k.includes('metin'))!;

describe('design direction (fixture: "bayan kuaförü sitesi")', () => {
  it('prompt: Director owns the design from subject+audience, no generic AI look, emoji allowed, nothing hardcoded', () => {
    assert.match(CLARIFICATION_SYSTEM_PROMPT, /design-direction/);
    assert.match(CLARIFICATION_SYSTEM_PROMPT, /purple\/blue gradients/);
    assert.match(CLARIFICATION_SYSTEM_PROMPT, /Emoji are allowed/);
    assert.match(CLARIFICATION_SYSTEM_PROMPT, /subject and audience/);
    assert.doesNotMatch(CLARIFICATION_SYSTEM_PROMPT, /#[0-9a-fA-F]{3,8}\b|kuaför/, 'no concrete palette or example baked into the prompt');
  });

  it('options show hex palette + fonts to the PO and carry binding criteria + a css_tokens check', () => {
    const p = normalizeClarificationProposal(KUAFOR, ['TASK-001']);
    const q = p.questions[0]!;
    assert.equal(q.options.length, 2);
    const o = q.options[0]!;
    assert.ok(o.description!.includes(v0.toLowerCase()));
    assert.ok(o.description!.includes(OPT0.fonts.heading));
    assert.ok(o.criteria.some((c: string) => c.includes(`--${k0}: ${v0.toLowerCase()}`)));
    assert.ok(o.criteria.some((c: string) => c.includes('uydurulmaz')), 'AGY must not invent a palette');
    assert.equal(o.checks[0]!.type, 'css_tokens');
    assert.equal(q.recommendedOptionId, 'zarif-sakin');
  });

  it('a design without hex colours / fonts is not a design', () => {
    assert.equal(normalizeDesign({ palette: { a: 'mor' }, fonts: {} }), null);
    assert.equal(normalizeDesign({ palette: { a: '#111', b: '#222' }, fonts: { heading: 'x', body: 'y' } }), null);
  });

  it('chosen direction becomes the binding brief (stored) and a Director note; recommended when not answered', async () => {
    const p = normalizeClarificationProposal(KUAFOR, ['TASK-001']);
    const st = { questions: p.questions };
    const rec = resolveClarification(st);
    assert.equal(rec.designBrief!.optionId, 'zarif-sakin');
    assert.equal(rec.designBrief!.decidedBy, 'RECOMMENDED');
    const po = resolveClarification(st, [{ questionId: DESIGN_QUESTION_ID, selectedOptionId: 'modern-pudra' }]);
    assert.equal(po.designBrief!.optionId, 'modern-pudra');
    assert.equal(po.designBrief!.decidedBy, 'PO');
    assert.ok(po.notes.some((n: string) => n.startsWith('[design-brief]') && n.includes(`--${k1}: ${v1.toLowerCase()}`)));
    assert.match(designBriefText(po.designBrief!), /do not invent any other palette/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-brief-'));
    try {
      await saveDesignBrief(dir, rec.designBrief!);
      assert.equal(loadDesignBrief(dir)!.tokens['font-baslik'], OPT0.fonts.heading);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generated check script passes only when the shared CSS defines every token', () => {
    const rec = resolveClarification({ questions: normalizeClarificationProposal(KUAFOR, ['TASK-001']).questions });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-css-'));
    try {
      fs.writeFileSync(path.join(dir, 'check.mjs'), renderChecksScript(rec.checks));
      fs.mkdirSync(path.join(dir, 'assets'));
      const css = path.join(dir, 'assets', 'style.css');
      const all = Object.entries({ ...OPT0.palette, 'font-baslik': OPT0.fonts.heading, 'font-govde': OPT0.fonts.body });
      const decl = (list: Array<[string, string]>) => `:root {\n${list.map(([k, v]) => `  --${k}: ${v};`).join('\n')}\n}\n`;
      fs.writeFileSync(css, decl(all.filter(([k]) => k !== metin[0])));
      const bad = spawnSync('node', ['check.mjs'], { cwd: dir, encoding: 'utf8' });
      assert.equal(bad.status, 1);
      assert.ok(bad.stdout.includes(`eksik değişkenler: --${metin[0]}: ${metin[1].toLowerCase()}`), bad.stdout);
      fs.writeFileSync(css, decl(all.map(([k, v]) => [k, k.startsWith('renk') ? v.toUpperCase() : v])));
      const out = execFileSync('node', ['check.mjs'], { cwd: dir, encoding: 'utf8' });
      assert.match(out, /PASS Ortak CSS tasarım değişkenlerini tanımlıyor/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
