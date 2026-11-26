// B1 Deutsch · Learn
// A concept-first path: learn a rule, practise it, pass a check to open the next lesson.
// Progress is stored in localStorage and, when signed in, in users/{uid}.learn (same account as the flashcards).

// ── Firebase (same project and sign-in as the flashcard app) ──────────────────
const firebaseConfig = {
  apiKey: "AIzaSyA4qlWdeY2HLDZ7SN8tTQPf_-vWyZoppls",
  authDomain: "b1-vocab-1d578.firebaseapp.com",
  projectId: "b1-vocab-1d578",
  storageBucket: "b1-vocab-1d578.firebasestorage.app",
  messagingSenderId: "257430022122",
  appId: "1:257430022122:web:1d7049dcdaef33ae31f493",
  measurementId: "G-PCLMEHD8G7"
};
firebase.initializeApp(firebaseConfig);
const db   = firebase.firestore();
const auth = firebase.auth();
let currentUser = null;

const STORE_KEY   = 'b1_learn';
const VOCAB_KEY   = 'b1_vocab_stats';
const PASS_MARK   = 8;
const HARD_SIZE   = 15;
const DAY         = 24 * 60 * 60 * 1000;

// ── Progress ──────────────────────────────────────────────────────────────────
// lessons: { "7": { passed, best, ts } }
// hard:    { "7-c3": { added, misses, hint, saved, streak, due, last, lastMiss, mastered, removed, ts } }
// review:  older format of the mistakes list, kept only so it can be migrated into hard
let progress = loadLocal();
let vocabStats = null;   // flashcard stats from the cloud, for the "words due" count

function loadLocal() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    return { lessons: p.lessons || {}, review: p.review || {}, hard: p.hard || {} };
  } catch (e) {
    return { lessons: {}, review: {}, hard: {} };
  }
}

function mergeProgress(a, b) {
  const out = { lessons: { ...a.lessons }, review: { ...a.review }, hard: { ...(a.hard || {}) } };
  for (const [id, l] of Object.entries(b.lessons || {})) {
    const m = out.lessons[id] || {};
    out.lessons[id] = {
      passed: !!(m.passed || l.passed),
      best: Math.max(m.best || 0, l.best || 0),
      ts: Math.max(m.ts || 0, l.ts || 0),
    };
  }
  for (const [k, r] of Object.entries(b.review || {})) {
    const m = out.review[k] || {};
    out.review[k] = { miss: Math.max(m.miss || 0, r.miss || 0), ok: Math.max(m.ok || 0, r.ok || 0) };
  }
  // Hard sentences: the most recently updated version of each entry wins.
  for (const [k, e] of Object.entries(b.hard || {})) {
    const m = out.hard[k];
    if (!m || (e.ts || 0) > (m.ts || 0)) out.hard[k] = e;
  }
  return out;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch (e) {}
  if (currentUser) {
    db.collection('users').doc(currentUser.uid)
      .set({ learn: progress }, { merge: true })
      .catch(err => console.warn('Saving lesson progress failed:', err));
  }
}

async function pullCloud() {
  if (!currentUser) return;
  try {
    const snap = await db.collection('users').doc(currentUser.uid).get();
    const data = snap.exists ? snap.data() : {};
    if (data.learn) progress = mergeProgress(progress, data.learn);
    migrateReview();
    vocabStats = data.stats || null;
    save();
    render();
  } catch (err) {
    console.warn('Loading lesson progress failed:', err);
  }
}

auth.onAuthStateChanged(user => {
  currentUser = user;
  const who = document.getElementById('who');
  who.innerHTML = user
    ? escapeHtml(user.email || 'Signed in')
    : '<a href="/">Sign in to sync ›</a>';
  if (user) pullCloud();
});

let lastPull = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !currentUser || session) return;
  if (Date.now() - lastPull < 30 * 1000) return;
  lastPull = Date.now();
  pullCloud();
});

// ── Lesson helpers ────────────────────────────────────────────────────────────
const lessonById = id => LESSONS.find(l => l.id === id);
const isPassed   = id => !!(progress.lessons[id] && progress.lessons[id].passed);
const isOpen     = id => id === 1 || isPassed(id - 1);
const passedCount = () => LESSONS.filter(l => isPassed(l.id)).length;
const currentLesson = () => (LESSONS.find(l => !isPassed(l.id)) || LESSONS[LESSONS.length - 1]);

