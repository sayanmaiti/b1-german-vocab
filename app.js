// ── Firebase setup ────────────────────────────────────────────────────────────
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

// ── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY  = 'b1_vocab_stats';
const TOTAL_WORDS  = WORDS.length;

// ── Milestones ────────────────────────────────────────────────────────────────
// The word list is split into groups of 30 by frequency rank
// (milestone 1 = the 30 most common words). New words come only from the
// current milestone; the next unlocks once 80% of the current one is learned.
const MILESTONE_SIZE   = 30;
const MILESTONE_UNLOCK = 0.8;
const MILESTONES = (() => {
  const groups = [];
  for (let i = 0; i < WORDS.length; i += MILESTONE_SIZE) groups.push(WORDS.slice(i, i + MILESTONE_SIZE));
  // Fold a small remainder into the previous milestone instead of a tiny last one.
  if (groups.length > 1 && groups[groups.length - 1].length <= MILESTONE_SIZE / 2) {
    groups[groups.length - 2] = groups[groups.length - 2].concat(groups.pop());
  }
  return groups;
})();
const MILESTONE_OF = new Map();
MILESTONES.forEach((group, i) => group.forEach(w => MILESTONE_OF.set(w.id, i)));
const ARTICLES     = ['der ', 'die ', 'das ', 'den ', 'dem ', 'des '];
const DIRS         = ['de-en', 'en-de'];
const MINUTE       = 60 * 1000;
const DAY          = 24 * 60 * MINUTE;
const MAX_INTERVAL = 180;          // days
const RETRY_DELAY  = 2 * MINUTE;   // a missed card comes back after ~2 minutes
const EN_DE_DELAY  = 10 * MINUTE;  // EN→DE is introduced 10+ minutes after DE→EN was answered correctly

// ── State ────────────────────────────────────────────────────────────────────
let stats          = {};
let currentWord    = null;
let currentDir     = null;
let sessionCorrect = 0;
let sessionAttempts = 0;
let lastKey        = null;
let shownMilestone = null;   // to notice when a new milestone unlocks

// ── Persistence (localStorage) ────────────────────────────────────────────────
function loadStats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    stats = raw ? JSON.parse(raw) : {};
  } catch (_) {
    stats = {};
  }
}

function saveStats() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  if (currentUser) {
    db.collection('users').doc(currentUser.uid)
      .set({ stats }, { merge: true })
      .catch(e => console.warn('Firestore save failed:', e));
  }
}

// ── Firestore sync ────────────────────────────────────────────────────────────
async function loadFromFirestore(uid) {
  try {
    const doc = await db.collection('users').doc(uid).get();
    if (doc.exists) {
      const cloudStats = doc.data().stats || {};
      // Merge: take max of correct/attempts per key
      for (const [key, cloudStat] of Object.entries(cloudStats)) {
        const local  = stats[key] || { correct: 0, attempts: 0, lastSeen: 0 };
        const latest = (cloudStat.lastSeen || 0) > (local.lastSeen || 0) ? cloudStat : local;
        stats[key] = {
          ...latest,
          correct:  Math.max(local.correct  || 0, cloudStat.correct  || 0),
          attempts: Math.max(local.attempts || 0, cloudStat.attempts || 0),
          lastSeen: Math.max(local.lastSeen || 0, cloudStat.lastSeen || 0),
        };
      }
      saveStats();
    }
  } catch (e) {
    console.warn('Firestore load failed:', e);
  }
}

// Pull the latest cloud progress when the app comes back into view, so a phone and a
// laptop stay in step without a reload.
let lastCloudPull = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !currentUser) return;
  if (Date.now() - lastCloudPull < 30 * 1000) return;
  lastCloudPull = Date.now();
  loadFromFirestore(currentUser.uid).then(() => updateScoreBar());
});

// ── Auth UI: sign in with an emailed link ─────────────────────────────────────
// 1. Enter your email → Firebase emails a sign-in link.
// 2. Open the link (on any device) → you're signed in and your progress syncs.
const EMAIL_KEY = 'b1_vocab_email_for_signin';

