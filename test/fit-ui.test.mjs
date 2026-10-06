// Page tests of the automatic skill fit (docs/auto-skills.md §4): the "Skills for this project" section of the project
// drawer (list, selection, bands, folded parts, reasons, problem texts, the preview banner, the result line, the
// request it sends) and the "N fit" badge of the project list (count and request limits). Pure helpers only: no DOM,
// no network (the badge scheduler gets a fake fetch). Run: node --test test/fit-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  autoSelection,
  ensureFitSelection,
  fitSignature,
  fitView,
  FIT_MAIN_MAX,
  fitReasonText,
  fitReasonsText,
  fitProblemText,
  fitBlockedText,
  fitSourceText,
  fitTagLabel,
  fitOutcome,
  fitOutcomeHtml,
  fitSectionHtml,
  offBannerHtml,
  fitRequestBody,
  fitRequestKey,
  planCounts,
} from '../public/js/views/drawer.js';
import { fitBadgeCount, fitBadgeHtml, createFitBadges } from '../public/js/views/projects.js';
import { actionBody } from '../public/js/actions.js';
import { esc } from '../public/js/format.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';
import { TAGS } from '../server/tags.mjs';
import { scoreItem, KEY_RE } from '../server/fit.mjs';

// Runs fn in each page language; English is restored after
function inLanguages(fn) {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      fn(lang, STRINGS[lang]);
    }
  } finally {
    setLanguage('en');
  }
}
function inTurkish(fn) {
  try {
    setLanguage('tr');
    return fn(STRINGS.tr);
  } finally {
    setLanguage('en');
  }
}

const NAMES = { demo: 'Demo', shop: 'Web Shop' };
const nameOf = (id) => NAMES[id] || id;
const P = { id: 'game', name: 'Arena Game', via: ['claude-code'] };

// A fit in the shape of GET /api/projects/<id>/fit (server/fit.mjs publicFit)
function fixtureFit() {
  const c = (key, extra) => {
    const [kind, rest] = key.split(':');
    return { key, kind, name: rest.split('@')[0], description: `${rest} description`, sources: ['library'], installable: true, installed: false, confidence: 'high', score: 10, reasons: ['stack:unity'], tags: ['unity'], selected: false, ...extra };
  };
  return {
    project: {
      id: 'game',
      tags: [
        { id: 'unity', type: 'stack', from: 'Assets/, ProjectSettings/' },
        { id: 'csharp', type: 'stack', from: '*.cs x12' },
        { id: 'testing', type: 'topic', from: 'Assets/Tests/' },
      ],
      entries: 120,
      truncated: false,
    },
    candidates: [
      c('skill:unity-physics', { selected: true, score: 13, reasons: ['stack:unity', 'installed-in:demo'] }),
      c('skill:unity-netcode', { selected: true, sources: ['project:demo'], reasons: ['stack:unity', 'used-in:demo'] }),
      c('agent:unity-reviewer', { selected: true, score: 8 }),
      c('skill:unity-extra', { selected: false, score: 8 }),
      c('skill:unity-dup@demo', { name: 'unity-dup', sources: ['project:demo'], installable: false, blocked: 'library-conflict', score: 10 }),
      c('skill:code-review', { confidence: 'medium', score: 4, reasons: ['topic:testing'], tags: ['testing'] }),
      c('skill:misc-helper', { confidence: 'low', score: 2, reasons: [], tags: [] }),
      c('skill:unity-ui', { installed: true, installable: false, reasons: ['stack:unity'] }),
    ],
    active: [{ key: 'skill:personal-tester', kind: 'skill', name: 'personal-tester', description: 'tests', source: 'personal', tags: ['testing'], confidence: 'low', score: 2, reasons: ['topic:testing'] }],
    excluded: { count: 3, sample: [{ key: 'skill:rn-navigation', kind: 'skill', name: 'rn-navigation', stacks: ['react-native'] }, { key: 'skill:next-router', kind: 'skill', name: 'next-router', stacks: ['nextjs'] }] },
    selection: { skills: 2, agents: 1 },
  };
}
const state = (fit, extra = {}) => ({ data: fit, sel: null, targets: new Set(['claude']), busy: '', confirm: '', out: null, showLow: false, showOthers: true, folds: {}, ...extra });

