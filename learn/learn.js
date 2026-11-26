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
const REVIEW_SIZE = 10;

// ── Progress ──────────────────────────────────────────────────────────────────
// lessons: { "7": { passed, best, ts } }   review: { "7-c3": { miss, ok } }
let progress = loadLocal();
let vocabStats = null;   // flashcard stats from the cloud, for the "words due" count

function loadLocal() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    return { lessons: p.lessons || {}, review: p.review || {} };
  } catch (e) {
    return { lessons: {}, review: {} };
  }
}

function mergeProgress(a, b) {
  const out = { lessons: { ...a.lessons }, review: { ...a.review } };
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

function reviewKeys() {
  return Object.entries(progress.review)
    .filter(([k, r]) => (r.miss || 0) > (r.ok || 0) && itemByKey(k))
    .sort((a, b) => a[1].miss - b[1].miss)
    .map(([k]) => k);
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
// #review         items you got wrong
let session = null;

function render() {
  const [route, arg] = location.hash.replace(/^#/, '').split('/');
  const id = Number(arg);
  if ((route === 'lesson' || route === 'practice' || route === 'check') && (!lessonById(id) || !isOpen(id))) {
    go('#path');
    return;
  }
  if (route !== 'practice' && route !== 'check' && route !== 'review') session = null;
  window.scrollTo(0, 0);
  if (route === 'path') return renderPath();
  if (route === 'lesson') return renderLesson(lessonById(id));
  if (route === 'practice' || route === 'check') {
    if (!session || session.mode !== route || session.lesson.id !== id) startSession(route, lessonById(id));
    return renderItem();
  }
  if (route === 'review') {
    if (!session || session.mode !== 'review') {
      if (!startReview()) { go('#path'); return; }
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
  const started = done > 0 || Object.keys(progress.review).length > 0;
  const due = vocabDue();
  view().innerHTML = `
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
  const rev = reviewKeys().length;
  let html = `
    <div class="topbar"><a class="back" href="#">‹ Home</a><span class="pill">${passedCount()} / ${LESSONS.length}</span></div>
    <div class="bar"><i style="width:${Math.round(passedCount() / LESSONS.length * 100)}%"></i></div>`;
  if (rev) {
    html += `<button class="review-card" style="margin-top:12px" onclick="go('#review')">
      <span style="font-size:22px">\u{1F501}</span>
      <div><b>Review your mistakes</b><span>${rev} sentence${rev === 1 ? '' : 's'} to practise again</span></div></button>`;
  }
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

function startReview() {
  const keys = reviewKeys().slice(0, REVIEW_SIZE);
  if (!keys.length) return false;
  session = {
    mode: 'review', lesson: null, idx: 0, results: [],
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
  if (session.mode === 'review') {
    return `<div class="topbar"><a class="back" href="#path">‹ All lessons</a><span class="pill">Review · ${pos} / ${total}</span></div>`;
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

  view().innerHTML = `${headerHtml()}${dotsHtml()}<div class="card"><span class="badge ${it.t}">${BADGE[it.t]}</span>${body}</div>`;
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
  const r = progress.review[it.key] || {};
  if (correct) {
    if (r.miss) progress.review[it.key] = { ...r, ok: Date.now() };
  } else {
    progress.review[it.key] = { ...r, miss: Date.now() };
  }
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
  const missed = session.items.filter((_, i) => session.results[i] === false);
  const missedHtml = missed.length ? `<div class="card"><div class="label">You will see these again</div>
    ${missed.map(it => `<div class="li">${escapeHtml(it.t === 'gap' ? it.de.replace('___', it.o[0]) : it.de)}${it.en ? `<div class="en">${escapeHtml(it.en)}</div>` : ''}</div>`).join('')}</div>` : '';

  if (session.mode === 'review') {
    const left = reviewKeys().length;
    view().innerHTML = `
      <div class="topbar"><a class="back" href="#path">‹ All lessons</a><span class="pill">Review</span></div>
      <div class="big pass">${score} / ${total}</div>
      <p class="center muted" style="font-size:15px">${left ? left + ' still to review' : 'All mistakes cleared'}</p>
      ${missedHtml}
      ${left ? `<button class="btn" id="again-btn">Review again</button>` : ''}
      <a class="btn ghost" href="#path">Back to the lessons</a>`;
    if (document.getElementById('again-btn')) document.getElementById('again-btn').onclick = () => { session = null; render(); };
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

render();