function itemByKey(key) {
  const [id, part] = key.split('-');
  const l = lessonById(Number(id));
  if (!l) return null;
  const list = part[0] === 'p' ? l.practice : l.check;
  return list[Number(part.slice(1))] || null;
}

// ── Hard sentences ────────────────────────────────────────────────────────────
// A sentence joins the list when you miss it, need its hint, or save it with ★.
// Wrong → back tomorrow (and again later in the same session). Right on a new day →
// 3 days, then 7 days; the third right answer on different days moves it to Mastered.
const dayKey = t => new Date(t || 0).toDateString();
const liveHard = key => { const e = progress.hard[key]; return e && !e.removed && itemByKey(key) ? e : null; };

function freshHard(now) {
  return { added: now, misses: 0, hint: false, saved: false, streak: 0, due: now, last: 0, lastMiss: 0, mastered: false, removed: false };
}

function patchHard(key, patch) {
  const now = Date.now();
  const cur = liveHard(key);
  const e = Object.assign(cur ? { ...cur } : freshHard(now), patch, { ts: now });
  progress.hard[key] = e;
  return e;
}

function recordHard(it, correct, usedHint) {
  const now = Date.now();
  const e = liveHard(it.key);
  if (!correct) {
    patchHard(it.key, { misses: (e ? e.misses : 0) + 1, streak: 0, mastered: false, due: now + DAY, lastMiss: now });
    return;
  }
  if (usedHint) {
    if (!e) patchHard(it.key, { hint: true, due: now + DAY });
    return;
  }
  if (!e || e.mastered) return;
  const today = dayKey(now);
  if (today === dayKey(e.last) || today === dayKey(e.lastMiss) || today === dayKey(e.added)) {
    // Right, but on a day that doesn't count: just make sure it isn't due again today.
    if (e.due <= now) patchHard(it.key, { due: new Date(now).setHours(24, 0, 0, 0) });
    return;
  }
  const streak = e.streak + 1;
  patchHard(it.key, { streak, last: now, mastered: streak >= 3, due: now + (streak === 1 ? 3 : 7) * DAY });
}

function toggleSave(key) {
  const e = liveHard(key);
  if (e && e.saved) {
    if (!e.misses && !e.hint) patchHard(key, { removed: true });
    else patchHard(key, { saved: false });
  } else {
    patchHard(key, { saved: true });
  }
  save();
}

function removeHard(key) {
  if (liveHard(key)) { patchHard(key, { removed: true }); save(); }
}

function hardKeys(tab) {
  const now = Date.now();
  return Object.keys(progress.hard).filter(k => {
    const e = liveHard(k);
    if (!e) return false;
    if (tab === 'due') return !e.mastered && e.due <= now;
    if (tab === 'mastered') return e.mastered;
    if (tab === 'open') return !e.mastered;
    return true;
  });
}

// Mistakes collected before this list existed become hard sentences, due now.
function migrateReview() {
  let changed = false;
  for (const [k, r] of Object.entries(progress.review || {})) {
    if ((r.miss || 0) > (r.ok || 0) && !progress.hard[k] && itemByKey(k)) {
      progress.hard[k] = { ...freshHard(r.miss), misses: 1, ts: r.miss };
      changed = true;
    }
  }
  return changed;
}
if (migrateReview()) { try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch (e) {} }

const sentenceOf = it => it.t === 'gap' ? it.de.replace('___', it.o[0]) : it.de;
// English meaning without task instructions such as "(start with Morgen)".
const meaningOf = it => (it.en || '').replace(/\s*\((start with|use)[^)]*\)/i, '').trim();

function hardCardHtml() {
  const total = hardKeys('all').length;
  if (!total) return '';
  const due = hardKeys('due').length;
  return `<button class="review-card" onclick="go('#hard')">
      <span style="font-size:22px">\u{1F501}</span>
      <div><b>My hard sentences</b><span>${due ? due + ' due today' : 'Nothing due today'} \u00B7 ${total} saved in total</span></div></button>`;
}