function updateAuthUI(user) {
  const statusEl = document.getElementById('auth-status');
  const btnEl    = document.getElementById('auth-btn');
  if (user) {
    statusEl.textContent = user.email || user.displayName || 'Signed in';
    btnEl.textContent = 'Sign out';
    hide('login-panel');
  } else {
    statusEl.textContent = '';
    btnEl.textContent = 'Sign in';
  }
}

function setAuthMessage(text, isError = true) {
  const el = document.getElementById('auth-message');
  el.textContent = text || '';
  el.className = 'auth-message' + (isError ? '' : ' info') + (text ? '' : ' hidden');
}

// Plain-language text for the sign-in errors people actually hit.
function authErrorText(e) {
  const code = (e && e.code) || '';
  const host = location.hostname;
  if (code.startsWith('auth/requests-from-referer')) {
    return `Firebase is blocking requests from ${host}. Add https://${host}/* to the API key's website restrictions in Google Cloud.`;
  }
  const messages = {
    'auth/invalid-email':          'That email address doesn\u2019t look right.',
    'auth/missing-email':          'Please enter your email address.',
    'auth/operation-not-allowed':  'Email-link sign-in isn\u2019t switched on in Firebase yet (Authentication \u2192 Sign-in method \u2192 Email/Password \u2192 Email link).',
    'auth/unauthorized-continue-uri': `Add ${host} under Firebase \u2192 Authentication \u2192 Settings \u2192 Authorized domains.`,
    'auth/unauthorized-domain':    `Add ${host} under Firebase \u2192 Authentication \u2192 Settings \u2192 Authorized domains.`,
    'auth/invalid-action-code':    'This sign-in link has expired or was already used. Request a new one.',
    'auth/expired-action-code':    'This sign-in link has expired. Request a new one.',
    'auth/too-many-requests':      'Too many attempts. Please wait a few minutes and try again.',
    'auth/network-request-failed': 'No connection. Check your internet and try again.',
  };
  return messages[code] || `Sign-in failed (${code || 'unknown error'}). Please try again.`;
}

function showLoginPanel(prompt) {
  show('login-panel');
  document.getElementById('login-prompt').textContent = prompt;
  document.getElementById('login-email').focus();
}

document.getElementById('auth-btn').addEventListener('click', () => {
  if (currentUser) {
    auth.signOut();
    return;
  }
  const panel = document.getElementById('login-panel');
  if (panel.classList.contains('hidden')) {
    setAuthMessage('');
    showLoginPanel('We\u2019ll email you a link. Open it on this device or any other to sign in.');
  } else {
    hide('login-panel');
  }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  if (!email) { setAuthMessage('Please enter your email address.'); return; }
  setAuthMessage('');

  // Arrived from a sign-in link: finish signing in with the email just typed.
  if (auth.isSignInWithEmailLink(location.href)) {
    await completeLinkSignIn(email);
    return;
  }

  const btn = document.getElementById('login-submit');
  btn.disabled = true;
  try {
    await auth.sendSignInLinkToEmail(email, {
      url: location.origin + location.pathname,
      handleCodeInApp: true,
    });
    localStorage.setItem(EMAIL_KEY, email);
    setAuthMessage(`Link sent to ${email}. Open it to sign in (check spam if it doesn\u2019t arrive).`, false);
  } catch (err) {
    console.warn('Sending sign-in link failed:', err);
    setAuthMessage(authErrorText(err));
  } finally {
    btn.disabled = false;
  }
});

async function completeLinkSignIn(email) {
  try {
    await auth.signInWithEmailLink(email, location.href);
    localStorage.removeItem(EMAIL_KEY);
    history.replaceState(null, '', location.origin + location.pathname);  // remove the one-time code from the address
    setAuthMessage('');
  } catch (err) {
    console.warn('Email-link sign-in failed:', err);
    setAuthMessage(authErrorText(err));
  }
}

// Opened from the emailed link?
if (auth.isSignInWithEmailLink(location.href)) {
  const saved = localStorage.getItem(EMAIL_KEY);
  if (saved) {
    completeLinkSignIn(saved);
  } else {
    // Link opened on a different device or browser: confirm the email first.
    showLoginPanel('Confirm your email address to finish signing in.');
    document.getElementById('login-submit').textContent = 'Sign in';
  }
}