// Checkbox of a key in the section markup: { checked, disabled } or null when the row is not there
function box(html, key) {
  const m = new RegExp(`<input type="checkbox" data-flow-item="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(html);
  if (!m) return null;
  return { checked: / checked/.test(m[0]), disabled: / disabled/.test(m[0]) };
}

// ---------------- list: selection, bands, folded parts ----------------
test('section list: the automatic selection is checked, possible fits unchecked, weak fits behind "show more", installed and active folded, left-out items counted', () => {
  const fit = fixtureFit();
  assert.deepEqual([...autoSelection(fit)], ['skill:unity-physics', 'skill:unity-netcode', 'agent:unity-reviewer'], 'what the server selected and can be installed');
  const st = state(fit);
  const html = inTurkish(() => fitSectionHtml(P, st, 'dry', nameOf));
  // Selection
  assert.deepEqual(box(html, 'skill:unity-physics'), { checked: true, disabled: false });
  assert.deepEqual(box(html, 'skill:unity-netcode'), { checked: true, disabled: false });
  assert.deepEqual(box(html, 'agent:unity-reviewer'), { checked: true, disabled: false });
  assert.deepEqual(box(html, 'skill:unity-extra'), { checked: false, disabled: false }, 'a strong fit past the caps: listed, unchecked');
  assert.deepEqual(box(html, 'skill:code-review'), { checked: false, disabled: false }, 'a possible fit: listed, unchecked');
  // A strong row that cannot be installed takes none of the five places: it waits behind "show more" with the weak ones
  assert.equal(box(html, 'skill:unity-dup@demo'), null, 'blocked: behind "show more"');
  assert.equal(box(html, 'skill:misc-helper'), null, 'a weak fit waits behind "show more"');
  assert.equal(box(html, 'skill:unity-ui'), null, 'an installed item is never a checkbox');
  assert.match(html, /data-fit-act="more"[^>]*aria-expanded="false"[^>]*>Az uygun olanları da göster \(2\)</);
  const more = inTurkish(() => fitSectionHtml(P, state(fit, { showLow: true }), 'dry', nameOf));
  assert.deepEqual(box(more, 'skill:unity-dup@demo'), { checked: false, disabled: true }, 'blocked: listed, cannot be selected');
  assert.match(more, /kütüphanede bu adda başka bir öğe var/, 'the blocked reason is shown');
  // Bands in the row markup and the order of the server
  assert.match(html, /class="fit-row b-high"><input type="checkbox" data-flow-item="skill:unity-physics"/);
  assert.match(html, /class="fit-row b-medium"><input type="checkbox" data-flow-item="skill:code-review"/);
  const order = ['skill:unity-physics', 'skill:unity-netcode', 'agent:unity-reviewer', 'skill:unity-extra', 'skill:code-review'].map((k) => html.indexOf(`data-flow-item="${k}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'rows in the order the server sent');
  // Folded: already active (installed here + active everywhere), closed; left out with its count and samples
  assert.match(html, /<details class="fit-fold" data-fit-fold="active"><summary>Zaten etkin \(2\)<\/summary>/);
  assert.match(html, /unity-ui<\/span><span class="fit-meta">skill · bu projede kurulu/);
  assert.match(html, /personal-tester<\/span><span class="fit-meta">skill · her projede etkin · kişisel/);
  assert.match(html, /<details class="fit-fold fit-excl" data-fit-fold="excluded"><summary>3 öğe başka tür projeler için olduğundan dışlandı<\/summary>/);
  assert.match(html, /rn-navigation<\/span><span class="fit-meta">skill · yalnız React Native için/);
  assert.match(html, /ve 1 öğe daha/);
  // Header count, tags, the note about items from other projects
  assert.match(html, /Bu projeye uygun skill’ler <span>3 seçili<\/span>/);
  assert.match(html, /<li class="fit-tag stack" title="Assets\/, ProjectSettings\/ içinde bulundu">Unity<\/li>/);
  assert.match(html, /<li class="fit-tag topic"[^>]*>test<\/li>/);
  assert.match(html, /Başka projelerden gelen öğeler önce kütüphaneye eklenir/);

  // Opened: weak fits appear unchecked; the folds keep their state
  st.showLow = true;
  st.folds = { active: true, excluded: true };
  const open = inTurkish(() => fitSectionHtml(P, st, 'dry', nameOf));
  assert.deepEqual(box(open, 'skill:misc-helper'), { checked: false, disabled: false });
  assert.match(open, /class="fit-row b-low">/);
  assert.match(open, /aria-expanded="true"[^>]*>Daha az göster</);
  assert.match(open, /data-fit-fold="active" open>/);
  assert.match(open, /data-fit-fold="excluded" open>/);
});

test('section state: the user selection survives a reload of the same fit; a changed fit starts again from the automatic selection', () => {
  const fit = fixtureFit();
  const st = state(fit);
  assert.equal(ensureFitSelection(st), true, 'first time: started');
  st.sel.delete('skill:unity-netcode');
  st.sel.add('skill:code-review');
  st.data = fixtureFit(); // the same fit loaded again a minute later
  assert.equal(ensureFitSelection(st), false);
  assert.deepEqual([...st.sel].sort(), ['agent:unity-reviewer', 'skill:code-review', 'skill:unity-physics']);
  // After an install the fit changes (the installed items are marked): the automatic selection comes back
  const after = fixtureFit();
  after.candidates[0] = { ...after.candidates[0], installed: true, installable: false, selected: false };
  st.data = after;
  assert.notEqual(fitSignature(after), fitSignature(fit));
  assert.equal(ensureFitSelection(st), true);
  assert.deepEqual([...st.sel].sort(), ['agent:unity-reviewer', 'skill:unity-netcode']);
  // fitView: only selectable keys count; imports and Try items follow the sources
  st.sel.add('skill:unity-dup@demo'); // blocked: never counted even if it slipped into the set
  st.sel.add('skill:unity-ui');
  const v = fitView(after, st, 'live');
  assert.deepEqual(v.keys, ['skill:unity-netcode', 'agent:unity-reviewer']);
  assert.equal(v.imports, 1, 'unity-netcode is only in another project');
  assert.deepEqual(v.tryItems, [{ kind: 'agent', name: 'unity-reviewer' }], 'Try takes library (and kit) items, not items only in other projects');
  assert.equal(v.applyDisabled, false);
  assert.equal(v.empty, null);
  // An item of SiberSentez's own kit is installed straight from the kit: no import, and no "from another project" note
  const kit = fixtureFit();
  kit.candidates = kit.candidates.map((c) => (c.key === 'skill:unity-netcode' ? { ...c, sources: ['kit'] } : c));
  const kv = fitView(kit, { ...st, sel: new Set(['skill:unity-netcode']) }, 'live');
  assert.equal(kv.imports, 0, 'a kit item needs no import');
  assert.deepEqual(kv.keys, ['skill:unity-netcode']);
  assert.deepEqual(kv.tryItems, [{ kind: 'skill', name: 'unity-netcode' }], 'Try takes a kit item too (copied from the kit into the trial folder)');
  assert.equal(kv.tryDisabled, false);
  assert.equal(kv.tryWhy, '');
  // On screen: no "from other projects ... added to the library first" note and no import count in the question
  inLanguages((lang, S) => {
    const kitHtml = fitSectionHtml(P, state(kit, { sel: new Set(['skill:unity-netcode', 'agent:unity-reviewer']), confirm: 'apply' }), 'live', nameOf);
    assert.ok(!kitHtml.includes(esc(S.fitFromProjectNote)), `${lang}: no library-first note for a kit row`);
    assert.ok(!kitHtml.includes(esc(S.fitAskImports.split('{count}')[1].trim())), `${lang}: no import count in the question`);
    // The same row found only in another project does bring both
    const projHtml = fitSectionHtml(P, state(fixtureFit(), { sel: new Set(['skill:unity-netcode', 'agent:unity-reviewer']), confirm: 'apply' }), 'live', nameOf);
    assert.ok(projHtml.includes(esc(S.fitFromProjectNote)), lang);
    assert.ok(projHtml.includes(esc(S.fitAskImports.split('{count}')[1].trim())), lang);
  });
  // Only items in other projects: Try has nothing to copy and says where it takes items from
  const onlyProj = fitView(fixtureFit(), { ...st, sel: new Set(['skill:unity-netcode']) }, 'live');
  assert.deepEqual(onlyProj.tryItems, []);
  assert.equal(onlyProj.tryWhy, STRINGS.en.fitWhyTryKit);
});