function vocabDue() {
  let stats = vocabStats;
  if (!stats) { try { stats = JSON.parse(localStorage.getItem(VOCAB_KEY)) || {}; } catch (e) { stats = {}; } }
  const now = Date.now();
  let n = 0;
  for (const [k, s] of Object.entries(stats)) {
    if (k.startsWith('star_') || !s || !s.attempts) continue;
    if ((s.due || 0) <= now) n++;
  }
  return n;
}

// ── Small utilities ───────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Loose comparison for typed answers: case, punctuation, umlaut spelling and extra spaces don't matter.
function loose(s) {
  return String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[.,!?;:"„“'’()\-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

let germanVoice = null;
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const clean = String(text).replace(/<[^>]+>/g, '').replace(/.*→\s*/, '');
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'de-DE';
  u.rate = 0.9;
  if (!germanVoice) germanVoice = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('de')) || null;
  if (germanVoice) u.voice = germanVoice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

const view = () => document.getElementById('view');
const go = hash => { location.hash = hash; };

// ── Routing ───────────────────────────────────────────────────────────────────
// ''              home
// #path           all 21 lessons
// #lesson/7       learn the concept
// #practice/7     8 practice items (hints allowed)
// #check/7        10 check items, 8 needed
// #hard[/all|/mastered]          your hard sentences
// #hardpractice[/all|/mastered]  practise them
let session = null;

function render() {
  const [route, arg] = location.hash.replace(/^#/, '').split('/');
  const id = Number(arg);
  if ((route === 'lesson' || route === 'practice' || route === 'check') && (!lessonById(id) || !isOpen(id))) {
    go('#path');
    return;
  }
  if (route === 'review') { go('#hard'); return; }
  if (route !== 'practice' && route !== 'check' && route !== 'hardpractice') session = null;
  window.scrollTo(0, 0);
  if (route === 'path') return renderPath();
  if (route === 'lesson') return renderLesson(lessonById(id));
  if (route === 'practice' || route === 'check') {
    if (!session || session.mode !== route || session.lesson.id !== id) startSession(route, lessonById(id));
    return renderItem();
  }
  if (route === 'hard') return renderHard(arg || 'due');
  if (route === 'hardpractice') {
    if (!session || session.mode !== 'hard') {
      if (!startHard(arg || 'due')) { go('#hard'); return; }
    }
    return renderItem();
  }
  renderHome();
}
window.addEventListener('hashchange', render);

// ── Home ──────────────────────────────────────────────────────────────────────
function renderHome() {
  const done = passedCount();
  const cur = currentLesson();
  const allDone = done === LESSONS.length;
  const started = done > 0 || hardKeys('all').length > 0;
  const due = vocabDue();
  view().innerHTML = `
    ${hardCardHtml() ? `<div style="margin-bottom:14px">${hardCardHtml()}</div>` : ''}
    <div class="tile">
      <div class="ic" style="background:#E7F3FF">\u{1F9ED}</div>
      <h2>Learn</h2>
      <p>Grammar step by step, from the basics to B1. Learn a rule, then use it.</p>
      <div class="bar"><i style="width:${Math.round(done / LESSONS.length * 100)}%"></i></div>
      <div class="muted" style="margin:6px 0 2px">${done} of ${LESSONS.length} lessons done</div>
      <a class="btn" href="${allDone ? '#path' : '#lesson/' + cur.id}">${allDone ? 'See all lessons' : (started ? 'Continue' : 'Start') + ' lesson ' + cur.id}</a>
      <a class="btn ghost" href="#path">See all 21 lessons</a>
    </div>
    <div class="tile">
      <div class="ic" style="background:#E3F5E8">\u{1F0CF}</div>
      <h2>Words</h2>
      <p>Your flashcards and milestones.</p>
      <a class="btn ghost" href="/">${due ? 'Review ' + due + ' word' + (due === 1 ? '' : 's') : 'Open flashcards'}</a>
    </div>`;
}

// ── Path ──────────────────────────────────────────────────────────────────────
function renderPath() {
  const cur = currentLesson();
  let html = `
    <div class="topbar"><a class="back" href="#">‹ Home</a><span class="pill">${passedCount()} / ${LESSONS.length}</span></div>
    <div class="bar"><i style="width:${Math.round(passedCount() / LESSONS.length * 100)}%"></i></div>`;
  if (hardCardHtml()) html += `<div style="margin-top:12px">${hardCardHtml()}</div>`;
  for (const lv of LEVELS) {
    const ls = LESSONS.filter(l => l.level === lv.n);
    const d = ls.filter(l => isPassed(l.id)).length;
    html += `<div class="stage"><span>Level ${lv.n} · ${lv.title}</span><span>${d === ls.length ? d + ' / ' + ls.length + ' ✓' : lv.cefr}</span></div>`;
    for (const l of ls) {
      const passed = isPassed(l.id);
      const open = isOpen(l.id);
      const cls = passed ? 'done' : (l.id === cur.id ? 'cur' : '');
      const best = passed ? `<span class="score">${progress.lessons[l.id].best}/10</span>` : '';
      html += `<button class="les ${cls}" ${open ? `onclick="go('#lesson/${l.id}')"` : 'disabled'}>
        <span class="num">${passed ? '✓' : (open ? l.id : '\u{1F512}')}</span>
        <div><b>${l.id}. ${l.title}</b><span class="ex">${l.ex}</span></div>${best}</button>`;
    }
  }
  html += `<p class="muted center" style="margin:14px 0 4px">Pass a lesson's check (8 of 10) to open the next one.</p>`;
  view().innerHTML = html;
}

// ── Learn screen ──────────────────────────────────────────────────────────────
function steps(active, lesson) {
  const names = ['Learn', 'Practise', 'Check'];
  const passed = isPassed(lesson.id);
  return '<div class="steps">' + names.map((n, i) => {
    const cls = i === active ? 'on' : (i < active || passed ? 'dn' : '');
    return `<span class="${cls}">${i + 1} ${n}${cls === 'dn' ? ' ✓' : ''}</span>`;
  }).join('') + '</div>';
}

function renderLesson(l) {
  const diagram = l.diagram.map(row =>
    '<div class="sent">' + row.map(([w, lab, kind]) =>
      `<span class="chip ${kind || ''}">${w}${lab ? `<small>${lab}</small>` : ''}</span>`).join('') + '</div>'
  ).join('');
  const examples = l.examples.map(([de, en]) => `
    <div class="exl"><button class="spk" data-say="${escapeHtml(de)}" aria-label="Listen">\u{1F50A}</button>
      <div><div class="de">${de}</div><div class="en">${en}</div></div></div>`).join('');
  view().innerHTML = `
    <div class="topbar"><a class="back" href="#path">‹ All lessons</a><span class="pill">Lesson ${l.id}</span></div>
    ${steps(0, l)}
    <div class="h">${l.title}</div>
    <div class="card"><div class="rule">${l.rule}</div>${diagram}</div>
    <div class="card"><div class="label">Examples</div>${examples}</div>
    ${l.extra ? `<div class="card extra">${l.extra}</div>` : ''}
    <div class="mist"><b>Common mistake</b><br><s>${l.mistake[0]}</s><br><span class="ok">${l.mistake[1]}</span></div>
    <div class="why"><b>Why it matters for the exam:</b> ${l.why}</div>
    <a class="btn" href="#practice/${l.id}">Practise · ${l.practice.length} tasks</a>
    ${isPassed(l.id) ? `<a class="btn ghost" href="#check/${l.id}">Take the check again</a>` : ''}`;
  view().querySelectorAll('.spk').forEach(btn => btn.addEventListener('click', () => speak(btn.dataset.say)));
}

// ── Sessions ──────────────────────────────────────────────────────────────────
function startSession(mode, lesson) {
  const src = mode === 'practice' ? lesson.practice : lesson.check;
  const tag = mode === 'practice' ? 'p' : 'c';
  const items = src.map((it, i) => ({ ...it, key: `${lesson.id}-${tag}${i}` }));
  session = {
    mode, lesson, idx: 0, results: [],
    items: mode === 'check' ? shuffle(items) : items,
  };
  prepareItem();
}

function startHard(tab) {
  let keys = hardKeys(tab);
  if (tab === 'due') keys.sort((a, b) => progress.hard[a].due - progress.hard[b].due);
  else keys = shuffle(keys).sort((a, b) => (progress.hard[a].mastered - progress.hard[b].mastered) || (progress.hard[b].misses - progress.hard[a].misses));
  keys = keys.slice(0, HARD_SIZE);
  if (!keys.length) return false;
  session = {
    mode: 'hard', tab, lesson: null, idx: 0, results: [],
    items: shuffle(keys.map(k => ({ ...itemByKey(k), key: k }))),
  };
  prepareItem();
  return true;
}

// Per-item state: shuffled options or tiles, the user's answer, and whether it's been checked.
function prepareItem() {
  const it = session.items[session.idx];
  if (!it) return;
  session.state = { answered: false, correct: null, hint: false };
  if (it.t === 'gap') session.state.opts = shuffle(it.o.map((o, i) => ({ o, ok: i === 0 })));
  if (it.t === 'build') {
    const words = it.de.split(/\s+/);
    let order = shuffle(words.map((w, i) => ({ w, i })));
    for (let tries = 0; tries < 5 && order.every((t, i) => t.i === i) && words.length > 1; tries++) order = shuffle(order);
    session.state.pool = order;
    session.state.slot = [];
  }
}

function dotsHtml() {
  return '<div class="dots">' + session.items.map((_, i) => {
    const r = session.results[i];
    return `<i class="${r === true ? 'g' : r === false ? 'r' : i === session.idx ? 'n' : ''}"></i>`;
  }).join('') + '</div>';
}

function headerHtml() {
  const total = session.items.length;
  const pos = Math.min(session.idx + 1, total);
  if (session.mode === 'hard') {
    return `<div class="topbar"><a class="back" href="#hard">‹ Hard sentences</a><span class="pill">${pos} / ${total}</span></div>`;
  }
  const l = session.lesson;
  return `<div class="topbar"><a class="back" href="#lesson/${l.id}">‹ Lesson ${l.id}</a><span class="pill">${pos} / ${total}</span></div>
    ${steps(session.mode === 'practice' ? 1 : 2, l)}`;
}

const BADGE = { gap: 'FILL THE GAP', build: 'BUILD THE SENTENCE', say: 'SAY IT IN GERMAN' };

function renderItem() {
  if (session.idx >= session.items.length) return renderResults();
  const it = session.items[session.idx];
  const st = session.state;
  const hintsAllowed = session.mode !== 'check';
  let body = '';

  if (it.t === 'gap') {
    const filled = st.answered ? `<span class="blank">${escapeHtml(it.o[0])}</span>` : '<span class="blank">&nbsp;</span>';
    body += `<div class="prompt">${escapeHtml(it.de).replace('___', filled)}</div>`;
    if (it.en) body += `<div class="sub">${escapeHtml(it.en)}</div>`;
    body += '<div class="opts">' + st.opts.map((o, i) => {
      let cls = '';
      if (st.answered) cls = o.ok ? 'right' : (st.picked === i ? 'wrong' : '');
      return `<button class="opt ${cls}" data-i="${i}" ${st.answered ? 'disabled' : ''}>${escapeHtml(o.o)}</button>`;
    }).join('') + '</div>';
  }

  if (it.t === 'build') {
    body += `<div class="prompt">${escapeHtml(it.en)}</div><div class="sub">Tap the words in the right order.</div>`;
    body += '<div class="slot" id="slot">' + st.slot.map((t, i) =>
      `<button class="tilew" data-slot="${i}" ${st.answered ? 'disabled' : ''}>${escapeHtml(t.w)}</button>`).join('') + '</div>';
    body += '<div class="pool">' + st.pool.map((t, i) => {
      const used = st.slot.includes(t);
      return `<button class="tilew ${used ? 'used' : ''}" data-pool="${i}" ${st.answered ? 'disabled' : ''}>${escapeHtml(t.w)}</button>`;
    }).join('') + '</div>';
  }

  if (it.t === 'say') {
    body += `<div class="prompt">${escapeHtml(it.en)}</div><div class="sub">Type it in German.</div>
      <input class="say-input" id="say-input" type="text" autocomplete="off" autocapitalize="sentences" spellcheck="false"
        placeholder="Auf Deutsch …" value="${escapeHtml(st.typed || '')}" ${st.answered ? 'disabled' : ''}>`;
  }

  if (!st.answered && hintsAllowed && it.h) {
    body += st.hint
      ? `<div class="hint">\u{1F4A1} ${escapeHtml(it.h)}</div>`
      : `<button class="hint-btn" id="hint-btn">\u{1F4A1} Show a hint</button>`;
  }

  if (st.answered) body += feedbackHtml(it, st);
  else if (it.t === 'build') body += `<button class="btn" id="check-btn" ${st.slot.length === st.pool.length ? '' : 'disabled'}>Check</button>`;
  else if (it.t === 'say') body += `<button class="btn" id="check-btn">Check</button>`;

  const saved = !!(liveHard(it.key) && liveHard(it.key).saved);
  const star = `<button class="save-btn ${saved ? 'on' : ''}" id="save-btn" title="Save to My hard sentences">★ ${saved ? 'Saved' : 'Save'}</button>`;
  view().innerHTML = `${headerHtml()}${dotsHtml()}<div class="card">${star}<span class="badge ${it.t}">${BADGE[it.t]}</span>${body}</div>`;
  wireItem(it);
}

function feedbackHtml(it, st) {
  const model = it.t === 'gap' ? it.de.replace('___', it.o[0]) : it.de;
  const showModel = it.t !== 'gap' || !st.correct;
  let html = `<div class="fb ${st.correct ? 'ok' : 'no'}">
    <b class="t">${st.correct ? 'Richtig! ✔' : (st.selfRate ? 'Compare with the answer:' : 'Not quite.')}</b>
    ${st.selfRate ? `<div>You wrote: ${escapeHtml(st.typed || '')}</div>` : ''}
    ${showModel ? `<div class="model">${escapeHtml(model)}</div>` : ''}
    ${it.h ? `<div>${escapeHtml(it.h)}</div>` : ''}</div>`;
  if (st.selfRate) {
    html += `<div class="btn-row"><button class="btn green" id="self-right">I had it right</button><button class="btn red" id="self-wrong">I was wrong</button></div>`;
  } else {
    html += `<div class="btn-row">${it.t !== 'gap' || it.en ? `<button class="btn ghost" id="listen-btn" style="flex:0 0 56px">\u{1F50A}</button>` : ''}
      <button class="btn" id="next-btn">${session.idx + 1 < session.items.length ? 'Next' : 'See result'}</button></div>`;
  }
  return html;
}

function wireItem(it) {
  const st = session.state;
  const $ = id => document.getElementById(id);
  if ($('hint-btn')) $('hint-btn').onclick = () => { st.hint = true; renderItem(); };
  if ($('save-btn')) $('save-btn').onclick = () => { toggleSave(it.key); renderItem(); };
  if ($('next-btn')) { $('next-btn').onclick = nextItem; $('next-btn').focus(); }
  if ($('listen-btn')) $('listen-btn').onclick = () => speak(it.t === 'gap' ? it.de.replace('___', it.o[0]) : it.de);
  if ($('self-right')) $('self-right').onclick = () => { st.selfRate = false; finishItem(true); };
  if ($('self-wrong')) $('self-wrong').onclick = () => { st.selfRate = false; finishItem(false); };

  if (it.t === 'gap' && !st.answered) {
    view().querySelectorAll('.opt').forEach(btn => btn.onclick = () => {
      st.picked = Number(btn.dataset.i);
      finishItem(st.opts[st.picked].ok);
    });
  }

  if (it.t === 'build' && !st.answered) {
    view().querySelectorAll('[data-pool]').forEach(btn => btn.onclick = () => {
      const t = st.pool[Number(btn.dataset.pool)];
      if (!st.slot.includes(t)) { st.slot.push(t); renderItem(); }
    });
    view().querySelectorAll('[data-slot]').forEach(btn => btn.onclick = () => {
      st.slot.splice(Number(btn.dataset.slot), 1);
      renderItem();
    });
    if ($('check-btn')) $('check-btn').onclick = () => {
      const built = st.slot.map(t => t.w).join(' ');
      const tilesKey = s => s.split(/\s+/).map(loose).sort().join('|');
      const accepted = [it.de, ...it.alts.filter(a => tilesKey(a) === tilesKey(it.de))];
      finishItem(accepted.some(a => loose(a) === loose(built)));
    };
  }

  if (it.t === 'say' && !st.answered) {
    const input = $('say-input');
    input.focus();
    input.oninput = () => { st.typed = input.value; };
    const check = () => {
      st.typed = input.value;
      const typed = loose(input.value);
      const ok = !!typed && [it.de, ...it.alts].some(a => loose(a) === typed);
      if (ok || !typed) { finishItem(ok); return; }
      // Typed something different: show the model answer and let the learner judge.
      st.answered = true; st.correct = false; st.selfRate = true;
      renderItem();
    };
    $('check-btn').onclick = check;
    input.onkeydown = e => { if (e.key === 'Enter') check(); };
  }
}

function finishItem(correct) {
  const st = session.state;
  const it = session.items[session.idx];
  st.answered = true;
  st.correct = correct;
  session.results[session.idx] = correct;
  recordHard(it, correct, st.hint);
  // Practice and hard-sentence sessions bring a missed sentence back once at the end.
  if (!correct && session.mode !== 'check' && !it.again) session.items.push({ ...it, again: true });
  save();
  renderItem();
}

function nextItem() {
  session.idx += 1;
  prepareItem();
  renderItem();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('next-btn') && document.activeElement.id !== 'next-btn') {
    e.preventDefault();
    nextItem();
  }
});