auth.onAuthStateChanged(user => {
  currentUser = user;
  updateAuthUI(user);
  if (user) {
    loadFromFirestore(user.uid).then(() => updateScoreBar());
  }
});

// ── Stat helpers ──────────────────────────────────────────────────────────────
function statKey(wordId, dir) {
  return `${wordId}_${dir}`;
}

function getStat(wordId, dir) {
  return stats[statKey(wordId, dir)] || { correct: 0, attempts: 0 };
}

function recordResult(wordId, dir, isCorrect) {
  const key = statKey(wordId, dir);
  if (!stats[key]) stats[key] = { correct: 0, attempts: 0 };
  const s = stats[key];
  s.attempts += 1;
  if (isCorrect) s.correct += 1;
  s.lastSeen = Date.now();
  schedule(s, isCorrect);
  saveStats();
}

// ── Spaced repetition ─────────────────────────────────────────────────────────
// Each word/direction has an interval (days) and a due time.
// Correct: the interval grows (x ease, about 2.5). Wrong: it resets and the card returns in ~2 minutes.
function schedule(s, isCorrect) {
  const now  = Date.now();
  const ease = s.ease || 2.5;
  if (isCorrect) {
    const prev = s.interval || 0;
    if (prev === 0) {
      s.interval = s.attempts <= 1 ? 3 : 1;   // known on first sight: 3 days; just relearned: 1 day
    } else {
      s.interval = Math.min(MAX_INTERVAL, Math.round(prev * ease * 10) / 10);
    }
    s.ease = Math.min(3.0, ease + 0.05);
    s.due  = now + s.interval * DAY;
  } else {
    s.interval = 0;
    s.ease     = Math.max(1.3, ease - 0.2);
    s.due      = now + RETRY_DELAY;
  }
}

function dueTime(s) {
  // Progress saved by the old version has no due time: treat it as due for review.
  return s.due !== undefined ? s.due : (s.lastSeen || 0);
}

function isSeen(wordId, dir) {
  const s = stats[statKey(wordId, dir)];
  return !!(s && s.attempts > 0);
}

function countDue(now = Date.now()) {
  let n = 0;
  for (const s of Object.values(stats)) {
    if (s.attempts > 0 && dueTime(s) <= now) n++;
  }
  return n;
}

// A word counts as learned when both directions (DE→EN and EN→DE) have been
// answered correctly and neither is currently failed.
function isKnown(id, dir) {
  const s = getStat(id, dir);
  return s.correct > 0 && (s.interval === undefined || s.interval > 0);
}

function isWordLearned(word) {
  return DIRS.every(dir => isKnown(word.id, dir));
}

function milestoneLearned(i) {
  return MILESTONES[i].filter(isWordLearned).length;
}

// The first milestone that is not yet 80% learned.
function currentMilestone() {
  for (let i = 0; i < MILESTONES.length; i++) {
    if (milestoneLearned(i) < Math.ceil(MILESTONES[i].length * MILESTONE_UNLOCK)) return i;
  }
  return MILESTONES.length - 1;
}

// Order: 1) cards that are due, most overdue first; 2) new cards in rank order
// (high-frequency words first; EN→DE once DE→EN is known); 3) the card due soonest.
function pickNext() {
  const now = Date.now();
  const due = [];
  const upcoming = [];
  for (const word of WORDS) {
    for (const dir of DIRS) {
      const s = stats[statKey(word.id, dir)];
      if (!s || !s.attempts) continue;
      const d = dueTime(s);
      (d <= now ? due : upcoming).push({ word, dir, d });
    }
  }

  const notLast = c => statKey(c.word.id, c.dir) !== lastKey;

  if (due.length) {
    due.sort((a, b) => a.d - b.d);
    const pool = due.filter(notLast).slice(0, 3);
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  }

  const maxMilestone = currentMilestone();
  for (const word of WORDS) {           // WORDS is sorted by rank
    if (MILESTONE_OF.get(word.id) > maxMilestone) break;   // not unlocked yet
    if (!isSeen(word.id, 'de-en')) return { word, dir: 'de-en' };
    const deEn = getStat(word.id, 'de-en');
    if (!isSeen(word.id, 'en-de') && deEn.correct > 0 && now - (deEn.lastSeen || 0) > EN_DE_DELAY) {
      return { word, dir: 'en-de' };
    }
  }

  const rest = upcoming.concat(due).filter(notLast).sort((a, b) => a.d - b.d);
  return rest[0] || due[0] || { word: WORDS[0], dir: 'de-en' };
}