test('section: nothing new to propose says so; nothing at all says how to add; empty selection, too many, missing targets keep the button disabled', () => {
  inLanguages((lang, S) => {
    const allIn = { project: { tags: [] }, candidates: [{ key: 'skill:a', kind: 'skill', name: 'a', installed: true, installable: false, confidence: 'high', reasons: [], sources: ['library'] }], active: [], excluded: { count: 0, sample: [] } };
    const h1 = fitSectionHtml(P, state(allIn), 'live', nameOf);
    assert.ok(h1.includes(S.fitNothingNew.replace(/'/g, '&#39;')), lang);
    assert.doesNotMatch(h1, /data-fit-act="apply"/, 'nothing to install: no install button');
    const none = { project: { tags: [] }, candidates: [], active: [], excluded: { count: 0, sample: [] } };
    const h2 = fitSectionHtml(P, state(none), 'live', nameOf);
    assert.ok(h2.includes(S.startWriteIdea.replace(/'/g, '&#39;')), `${lang}: an empty folder and no idea asks for the idea`);
    assert.ok(h2.includes(S.startFolderEmpty), lang);
    // With an idea (or tags in the folder) and still nothing: nothing on this computer fits
    const h3 = fitSectionHtml(P, state(none, { idea: 'Rust ile oyun', ideaWanted: 'Rust ile oyun', dataIdea: 'Rust ile oyun' }), 'live', nameOf);
    assert.ok(h3.includes(S.startNothingFound.replace(/&/g, '&amp;').replace(/'/g, '&#39;')), lang);
  });
  const fit = fixtureFit();
  const st = state(fit);
  ensureFitSelection(st);
  st.sel.clear();
  assert.equal(fitView(fit, st, 'live').applyDisabled, true, 'nothing selected');
  assert.equal(fitView(fit, st, 'live').why, STRINGS.en.skWhySelect);
  ensureFitSelection((st.sel = null, st));
  st.targets = new Set();
  assert.equal(fitView(fit, st, 'live').needTargets, true);
  assert.equal(fitView(fit, st, 'live').applyDisabled, true, 'a skill needs a target');
  const many = { ...fit, candidates: Array.from({ length: 26 }, (_, i) => ({ key: `skill:s${i}`, kind: 'skill', name: `s${i}`, installable: true, installed: false, confidence: 'high', selected: true, sources: ['library'], reasons: [] })) };
  const sm = state(many);
  ensureFitSelection(sm);
  assert.equal(fitView(many, sm, 'live').tooMany, true);
  assert.equal(fitView(many, sm, 'live').applyDisabled, true, 'more than the server takes is never sent');
});

// ---------------- buttons per mode, the request, the confirmation ----------------
test('section buttons: off -> disabled with a short reason, no target picker and no chooser (the drawer banner has it); preview -> "Show what would be installed"; live -> "Install the selected" and a confirmation naming the imports', () => {
  const fit = fixtureFit();
  inTurkish((S) => {
    const off = fitSectionHtml(P, state(fit), 'off', nameOf);
    assert.match(off, /data-fit-act="apply"[^>]*aria-disabled="true"[^>]*>Seçilenleri kur</);
    assert.doesNotMatch(off, /data-fit-act="chooser"/, 'off: the drawer banner carries the one button');
    assert.doesNotMatch(off, /data-flow-target=/, 'off: no target picker');
    assert.ok(off.includes(S.startWhyOff));
    // The banner: once, in off only, with "Turn actions on"
    assert.match(offBannerHtml('off'), /class="dr-off" role="note"><p><b>Eylemler kapalı\.<\/b>[^<]*<\/p><button type="button" class="act-btn primary" data-fit-act="chooser" data-fk="off:chooser">Eylemleri aç</);
    assert.equal(offBannerHtml('dry'), '');
    assert.equal(offBannerHtml('live'), '');
    const dry = fitSectionHtml(P, state(fit), 'dry', nameOf);
    assert.match(dry, /data-fit-act="apply" data-fk="fit:apply">Neyin kurulacağını göster</);
    assert.match(dry, /data-fit-act="try" data-fk="fit:try">Dene \(Claude Code\)</);
    assert.match(dry, /class="cm-badge">önizleme kipi</);
    assert.match(dry, /data-fit-act="chooser"[^>]*>Eylemleri değiştir</, 'preview mode offers "Change actions" before a run too');
    assert.ok(dry.includes(S.startWhyDry), 'preview mode says plainly that the button copies nothing, and how to really install');
    const live = fitSectionHtml(P, state(fit, { confirm: 'apply' }), 'live', nameOf);
    assert.equal((live.match(/data-fit-act="chooser"/g) || []).length, 0, 'actions on: no chooser next to the buttons');
    assert.match(live, /data-fit-act="apply" data-fk="fit:apply">Seçilenleri kur</);
    assert.match(live, /<p id="fitQ">Arena Game projesine 3 öğe kurulsun mu\? Bunların 1 tanesi başka projelerden gelir ve önce kütüphaneye eklenir\.<\/p>/);
    assert.match(live, /data-fit-act="confirm"[^>]*>Evet, kur</);
  });
});

test('install and start: live with an AI tool found offers one "Install and start"; the confirmation can only install; the targets are folded under Advanced', () => {
  const fit = fixtureFit();
  const tool = { id: 'claude', name: 'Claude Code' };
  inTurkish(() => {
    const idle = fitSectionHtml(P, state(fit), 'live', nameOf, tool);
    assert.match(idle, /data-fit-act="apply" data-fk="fit:apply">Kur ve başlat</);
    // The targets: folded, the summary names the chosen ones; open by itself when none is chosen
    assert.match(idle, /<details class="fit-fold fit-where" data-fit-fold="where"><summary>Gelişmiş: nereye kurulacak \(Claude Code \(\.claude\)\)<\/summary>/);
    assert.match(fitSectionHtml(P, state(fit, { targets: new Set() }), 'live', nameOf, tool), /data-fit-fold="where" open><summary>Gelişmiş: nereye kurulacak \(—\)/);
    const ask = fitSectionHtml(P, state(fit, { confirm: 'apply' }), 'live', nameOf, tool);
    assert.match(ask, /kütüphaneye eklenir\. Ardından Claude Code bu projede başlar\.<\/p>/);
    assert.match(ask, /class="act-btn primary" data-fit-act="confirm-start" data-fk="fit:confirm-start">Evet, kur ve Claude Code ile başlat</);
    assert.match(ask, /data-fit-act="confirm" data-fk="fit:confirm">Yalnız kur</);
    // Preview and off never promise a start; off shows no targets at all
    assert.doesNotMatch(fitSectionHtml(P, state(fit), 'dry', nameOf, tool), /Kur ve başlat|confirm-start/);
    assert.doesNotMatch(fitSectionHtml(P, state(fit), 'off', nameOf, tool), /Kur ve başlat|fit-where/);
  });
});

test('request: skills-apply always carries the keys on screen (never the server\'s own selection), targets only with a skill; Try sends library items; actionBody keeps them as they are', () => {
  const fit = fixtureFit();
  const st = state(fit, { targets: new Set(['claude', 'agents']) });
  ensureFitSelection(st);
  const v = fitView(fit, st, 'live');
  const body = fitRequestBody('game', 'apply', v);
  assert.deepEqual(body, { action: 'skills-apply', projectId: 'game', keys: ['skill:unity-physics', 'skill:unity-netcode', 'agent:unity-reviewer'], targets: ['claude', 'agents'] });
  assert.deepEqual(actionBody(body), body, 'the one sender passes it on unchanged');
  for (const k of body.keys) assert.match(k, KEY_RE, 'every key is one the server accepts');
  // Agents only: no targets (agents always go to .claude)
  st.sel = new Set(['agent:unity-reviewer']);
  const agents = fitRequestBody('game', 'apply', fitView(fit, st, 'live'));
  assert.deepEqual(agents, { action: 'skills-apply', projectId: 'game', keys: ['agent:unity-reviewer'] });
  // An empty selection is sent as an empty list (the server refuses it), never as "no keys" (= automatic selection)
  st.sel = new Set();
  const empty = fitRequestBody('game', 'apply', fitView(fit, st, 'live'));
  assert.deepEqual(actionBody(empty).keys, []);
  // Try: library items by kind and name
  st.sel = new Set(['skill:unity-physics', 'skill:unity-netcode']);
  assert.deepEqual(fitRequestBody('game', 'try', fitView(fit, st, 'live')), { action: 'skills-trial', projectId: 'game', items: [{ kind: 'skill', name: 'unity-physics' }] });
  // The confirmation key does not depend on the order
  assert.equal(fitRequestKey({ keys: ['b', 'a'], targets: ['agents', 'claude'] }), fitRequestKey({ keys: ['a', 'b'], targets: ['claude', 'agents'] }));
  assert.notEqual(fitRequestKey({ keys: ['a'], targets: ['claude'] }), fitRequestKey({ keys: ['a', 'b'], targets: ['claude'] }));
});

// ---------------- reasons, tags, sources, blocked ----------------
test('reasons: stack, topic, installed-in and used-in codes are localized; every tag of the dictionary has a name in both languages', () => {
  inLanguages((lang, S) => {
    for (const tag of TAGS) {
      assert.ok(S[`fitTag_${tag.id}`], `${lang} fitTag_${tag.id}`);
      assert.equal(fitTagLabel(tag.id), S[`fitTag_${tag.id}`]);
    }
  });
  inTurkish(() => {
    assert.equal(fitReasonText('stack:unity', nameOf), 'Unity projesi');
    assert.equal(fitReasonText('stack:csharp', nameOf), 'C# projesi');
    assert.equal(fitReasonText('topic:testing', nameOf), 'konu: test');
    assert.equal(fitReasonText('installed-in:demo', nameOf), 'Demo projesinde kurulu');
    assert.equal(fitReasonText('used-in:shop', nameOf), 'Web Shop projesinde kullanıldı');
    assert.equal(fitReasonText('installed-in:unknown-id', nameOf), 'unknown-id projesinde kurulu', 'an unknown project shows its id');
    assert.equal(fitReasonsText(['stack:unity', 'installed-in:demo'], nameOf), 'Unity projesi · Demo projesinde kurulu');
    assert.equal(fitSourceText(['library', 'project:demo'], nameOf), 'kütüphaneden');
    assert.equal(fitSourceText(['project:demo'], nameOf), 'Demo projesinden');
    // SiberSentez's own kit comes first (installable straight from it, like the library)
    assert.equal(fitSourceText(['kit', 'library', 'project:demo'], nameOf), 'SiberSentez setinden');
    assert.equal(fitSourceText(['kit'], nameOf), STRINGS.tr.fitFromKit);
    assert.equal(fitBlockedText('library-conflict'), 'kütüphanede bu adda başka bir öğe var');
    assert.equal(fitBlockedText('too-large'), STRINGS.tr['skReason_too-large']);
  });
  assert.equal(fitReasonText('stack:unity', nameOf), 'Unity project');
  assert.equal(fitReasonText('topic:multiplayer', nameOf), 'topic: multiplayer');
  assert.equal(fitReasonText('installed-in:demo', nameOf), 'installed in Demo');
  // A plain code reads from its own string (fitReason_<code>); an unknown code never shows raw, it reads as a general line
  inLanguages((lang, S) => {
    assert.equal(fitReasonText('empty-folder', nameOf), S['fitReason_empty-folder'], `${lang}: the kit's empty-folder reason`);
    for (const code of ['brand-new:thing', 'brand-new', 'stack', 'installed-in', 'idea-word:', 'other', 'Weird Code', '__proto__', 'constructor']) {
      assert.equal(fitReasonText(code, nameOf), S.fitReason_other, `${lang} ${code}`);
    }
    assert.equal(fitReasonText('', nameOf), '', 'no code, no text');
    assert.equal(fitReasonsText(['empty-folder', 'brand-new', 'other-new', 'stack:unity'], nameOf), [S['fitReason_empty-folder'], S.fitReason_other, fitReasonText('stack:unity', nameOf)].join(' · '), `${lang}: the general line once`);
  });
  // Every reason the server's scoring gives is one the page localizes (never the raw code)
  const profile = { stacks: new Set(['unity', 'csharp']), primary: new Set(['unity']), topics: new Set(['testing', 'multiplayer', 'graphics']) };
  const s = scoreItem(['unity', 'csharp', 'testing', 'multiplayer'], profile, { installedIn: [{ id: 'demo', primary: new Set(['unity']) }], usedIn: [{ id: 'shop', primary: new Set(['unity']) }] });
  assert.ok(s.reasons.length > 0);
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    for (const code of [...s.reasons, 'installed-in:demo', 'used-in:shop', 'topic:graphics']) assert.notEqual(fitReasonText(code, nameOf), code, `${lang} ${code}`);
  }
  setLanguage('en');
});

test('problem texts: every code the fit can carry reads as a plain sentence in both languages; the section then shows it and no button', () => {
  const codes = ['no-hub', 'legacy-hub', 'not-a-project', 'broad-folder', 'folder-missing', 'not-local', 'project-in-hub', 'personal-folder'];
  inLanguages((lang, S) => {
    for (const code of codes) {
      assert.ok(S[`fitProblem_${code}`], `${lang} ${code}`);
      assert.equal(fitProblemText(code), S[`fitProblem_${code}`]);
      const fit = { ...fixtureFit(), problem: code };
      const html = fitSectionHtml(P, state(fit), 'live', nameOf);
      assert.ok(html.includes(`<p class="fit-problem">`), code);
      assert.ok(html.replace(/&#39;/g, "'").includes(S[`fitProblem_${code}`]), `${lang} ${code} shown`);
      assert.doesNotMatch(html, /data-fit-act="apply"|data-flow-item=/, `${code}: nothing to select or install`);
      assert.equal(fitView(fit, state(fit, { sel: new Set(['skill:unity-physics']) }), 'live').applyDisabled, true);
    }
    assert.match(fitProblemText('brand-new-problem'), /brand-new-problem/, 'an unknown code is named, not hidden');
  });
});

// ---------------- the preview banner and the result line ----------------
const copy = (kind, name, target = 'claude') => ({ op: 'copy', kind, name, target, reason: 'new' });
const skip = (kind, name, reason = 'up-to-date', target = 'claude') => ({ op: 'skip', kind, name, target, reason });

test('preview banner: a Preview run says "nothing was copied", what would be installed, and offers the actions chooser; the plan is shown open', () => {
  const plan = [{ op: 'import', kind: 'skill', name: 'unity-netcode', key: 'skill:unity-netcode', category: 'game', reason: 'new', from: 'project:demo' }, copy('skill', 'unity-netcode'), copy('skill', 'unity-physics'), copy('skill', 'unity-physics', 'agents'), copy('agent', 'unity-reviewer'), skip('skill', 'code-review')];
  const r = { ok: true, mode: 'dry', action: 'skills-apply', selection: 'keys', applied: false, reason: 'preview-mode', plan, result: { executed: false, imported: 0, copied: 0, updated: 0 }, status: 200 };
  inTurkish(() => {
    const o = fitOutcome('apply', r);
    assert.equal(o.tone, 'dry');
    assert.equal(o.head, 'Önizleme kipi: hiçbir dosya kopyalanmadı, bu yalnızca plan.');
    assert.equal(o.detail, 'Eylemler açıkken 2 skill ve 1 ajan kurulurdu, 1 atlanırdı. 1 öğe önce kütüphaneye eklenirdi.');
    const html = fitOutcomeHtml({ out: { act: 'apply', r } });
    assert.match(html, /^<div class="fit-banner dry"><p><b>Önizleme kipi: hiçbir dosya kopyalanmadı, bu yalnızca plan\.<\/b> Eylemler açıkken/);
    assert.ok(html.includes(STRINGS.tr.startDryHow), 'the banner says how to really install');
    assert.match(html, /<button type="button" class="act-btn " data-fit-act="chooser" data-fk="fit:chooser">Eylemleri değiştir<\/button>/);
    assert.match(html, /<details class="fit-fold fit-plan" data-fit-fold="planDry" open><summary>Yapılacaklar<\/summary>/);
    assert.match(html, /<span class="plan-op">kütüphaneye ekle<\/span>/, 'the import step has its own word');
    // In the section: the banner right after the buttons, while the list stays
    const st = state(fixtureFit(), { out: { act: 'apply', r } });
    const sec = fitSectionHtml(P, st, 'dry', nameOf);
    assert.ok(sec.indexOf('fit-banner dry') > sec.indexOf('data-fit-act="apply"'));
    assert.equal((sec.match(/data-fit-act="chooser"/g) || []).length, 1, 'one "Change actions": the banner carries it after a run');
    assert.ok(sec.includes('data-flow-item="skill:unity-physics"'));
  });
  // Whatever the server's words, a Preview answer never reads as installed
  for (const odd of [{ ...r, reason: undefined }, { ...r, mode: undefined }, { ...r, mode: 'live', result: { executed: false } }]) assert.equal(fitOutcome('apply', odd).tone, 'dry');
});

test('result line: live install counts items (not targets) as "N skills installed, M skipped"; nothing to do, nothing selected and errors read plainly', () => {
  const eight = Array.from({ length: 8 }, (_, i) => copy('skill', `unity-${i}`));
  const live = (plan, extra = {}) => ({ ok: true, mode: 'live', action: 'skills-apply', applied: true, plan, result: { executed: true, imported: 0, copied: plan.length, updated: 0 }, status: 200, ...extra });
  inTurkish(() => {
    assert.equal(fitOutcome('apply', live(eight)).text, '8 skill kuruldu, 0 atlandı.');
    const html = fitOutcomeHtml({ out: { act: 'apply', r: live(eight) } });
    assert.match(html, /^<p class="fit-result ok">8 skill kuruldu, 0 atlandı\.<\/p><details class="fit-fold fit-plan" data-fit-fold="planLive"><summary>Yapılanlar<\/summary>/);
    // Two targets of one skill are one item; an item with only skips is skipped; imports are named
    const mixed = [{ op: 'import', kind: 'skill', name: 'net', reason: 'new' }, copy('skill', 'net'), copy('skill', 'phys'), copy('skill', 'phys', 'agents'), copy('agent', 'rev'), skip('skill', 'old'), skip('skill', 'old', 'up-to-date', 'agents')];
    assert.deepEqual(planCounts(mixed), { skills: 2, agents: 1, skipped: 1, imports: 1 });
    assert.equal(fitOutcome('apply', live(mixed, { result: { executed: true, imported: 1, copied: 4, updated: 0 } })).text, '2 skill ve 1 ajan kuruldu, 1 atlandı. 1 öğe önce kütüphaneye eklendi.');
    assert.equal(fitOutcome('apply', live([skip('skill', 'a'), skip('skill', 'b')], { applied: false, reason: 'nothing-to-do' })).text, 'Kurulacak yeni bir şey yoktu; 2 atlandı.');
    assert.equal(fitOutcome('apply', live([], { applied: false, reason: 'nothing-selected' })).text, 'Seçili öğe yoktu; hiçbir şey kopyalanmadı.');
    assert.equal(fitOutcome('apply', live(eight, { result: { executed: true, imported: 0, copied: 8, updated: 0, catalogError: true } })).detail, STRINGS.tr.fitCatalogError);
    const err = fitOutcome('apply', { ok: false, status: 409, error: 'busy' });
    assert.equal(err.tone, 'err');
    assert.equal(err.text, STRINGS.tr.skErr_busy);
    assert.match(fitOutcomeHtml({ out: { act: 'apply', r: { ok: false, status: 409, error: 'busy' } } }), /^<p class="fit-result err">/);
    // A failed import turned into a skip: that item counts as skipped
    assert.deepEqual(planCounts([{ op: 'skip', kind: 'skill', name: 'net', reason: 'reparse-point' }, copy('skill', 'phys')]), { skills: 1, agents: 0, skipped: 1, imports: 0 });
  });
  assert.equal(fitOutcome('apply', live(eight)).text, '8 skill(s) installed, 0 skipped.');
  assert.equal(fitOutcome('try', { ok: true, mode: 'dry', argv: ['wt.exe'] }).text, STRINGS.en.skDryNote);
});

// ---------------- escaping ----------------
test('escaping: project name, description, tags, evidence, item names, reasons and left-out samples with HTML show as plain text', () => {
  const bad = '<img src=x onerror=alert(1)>';
  const fit = fixtureFit();
  fit.project.tags = [{ id: `<b>${bad}</b>`, type: 'stack', from: `"><script>alert(2)</script>` }];
  fit.candidates[0] = { ...fit.candidates[0], name: `${bad}`, description: `<script>alert(3)</script>`, reasons: [`installed-in:${bad}`, `stack:${bad}`] };
  fit.candidates[1] = { ...fit.candidates[1], sources: [`project:${bad}`], blocked: bad, installable: false, selected: false };
  fit.active[0] = { ...fit.active[0], name: bad, source: bad, plugin: bad };
  fit.excluded.sample[0] = { ...fit.excluded.sample[0], name: bad, stacks: [bad] };
  const p = { id: 'x"><script>', name: bad, via: [] };
  const st = state(fit, { confirm: 'apply', out: { act: 'apply', r: { ok: false, status: 500, error: bad } }, folds: { active: true, excluded: true } });
  for (const mode of ['off', 'dry', 'live']) {
    const html = inTurkish(() => fitSectionHtml(p, st, mode, (id) => id));
    assert.doesNotMatch(html, /<img|<script|<b>/i, mode);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, mode);
  }
  assert.doesNotMatch(fitBadgeHtml('"><img src=x>', 3), /<img/);
});

// ---------------- the badge ----------------
test('badge count: strong fits that can be installed and are not in the project yet, one per name; none with a problem', () => {
  const fit = fixtureFit();
  assert.equal(fitBadgeCount(fit), 3, 'unity-physics, unity-reviewer, unity-extra (blocked, installed, weaker ones and those only in other projects do not count)');
  fit.candidates.push({ ...fit.candidates[0], key: 'skill:unity-physics@demo', sources: ['project:demo'] });
  assert.equal(fitBadgeCount(fit), 3, 'two variants of one name count once');
  // What the drawer lists before "also from my other projects": the kit counts like the library
  fit.candidates.push({ ...fit.candidates[0], key: 'skill:kit-one', name: 'kit-one', sources: ['kit'] });
  assert.equal(fitBadgeCount(fit), 4);
  assert.equal(fitBadgeCount({ ...fit, problem: 'broad-folder' }), 0);
  assert.equal(fitBadgeCount(null), 0);
  assert.equal(fitBadgeCount({ candidates: 'x' }), 0);
  inLanguages((lang, S) => {
    assert.equal(fitBadgeHtml('p1', 0), '');
    const h = fitBadgeHtml('p1', 3);
    assert.match(h, /^<button type="button" class="fit-badge" data-fit-open="p1"/);
    assert.ok(h.includes(`<span>${S.fitBadge.replace('{count}', '3')}</span>`), lang);
  });
});

// A fake fetch whose answers the test releases one by one
function fakeFits(answers) {
  const calls = [];
  let open = 0;
  let maxOpen = 0;
  const waiting = [];
  const fetchFit = (id) => {
    calls.push(id);
    open++;
    maxOpen = Math.max(maxOpen, open);
    return new Promise((resolve, reject) => waiting.push({ id, resolve: () => (open--, resolve(answers[id] ?? { candidates: [] })), reject: () => (open--, reject(new Error('500'))) }));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { fetchFit, calls, waiting, maxOpen: () => maxOpen, flush };
}
const highFit = (n) => ({ candidates: Array.from({ length: n }, (_, i) => ({ key: `skill:s${i}`, kind: 'skill', name: `s${i}`, confidence: 'high', installable: true, installed: false, sources: ['kit'] })) });

test('badge requests: only visible projects, one request at a time, each answer cached; cards scrolled away are dropped; ineligible projects never asked', async () => {
  const f = fakeFits({ a: highFit(2), b: highFit(0), c: highFit(5) });
  let clock = 1000;
  const changed = [];
  const b = createFitBadges({ fetchFit: f.fetchFit, eligible: (id) => id !== 'broad', onChange: (id) => changed.push(id), now: () => clock, ttl: 60000, failTtl: 10000 });
  b.want(['a', 'b', 'broad', 'a']);
  await f.flush();
  assert.deepEqual(f.calls, ['a'], 'one request at a time; duplicates and ineligible ids never queued');
  assert.equal(b.pending(), 2);
  // The user scrolls: b is no longer visible, c is; b is dropped before its request
  b.want(['a', 'c']);
  f.waiting.shift().resolve();
  await f.flush();
  assert.deepEqual(f.calls, ['a', 'c']);
  f.waiting.shift().resolve();
  await f.flush();
  assert.equal(f.maxOpen(), 1, 'never two requests at once');
  assert.equal(b.count('a'), 2);
  assert.equal(b.count('c'), 5);
  assert.deepEqual(changed, ['a', 'c']);
  // Visible again: cached, no request
  b.want(['a', 'c']);
  await f.flush();
  assert.deepEqual(f.calls, ['a', 'c']);
  assert.equal(b.stats.requests, 2);
  // After the cache time: asked again, once
  clock += 60001;
  b.want(['a']);
  await f.flush();
  assert.deepEqual(f.calls, ['a', 'c', 'a']);
  f.waiting.shift().resolve();
  await f.flush();
  assert.deepEqual(changed, ['a', 'c'], 'the same number: no redraw');
  assert.equal(b.pending(), 0);
});

test('badge requests: a failure is retried only after failTtl and keeps the last number; a fit from the drawer is taken without a request', async () => {
  const f = fakeFits({ a: highFit(3) });
  let clock = 0;
  const changed = [];
  const b = createFitBadges({ fetchFit: f.fetchFit, onChange: (id) => changed.push(id), now: () => clock, ttl: 60000, failTtl: 10000 });
  b.note('a', highFit(3));
  assert.equal(b.count('a'), 3);
  assert.deepEqual(changed, ['a']);
  b.want(['a']);
  await f.flush();
  assert.deepEqual(f.calls, [], 'the drawer\'s fit counts as a fresh answer');
  clock = 60001;
  b.want(['a']);
  await f.flush();
  f.waiting.shift().reject();
  await f.flush();
  assert.equal(b.count('a'), 3, 'a failed request keeps the last number');
  clock += 5000;
  b.want(['a']);
  await f.flush();
  assert.equal(f.calls.length, 1, 'not again before failTtl');
  clock += 5001;
  b.want(['a']);
  await f.flush();
  assert.equal(f.calls.length, 2, 'again after failTtl');
  f.waiting.shift().resolve();
  await f.flush();
  // A note while a request for another project waits removes the noted one from the queue
  const g = fakeFits({ x: highFit(1), y: highFit(1) });
  const b2 = createFitBadges({ fetchFit: g.fetchFit, now: () => 0 });
  b2.want(['x', 'y']);
  await g.flush();
  b2.note('y', highFit(4));
  g.waiting.shift().resolve();
  await g.flush();
  assert.deepEqual(g.calls, ['x'], 'y came from the drawer: never requested');
  assert.equal(b2.count('y'), 4);
});

// ---------------- a short list first (docs/direction.md §3.2) ----------------
test('short list: at most five fits from the kit and the library; the rest behind "show more"; items only in other projects behind their own switch and out of the selection', () => {
  assert.equal(FIT_MAIN_MAX, 5);
  const row = (name, sources, extra = {}) => ({ key: `skill:${name}`, kind: 'skill', name, description: name, sources, installable: true, installed: false, confidence: 'high', score: 10, reasons: [], selected: false, ...extra });
  const fit = {
    project: { tags: [] },
    candidates: [
      row('far-a', ['project:demo'], { selected: true, score: 20 }),
      ...Array.from({ length: 7 }, (_, i) => row(`kit-${i}`, [i % 2 ? 'library' : 'kit'], { selected: i < 2, score: 15 - i })),
      row('far-b', ['project:demo'], { confidence: 'medium', score: 5 }),
    ],
    active: [],
    excluded: { count: 0, sample: [] },
  };
  const st = { data: fit, sel: null, targets: new Set(['claude']), showLow: false, folds: {} };
  inTurkish((S) => {
    const html = fitSectionHtml(P, st, 'live', nameOf);
    for (let i = 0; i < 5; i++) assert.ok(box(html, `skill:kit-${i}`), `kit-${i} in the first five`);
    assert.equal(box(html, 'skill:kit-5'), null, 'the sixth waits behind "show more"');
    assert.equal(box(html, 'skill:far-a'), null, 'only in another project: hidden by default, however strong');
    assert.match(html, /data-fit-act="more"[^>]*>Az uygun olanları da göster \(2\)</);
    assert.match(html, /data-fit-act="others" data-fk="fit:others" aria-expanded="false">Diğer projelerimden de göster \(2\)</);
    assert.ok(!html.includes(esc(S.fitFromProjectNote)), 'no "added to the library first" note while they are hidden');
    // The server selected far-a too: hidden, it is not installed
    const v = fitView(fit, st, 'live');
    assert.deepEqual(v.keys, ['skill:kit-0', 'skill:kit-1']);
    assert.equal(v.imports, 0);
    // The switch: they join the list (the selected one among the first places) and the selection
    const on = fitView(fit, { ...st, showOthers: true }, 'live');
    assert.deepEqual(on.keys, ['skill:far-a', 'skill:kit-0', 'skill:kit-1']);
    assert.equal(on.main[0].name, 'far-a');
    assert.equal(on.imports, 1);
    const onHtml = fitSectionHtml(P, { ...st, showOthers: true }, 'live', nameOf);
    assert.match(onHtml, /aria-expanded="true">Diğer projelerimden gelenleri gizle</);
    // A selected row past the fifth place stays on screen (nothing selected is ever hidden)
    const picked = fitView(fit, { ...st, sel: new Set(['skill:kit-6']) }, 'live');
    assert.ok(picked.main.some((c) => c.name === 'kit-6'));
    // Only other projects fit: say so instead of "nothing found", and keep the switch
    const onlyFar = { ...fit, candidates: [row('far-a', ['project:demo'])] };
    const far = fitSectionHtml(P, { ...st, data: onlyFar, sel: null }, 'live', nameOf);
    assert.ok(far.includes(esc(S.fitOnlyOthers)));
    assert.match(far, /data-fit-act="others"/);
    // What fits from the kit or the library is installed already: that is the news, not "nothing fits yet"
    const inHere = { ...onlyFar, candidates: [...onlyFar.candidates, row('kit-in', ['kit'], { installed: true, installable: false })] };
    const done = fitSectionHtml(P, { ...st, data: inHere, sel: null }, 'live', nameOf);
    assert.ok(done.includes(esc(S.fitNothingNew)) && !done.includes(esc(S.fitOnlyOthers)));
    assert.match(done, /data-fit-act="others"/);
  });
});

test('off in the desktop app: "Turn actions on and install" with one question that says what On does and what is installed; without the switch it stays disabled', () => {
  const fit = fixtureFit();
  inLanguages((lang, S) => {
    const plain = fitSectionHtml(P, state(fit), 'off', nameOf);
    assert.match(plain, /data-fit-act="apply"[^>]*aria-disabled="true"/, `${lang}: a plain browser cannot turn actions on`);
    const html = fitSectionHtml(P, state(fit), 'off', nameOf, null, { turnOn: true });
    assert.match(html, new RegExp(`data-fit-act="apply" data-fk="fit:apply">${S.fitTurnOnInstall}<`), lang);
    assert.doesNotMatch(html, /data-fit-act="apply"[^>]*aria-disabled/, lang);
    assert.ok(html.includes(esc(S.fitWhyTurnOn)), lang);
    assert.doesNotMatch(html, /data-flow-target=/, `${lang}: still no target picker while off`);
    const ask = fitSectionHtml(P, state(fit, { confirm: 'turn-on' }), 'off', nameOf, null, { turnOn: true });
    assert.ok(ask.includes(esc(S.actionsSwitchConfirmTitle)) && ask.includes(esc(S.actionsSwitchConfirmBody)), `${lang}: what On does, in the switch's words`);
    assert.match(ask, /data-fit-act="confirm-on" data-fk="fit:confirm-on">/);
    assert.match(ask, /data-fit-act="cancel"/);
    // Once actions are on, the question no longer holds
    assert.doesNotMatch(fitSectionHtml(P, state(fit, { confirm: 'turn-on' }), 'live', nameOf, null, { turnOn: true }), /confirm-on/);
  });
  const st = state(fit);
  ensureFitSelection(st);
  assert.equal(fitView(fit, st, 'off').applyDisabled, true);
  const v = fitView(fit, st, 'off', { turnOn: true });
  assert.equal(v.oneStep, true);
  assert.equal(v.applyDisabled, false);
  assert.equal(fitView(fit, st, 'dry', { turnOn: true }).oneStep, false, 'Preview keeps its own button');
  st.sel.clear();
  assert.equal(fitView(fit, st, 'off', { turnOn: true }).applyDisabled, true, 'nothing ticked: nothing to turn on for');
});

test('the drawer turns actions on only through the header switch (one bridge call in the page)', () => {
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes('reply = await turnActionsOn();'));
  assert.doesNotMatch(drawer, /setActionsMode/);
  const main = fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes("turnActionsOn: !QA && shellBridge(window) ? () => actSwitch.turnOn() : null,"));
});