// ── Results ───────────────────────────────────────────────────────────────────
function renderResults() {
  const score = session.results.filter(Boolean).length;
  const total = session.items.length;
  const seen = new Set();
  const missed = session.items.filter((it, i) => session.results[i] === false && !seen.has(it.key) && seen.add(it.key));
  const missedHtml = missed.length ? `<div class="card"><div class="label">You will see these again</div>
    ${missed.map(it => `<div class="li">${escapeHtml(sentenceOf(it))}${meaningOf(it) ? `<div class="en">${escapeHtml(meaningOf(it))}</div>` : ''}</div>`).join('')}</div>` : '';

  if (session.mode === 'hard') {
    const left = hardKeys('due').length;
    view().innerHTML = `
      <div class="topbar"><a class="back" href="#hard">‹ Hard sentences</a><span class="pill">Done</span></div>
      <div class="big pass">${score} / ${total}</div>
      <p class="center muted" style="font-size:15px">${left ? left + ' still due today' : 'Nothing else due today'}</p>
      ${missedHtml}
      ${left ? `<button class="btn" id="again-btn">Practise the ${left} due</button>` : ''}
      <a class="btn ghost" href="#hard">Back to my hard sentences</a>`;
    if (document.getElementById('again-btn')) document.getElementById('again-btn').onclick = () => { session = null; go('#hardpractice'); render(); };
    return;
  }

  const l = session.lesson;
  if (session.mode === 'practice') {
    view().innerHTML = `
      <div class="topbar"><a class="back" href="#lesson/${l.id}">‹ Lesson ${l.id}</a><span class="pill">Practice done</span></div>
      ${steps(1, l)}
      <div class="big pass">${score} / ${total}</div>
      <p class="center muted" style="font-size:15px">Practice done. Now the check: 10 tasks, no hints, ${PASS_MARK} needed.</p>
      ${missedHtml}
      <a class="btn" href="#check/${l.id}">Start the check</a>
      <a class="btn ghost" href="#lesson/${l.id}">Read the rule again</a>`;
    return;
  }

  // Check
  const passed = score >= PASS_MARK;
  const prev = progress.lessons[l.id] || {};
  if (!session.recorded) {
    progress.lessons[l.id] = { passed: !!(prev.passed || passed), best: Math.max(prev.best || 0, score), ts: Date.now() };
    session.recorded = true;
    save();
  }
  const next = lessonById(l.id + 1);
  const unlock = passed && next ? `<div class="unl"><span class="num" style="background:#1877F2;color:#fff;width:36px;height:36px">${next.id}</span>
    <div><b style="font-size:15px">Lesson ${next.id} is open</b><div class="muted">${next.title}</div></div></div>` : '';
  view().innerHTML = `
    <div class="topbar"><a class="back" href="#path">‹ All lessons</a><span class="pill">Lesson ${l.id}</span></div>
    ${steps(2, l)}
    <div class="big ${passed ? 'pass' : 'fail'}">${score} / ${total}</div>
    <p class="center muted" style="font-size:15px">${passed ? (next ? 'Passed' : 'Passed. You have finished all 21 lessons!') : `You need ${PASS_MARK}. Read the rule again and try once more.`}</p>
    ${unlock}
    ${missedHtml}
    ${passed && next ? `<a class="btn" href="#lesson/${next.id}">Start lesson ${next.id}</a>` : ''}
    ${!passed ? `<a class="btn" href="#lesson/${l.id}">Read the rule again</a><button class="btn ghost" id="retry-btn">Try the check again</button>` : ''}
    <a class="btn ghost" href="#path">Back to the lessons</a>`;
  if (document.getElementById('retry-btn')) document.getElementById('retry-btn').onclick = () => { session = null; render(); };
}