// ── Highlighting the word in its example sentence ─────────────────────────────
const SKIP_FORMS = new Set(['hat', 'ist', 'es', 'sich', 'der', 'die', 'das', 'nur', 'plural', 'als', 'modalverb']);

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Wrap the studied word, or one of its forms, in <strong>. Catches plurals and
// verb forms from the word's forms ("fand", "gefunden"), inflected endings
// ("Wohnungen", "findet"), separable prefixes ("stehe … auf") and compounds
// ("Hausaufgaben" for "die Aufgabe").
function highlightWord(sentence, word) {
  const rawBase = word.de
    .replace(/\(.*?\)/g, ' ')
    .split('/')
    .flatMap(v => stripArticle(v.trim()).replace(/^sich /, '').split(/\s+/))
    .map(w => w.replace(/[-–]+$/, ''))
    .filter(w => w.length >= 2);
  const base = rawBase.map(w => w.toLowerCase());
  const isNoun = ARTICLES.some(a => word.de.toLowerCase().startsWith(a));
  const formWords = (word.forms || '')
    .split(/[\s,/()]+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 2 && !SKIP_FORMS.has(w));

  const exact = new Set([...base, ...formWords]);
  const stems = [
    ...base.filter(w => w.length >= 4).map(w => w.replace(/(en|ern|eln|n|e)$/, '')),
    ...formWords.filter(w => w.length >= 4).map(w => w.replace(/(et|st|t|en|e)$/, '')),
  ].filter(s => s.length >= 3);
  const compounds = isNoun ? base.filter(w => w.length >= 4) : [];
  const shortWords = base.filter(w => w.length === 3);            // gut → gutes, arm → armen
  const prefixes   = word.de.trim().endsWith('-') ? base : [];    // Bio- → Biogemüse

  return escapeHtml(sentence).replace(/[A-Za-zÄÖÜäöüß]+(?:-[A-Za-zÄÖÜäöüß]+)*/g, tok => {
    const t = tok.toLowerCase();
    const hit = exact.has(t)
      || stems.some(s => t.startsWith(s) && (s.length >= 6 || t.length <= s.length + 4))
      || compounds.some(c => t.length > c.length && t.includes(c))
      || shortWords.some(w => t.startsWith(w) && t.length <= w.length + 3)
      || prefixes.some(p => t.startsWith(p));
    return hit ? `<strong>${tok}</strong>` : tok;
  });
}

// The example sentence, word by word, with a small English gloss under each word
// (glosses are worked out in advance in words.js as "exg", one per word).
function renderExample(word) {
  const chunks = word.ex.trim().split(/\s+/);
  const glosses = word.exg && word.exg.length === chunks.length ? word.exg : null;
  if (!glosses) return highlightWord(word.ex, word);
  return chunks.map((chunk, i) => {
    const de = highlightWord(chunk, word);
    const isTarget = de.includes('<strong>');
    return `<span class="w${isTarget ? ' target' : ''}">` +
             `<span class="w-de">${de}</span>` +
             `<span class="w-en">${escapeHtml(glosses[i] || '')}</span>` +
           `</span>`;
  }).join(' ');
}

// ── Answer checking ───────────────────────────────────────────────────────────
function normalize(s) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Loosen an English answer: drop "(...)", "to ", "the ", "a ", trailing punctuation.
function looseEn(s) {
  return normalize(s)
    .replace(/\(.*?\)/g, '')
    .replace(/^(to|the|a|an) /, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Loosen a German answer: drop the article, "(sich)"/"sich", and "(...)".
function looseDe(s) {
  return normalize(stripArticle(normalize(s)))
    .replace(/^\(sich\) |^sich /, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripArticle(s) {
  const lower = s.toLowerCase();
  for (const art of ARTICLES) {
    if (lower.startsWith(art)) return s.slice(art.length);
  }
  return s;
}

function isCorrectAnswer(userInput) {
  const user = normalize(userInput);
  if (!user) return false;
  if (currentDir === 'de-en') {
    const variants = currentWord.en.split('/').flatMap(v => {
      const parts = v.split('=');             // e.g. "es gibt = there is"
      return parts.map(p => looseEn(p));
    });
    return variants.includes(looseEn(user)) || variants.includes(user);
  } else {
    // Without an article: the word alone is enough. With an article: it must be the right one.
    const typedArticle = ARTICLES.some(a => user.startsWith(a));
    const variants = currentWord.de.split('/').map(v => v.trim());
    return variants.some(v => {
      if (user === normalize(v)) return true;
      const article = ARTICLES.find(a => normalize(v).startsWith(a));
      if (typedArticle && article && !user.startsWith(article)) return false;
      return looseDe(user) === looseDe(v);
    });
  }
}

// ── Speech ────────────────────────────────────────────────────────────────────
function getGermanVoice() {
  const voices = speechSynthesis.getVoices();
  // Prefer de-DE, fall back to any German voice
  return voices.find(v => v.lang === 'de-DE')
      || voices.find(v => v.lang.startsWith('de'))
      || null;
}

function speakWord() {
  if (!('speechSynthesis' in window)) return;
  const say = () => {
    const utt = new SpeechSynthesisUtterance(currentWord.de);
    utt.lang = 'de-DE';
    utt.rate = 0.85;
    utt.pitch = 1;
    const voice = getGermanVoice();
    if (voice) utt.voice = voice;
    speechSynthesis.cancel();
    speechSynthesis.speak(utt);
  };
  if (speechSynthesis.getVoices().length) {
    say();
  } else {
    speechSynthesis.addEventListener('voiceschanged', say, { once: true });
  }
}

document.getElementById('speak-btn').addEventListener('click', speakWord);

// ── UI helpers ────────────────────────────────────────────────────────────────
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

function setPhase(phase) {
  const phases = { input: 'input-phase', show: 'show-phase', result: 'result-phase' };
  for (const [key, elId] of Object.entries(phases)) {
    key === phase ? show(elId) : hide(elId);
  }
}

function updateScoreBar() {
  document.getElementById('session-score').textContent =
    `${sessionCorrect} / ${sessionAttempts} correct`;

  const learned = WORDS.filter(isWordLearned).length;

  // Progress bar shows the current milestone.
  const m      = currentMilestone();
  const group  = MILESTONES[m];
  const done   = milestoneLearned(m);
  const target = Math.ceil(group.length * MILESTONE_UNLOCK);
  const first  = group[0].rank, last = group[group.length - 1].rank;
  document.getElementById('milestone-title').textContent =
    `Milestone ${m + 1} of ${MILESTONES.length} · words ${first}–${last}`;
  document.getElementById('progress-bar').style.width = `${Math.min(100, Math.round(done / target * 100))}%`;
  document.getElementById('progress-label').textContent = `${done} / ${target} to unlock next`;
  if (m === MILESTONES.length - 1) {
    document.getElementById('progress-label').textContent = `${done} / ${group.length} learned`;
  }

  // Celebrate when a new milestone unlocks during this session.
  if (shownMilestone !== null && m > shownMilestone) {
    const banner = document.getElementById('milestone-banner');
    banner.textContent = `🎉 Milestone ${m} complete! Milestone ${m + 1} (words ${first}–${last}) is unlocked.`;
    banner.classList.remove('hidden');
    setTimeout(() => banner.classList.add('hidden'), 8000);
  }
  shownMilestone = m;

  document.getElementById('stats-detail').textContent =
    `${learned.toLocaleString('en')} / ${TOTAL_WORDS.toLocaleString('en')} words learned · ${countDue()} due for review`;
}

// ── Milestones page ───────────────────────────────────────────────────────────
// A list of every milestone; open one to glance at its 50 words, German and English.
// Short labels for word types.
const POS_LABEL = {
  noun: 'noun', verb: 'verb', adjective: 'adj.', adverb: 'adv.', preposition: 'prep.',
  conjunction: 'conj.', pronoun: 'pron.', determiner: 'det.', number: 'num.',
  particle: 'particle', interjection: 'interj.', prefix: 'prefix', phrase: 'phrase',
};
function posLabel(word) {
  return word.pos && word.pos !== 'other' ? (POS_LABEL[word.pos] || word.pos) : '';
}

function wordStatus(word) {
  if (isWordLearned(word)) return 'learned';
  if (DIRS.some(dir => isSeen(word.id, dir))) return 'started';
  return 'new';
}

function renderMilestoneWords(i) {
  return '<div class="ms-words">' + MILESTONES[i].map(w => {
    const pos   = posLabel(w);
    const forms = w.forms ? `<div class="ms-forms">${escapeHtml(w.forms)}</div>` : '';
    const ex    = w.ex ? `<div class="ms-ex">${highlightWord(w.ex, w)}</div>` : '';
    return `<div class="ms-row ms-${wordStatus(w)}">` +
             `<span class="ms-dot" title="${wordStatus(w)}"></span>` +
             `<div class="ms-left">` +
               `<span class="ms-de">${escapeHtml(w.de)}</span>` +
               (pos ? ` <span class="pos-chip">${pos}</span>` : '') +
               forms +
             `</div>` +
             `<div class="ms-en">${escapeHtml(w.en)}</div>` +
             ex +
           `</div>`;
  }).join('') + '</div>';
}

function renderMilestones() {
  const current = currentMilestone();
  const learnedAll = WORDS.filter(isWordLearned).length;
  document.getElementById('ms-summary').textContent =
    `You're on milestone ${current + 1} of ${MILESTONES.length} · ` +
    `${learnedAll.toLocaleString('en')} / ${TOTAL_WORDS.toLocaleString('en')} words learned`;

  const list = document.getElementById('ms-list');
  list.innerHTML = MILESTONES.map((group, i) => {
    const done   = milestoneLearned(i);
    const pct    = Math.round(done / group.length * 100);
    const state  = i < current ? 'done' : i === current ? 'current' : 'locked';
    const chip   = { done: 'Done', current: 'Current', locked: 'Locked' }[state];
    return `<details class="ms-item ms-${state}" data-index="${i}"${i === current ? ' open' : ''}>` +
             `<summary>` +
               `<span class="ms-name">Milestone ${i + 1}</span>` +
               `<span class="ms-range">words ${group[0].rank}–${group[group.length - 1].rank}</span>` +
               `<span class="ms-chip">${chip}</span>` +
               `<span class="ms-bar"><span style="width:${pct}%"></span></span>` +
               `<span class="ms-count">${done}/${group.length}</span>` +
             `</summary>` +
             `<div class="ms-body">${i === current ? renderMilestoneWords(i) : ''}</div>` +
           `</details>`;
  }).join('');

  // Fill a milestone's word list only when it's opened (keeps the page fast).
  list.querySelectorAll('details').forEach(d => d.addEventListener('toggle', () => {
    const body = d.querySelector('.ms-body');
    if (d.open && !body.innerHTML) body.innerHTML = renderMilestoneWords(+d.dataset.index);
  }));

  const cur = list.querySelector('.ms-current');
  if (cur) setTimeout(() => cur.scrollIntoView({ block: 'start' }), 0);
}

// Simple routing: #milestones shows the list, anything else shows practice.
function showView() {
  const onList = location.hash === '#milestones';
  document.getElementById('practice-view').classList.toggle('hidden', onList);
  document.getElementById('milestones-view').classList.toggle('hidden', !onList);
  document.getElementById('view-btn').textContent = onList ? 'Practice' : 'Milestones';
  if (onList) renderMilestones();
  else updateScoreBar();
}

document.getElementById('view-btn').addEventListener('click', () => {
  location.hash = location.hash === '#milestones' ? '' : '#milestones';
});
window.addEventListener('hashchange', showView);

// ── Core flow ─────────────────────────────────────────────────────────────────
function nextCard() {
  const picked = pickNext();
  currentWord = picked.word;
  currentDir  = picked.dir;

  document.getElementById('direction').innerHTML =
    currentDir === 'de-en' ? 'DE &rarr; EN' : 'EN &rarr; DE';
  const posEl = document.getElementById('pos');
  posEl.textContent = posLabel(currentWord);
  posEl.classList.toggle('hidden', !posEl.textContent);
  document.getElementById('word').textContent =
    currentDir === 'de-en' ? currentWord.de : currentWord.en;

  // Forms are a hint on DE→EN; on EN→DE they would give the answer away.
  const formsEl = document.getElementById('forms');
  formsEl.textContent = currentDir === 'de-en' && currentWord.forms ? `(${currentWord.forms})` : '';
  document.getElementById('speak-btn').style.visibility = currentDir === 'de-en' ? 'visible' : 'hidden';
  lastKey = statKey(currentWord.id, currentDir);
  hide('details');

  document.getElementById('answer-input').value = '';
  setPhase('input');
  document.getElementById('answer-input').focus();
}

function fullGerman(word) {
  return word.forms ? `${word.de} (${word.forms})` : word.de;
}

function correctAnswerText() {
  return currentDir === 'de-en' ? currentWord.en : fullGerman(currentWord);
}

// Show the example sentence with the answer.
function showDetails() {
  const set = (id, text) => {
    const el = document.getElementById(id);
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  };
  const exEl = document.getElementById('detail-example');
  exEl.innerHTML = currentWord.ex ? renderExample(currentWord) : '';
  exEl.classList.toggle('hidden', !currentWord.ex);
  document.getElementById('speak-btn').style.visibility = 'visible';
  show('details');
}

function handleCheck() {
  const input = document.getElementById('answer-input').value;
  if (!input.trim()) return;

  const correct = isCorrectAnswer(input);
  recordResult(currentWord.id, currentDir, correct);
  sessionAttempts++;
  if (correct) sessionCorrect++;
  updateScoreBar();

  const correctText = correctAnswerText();
  const msgEl = document.getElementById('result-message');
  if (correct) {
    msgEl.textContent = '✓ Correct!';
    msgEl.className = 'result-message correct';
    document.getElementById('result-answer').textContent = correctText;
  } else {
    msgEl.textContent = '✗ Wrong.';
    msgEl.className = 'result-message wrong';
    document.getElementById('result-answer').textContent = `Answer: ${correctText}`;
  }
  showDetails();
  setPhase('result');
}

function handleShowMe() {
  document.getElementById('revealed-answer').textContent = correctAnswerText();
  showDetails();
  setPhase('show');
}

function handleSelfRate(knew) {
  recordResult(currentWord.id, currentDir, knew);
  sessionAttempts++;
  if (knew) sessionCorrect++;
  updateScoreBar();
  nextCard();
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.getElementById('check-btn').addEventListener('click', handleCheck);
document.getElementById('show-btn').addEventListener('click', handleShowMe);
document.getElementById('knew-btn').addEventListener('click', () => handleSelfRate(true));
document.getElementById('didnt-btn').addEventListener('click', () => handleSelfRate(false));
document.getElementById('next-btn').addEventListener('click', nextCard);

document.getElementById('answer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleCheck();
});

document.getElementById('reset-btn').addEventListener('click', () => {
  if (confirm('Reset all progress? This cannot be undone.')) {
    localStorage.removeItem(STORAGE_KEY);
    if (currentUser) {
      db.collection('users').doc(currentUser.uid).delete()
        .catch(e => console.warn('Firestore delete failed:', e));
    }
    stats = {};
    sessionCorrect = 0;
    sessionAttempts = 0;
    updateScoreBar();
    nextCard();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
loadStats();
updateScoreBar();
nextCard();
showView();