// ── My hard sentences ─────────────────────────────────────────────────────────
function renderHard(tab) {
  if (!['due', 'all', 'mastered'].includes(tab)) tab = 'due';
  const counts = { due: hardKeys('due').length, all: hardKeys('all').length, mastered: hardKeys('mastered').length };
  let keys = hardKeys(tab);
  if (tab === 'due') keys.sort((a, b) => progress.hard[a].due - progress.hard[b].due);
  else keys.sort((a, b) => (progress.hard[b].misses - progress.hard[a].misses) || (progress.hard[b].ts - progress.hard[a].ts));
  const tabs = [['due', 'Due today'], ['all', 'All'], ['mastered', 'Mastered']].map(([t, n]) =>
    `<a class="${t === tab ? 'on' : ''}" href="#hard/${t}">${n} \u00B7 ${counts[t]}</a>`).join('');
  const n = keys.length;
  const practise = {
    due: n ? `Practise the ${Math.min(n, HARD_SIZE)} due now` : '',
    all: counts.all - counts.mastered ? `Practise ${Math.min(counts.all, HARD_SIZE)} from the list` : (counts.all ? `Practise ${Math.min(counts.all, HARD_SIZE)} again` : ''),
    mastered: n ? `Practise ${Math.min(n, HARD_SIZE)} mastered sentences` : '',
  }[tab];
  const empty = {
    due: counts.all ? 'Nothing is due today. Sentences come back when it is time to repeat them.' : 'No sentences yet. A sentence lands here when you miss it, need its hint, or tap \u2605 Save.',
    all: 'No sentences yet. A sentence lands here when you miss it, need its hint, or tap \u2605 Save.',
    mastered: 'No mastered sentences yet. Answer a sentence correctly on three different days to master it.',
  }[tab];
  const rows = keys.map(k => {
    const e = progress.hard[k];
    const it = itemByKey(k);
    const lesson = k.split('-')[0];
    const why = e.misses ? `missed ${e.misses}\u00D7` : (e.hint ? 'hint used' : 'saved \u2605');
    const bars = e.mastered
      ? '<span class="mastered">Mastered \u2713</span>'
      : '<span class="lv">' + [0, 1, 2].map(i => `<i class="${i < e.streak ? 'g' : ''}"></i>`).join('') + '</span>';
    return `<div class="hs">
      <button class="hs-x" data-remove="${k}" title="Remove from the list" aria-label="Remove">\u2715</button>
      <div class="de">${escapeHtml(sentenceOf(it))}</div>${meaningOf(it) ? `<div class="en">${escapeHtml(meaningOf(it))}</div>` : ''}
      <div class="meta"><span class="tag">L${lesson} \u00B7 ${why}${e.saved && e.misses ? ' \u00B7 \u2605' : ''}</span>${bars}</div></div>`;
  }).join('');
  view().innerHTML = `
    <div class="topbar"><a class="back" href="#">\u2039 Home</a><span class="pill">${counts.all} sentence${counts.all === 1 ? '' : 's'}</span></div>
    <div class="h" style="margin-bottom:4px">My hard sentences</div>
    <div class="tabs">${tabs}</div>
    ${practise ? `<a class="btn" style="margin:4px 0 12px" href="#hardpractice/${tab}">${practise}</a>` : ''}
    ${rows || `<p class="muted center" style="margin:24px 8px">${empty}</p>`}
    ${rows && tab !== 'mastered' ? '<p class="muted" style="margin-top:8px">Bars: three correct answers on different days and the sentence moves to Mastered.</p>' : ''}`;
  view().querySelectorAll('[data-remove]').forEach(btn => btn.onclick = () => { removeHard(btn.dataset.remove); renderHard(tab); });
}

render();
