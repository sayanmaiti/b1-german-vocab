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

// ── Decks and milestones ──────────────────────────────────────────────────────
// Words are practised in one deck per word type. Inside a deck, words come in
// milestones of 30 by exam frequency (rank); prepositions are grouped by case and
// connectors by word order. New words come only from the deck's current milestone;
// the next unlocks once every word in it is done. Progress is stored per word, so
// it doesn't matter in which deck a word was learned.
const MILESTONE_SIZE = 30;
const DECKS = [
  { id: 'verbs',        name: 'Verbs' },
  { id: 'nouns',        name: 'Nouns' },
  { id: 'adjectives',   name: 'Adjectives' },
  { id: 'adverbs',      name: 'Adverbs' },
  { id: 'prepositions', name: 'Prepositions' },
  { id: 'connectors',   name: 'Connectors' },
  { id: 'pronouns',     name: 'Pronouns & articles' },
  { id: 'numbers',      name: 'Numbers' },
  { id: 'expressions',  name: 'Expressions' },
];
const DECK_NAME = Object.fromEntries(DECKS.map(d => [d.id, d.name]));
const GROUPS = {
  prepositions: [
    ['Akk',     'Accusative',        'für, ohne, durch, gegen, um …'],
    ['Dativ',   'Dative',            'mit, nach, bei, von, zu, aus, seit …'],
    ['Wechsel', 'Two-way (Wechsel)', 'where? → Dative · where to? → Accusative'],
    ['Genitiv', 'Genitive',          'wegen, trotz, während …'],
  ],
  connectors: [
    ['normal', 'Normal word order',    '…, aber ich komme.'],
    ['next',   'Verb comes next',      '…, deshalb komme ich.'],
    ['last',   'Verb goes to the end', '…, weil ich komme.'],
    ['two',    'Two-part connectors',  'entweder … oder, sowohl … als auch …'],
  ],
};
const DECK_WORDS = {};
for (const d of DECKS) DECK_WORDS[d.id] = WORDS.filter(w => w.deck === d.id);   // WORDS is sorted by rank

function buildMilestones(deckId) {
  const words = DECK_WORDS[deckId];
  if (GROUPS[deckId]) {
    return GROUPS[deckId]
      .map(([key, name, sub]) => ({ name, sub, words: words.filter(w => (w.group || GROUPS[deckId][0][0]) === key) }))
      .filter(m => m.words.length)
      .map(m => ({ ...m, in90: m.words.some(w => w.in90) }));
  }
  if (words.length <= MILESTONE_SIZE * 1.5) return [{ name: DECK_NAME[deckId], sub: `${words.length} words`, words, in90: words.some(w => w.in90) }];
  const groups = [];
  for (let i = 0; i < words.length; i += MILESTONE_SIZE) groups.push(words.slice(i, i + MILESTONE_SIZE));
  // Fold a small remainder into the previous milestone instead of a tiny last one.
  if (groups.length > 1 && groups[groups.length - 1].length <= MILESTONE_SIZE / 2) {
    groups[groups.length - 2] = groups[groups.length - 2].concat(groups.pop());
  }
  let pos = 0;
  return groups.map((g, i) => {
    const m = { name: `Milestone ${i + 1}`, sub: `words ${pos + 1}–${pos + g.length} of ${words.length}`, words: g, in90: !!g[0].in90 };
    pos += g.length;
    return m;
  });
}
const DECK_MS = Object.fromEntries(DECKS.map(d => [d.id, buildMilestones(d.id)]));
const MILESTONE_OF = new Map();   // word id → index of its milestone inside its deck
for (const d of DECKS) DECK_MS[d.id].forEach((m, i) => m.words.forEach(w => MILESTONE_OF.set(w.id, i)));

const DECK_KEY = 'b1_vocab_deck';
let deck = (() => { try { const d = localStorage.getItem(DECK_KEY); return DECK_NAME[d] ? d : 'verbs'; } catch (_) { return 'verbs'; } })();
const ms = () => DECK_MS[deck];
const deckWords = () => DECK_WORDS[deck];

function setDeck(id) {
  if (!DECK_NAME[id] || id === deck) return;
  deck = id;
  try { localStorage.setItem(DECK_KEY, id); } catch (_) {}
  shownMilestone = null;
  lastKey = null;
  cardsSinceNew = 0;
  renderDeckBars();
  if (location.hash === '#milestones') renderMilestones();
  updateScoreBar();
  if (!difficultMode) nextCard();
}

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
  // Difficult (starred) words come back sooner than usual.
  if (isCorrect && isStarred(wordId) && s.interval > 1) {
    s.interval = Math.max(1, Math.round(s.interval * 0.6 * 10) / 10);
    s.due = Date.now() + s.interval * DAY;
  }
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

function countDue(d = deck, now = Date.now()) {
  let n = 0;
  for (const w of DECK_WORDS[d]) {
    for (const dir of DIRS) {
      const s = stats[statKey(w.id, dir)];
      if (s && s.attempts > 0 && dueTime(s) <= now) n++;
    }
  }
  return n;
}

// Share of telc exam text covered by the words you have learned: function words
// (articles, pronouns …) plus each learned word's share of the exam texts.
function examCoverage() {
  let c = 0;
  for (const w of WORDS) if (w.cov && isWordLearned(w)) c += w.cov;
  return COVERAGE_BASE + c / 1000;
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

// A word is "done" for its milestone once both directions have been answered
// correctly at least once. Getting it wrong later doesn't re-lock the milestone;
// the word simply comes back for review.
function isWordDone(word) {
  return DIRS.every(dir => getStat(word.id, dir).correct > 0);
}

function milestoneDone(i, d = deck) {
  return DECK_MS[d][i].words.filter(isWordDone).length;
}

// The first milestone that still has words not done.
function currentMilestone(d = deck) {
  const list = DECK_MS[d];
  for (let i = 0; i < list.length; i++) {
    if (milestoneDone(i, d) < list[i].words.length) return i;
  }
  return list.length - 1;
}

// ── Difficult words (starred) ─────────────────────────────────────────────────
// Stored in the same stats object (key "star_<id>") so they sync like progress.
const starKey = id => `star_${id}`;

function isStarred(id) {
  const s = stats[starKey(id)];
  return !!(s && s.starred);
}

function toggleStar(id) {
  stats[starKey(id)] = { starred: !isStarred(id), lastSeen: Date.now() };
  saveStats();
  return isStarred(id);
}

function starredWords() {
  return WORDS.filter(w => isStarred(w.id));
}

// Practising only the difficult words (for this session).
let difficultMode = false;
let difficultDone = new Set();   // starred words answered correctly in this round

function pickDifficult() {
  const starred = starredWords();
  if (!starred.length) { difficultMode = false; return null; }
  let pool = starred.filter(w => !difficultDone.has(w.id));
  if (!pool.length) { difficultDone.clear(); pool = starred; }   // round done: start again
  const lastId = lastKey ? Number(lastKey.split('_')[0]) : null;
  if (pool.length > 1) pool = pool.filter(w => w.id !== lastId);
  const word = pool[Math.floor(Math.random() * pool.length)];
  // Ask the weaker direction first.
  const [a, b] = DIRS.map(dir => getStat(word.id, dir).correct);
  const dir = a === b ? DIRS[Math.floor(Math.random() * 2)] : (a < b ? 'de-en' : 'en-de');
  return { word, dir };
}

// Card order:
//  1. Missed cards that are due again (you got them wrong; they come back first).
//  2. Every 4th card, if available: a new card from the current milestone, so a
//     backlog of reviews never stops you learning.
//  3. Other due reviews, hardest first: starred words, then the ones you have
//     found harder (lower ease, shorter interval), then the most overdue.
//  4. New cards from the current milestone (EN→DE once DE→EN is known).
//  5. Nothing due and nothing new: missed or starred cards early, else the card
//     due soonest.
let cardsSinceNew = 0;

function findNewCard(now) {
  const maxMilestone = currentMilestone();
  let waitingEnDe = null;               // an EN→DE card still inside its short delay
  for (const word of deckWords()) {     // sorted by rank inside the deck
    if (MILESTONE_OF.get(word.id) > maxMilestone) break;   // not unlocked yet
    if (!isSeen(word.id, 'de-en')) return { word, dir: 'de-en' };
    const deEn = getStat(word.id, 'de-en');
    if (!isSeen(word.id, 'en-de') && deEn.correct > 0) {
      if (now - (deEn.lastSeen || 0) > EN_DE_DELAY) return { word, dir: 'en-de' };
      if (!waitingEnDe && statKey(word.id, 'en-de') !== lastKey) waitingEnDe = { word, dir: 'en-de', waiting: true };
    }
  }
  return waitingEnDe;
}

// Lower = harder = shown sooner.
function reviewPriority(c) {
  const s = getStat(c.word.id, c.dir);
  return (isStarred(c.word.id) ? -100 : 0) + (s.ease || 2.5) * 10 + Math.min(s.interval || 0, 30);
}

function pickNext() {
  if (difficultMode) {
    const d = pickDifficult();
    if (d) return d;
  }
  const now = Date.now();
  const relearn = [];   // missed cards, due again
  const reviews = [];   // other due cards
  const later   = [];   // not due yet
  for (const word of deckWords()) {
    for (const dir of DIRS) {
      const key = statKey(word.id, dir);
      const s = stats[key];
      if (!s || !s.attempts || key === lastKey) continue;
      const c = { word, dir, d: dueTime(s), missed: s.interval === 0 };
      if (c.d > now) later.push(c);
      else (c.missed ? relearn : reviews).push(c);
    }
  }
  const pick = c => {
    cardsSinceNew = c.isNew ? 0 : cardsSinceNew + 1;
    return c;
  };

  // 1. Missed cards first, the one missed longest ago first.
  if (relearn.length) {
    relearn.sort((a, b) => a.d - b.d);
    return pick(relearn[0]);
  }

  // 2. Keep new words coming even when there is a backlog.
  const fresh = findNewCard(now);
  if (fresh && !fresh.waiting && reviews.length && cardsSinceNew >= 3) {
    return pick({ ...fresh, isNew: true });
  }

  // 3. Due reviews, hardest first (a little randomness among the top three).
  if (reviews.length) {
    reviews.sort((a, b) => reviewPriority(a) - reviewPriority(b) || a.d - b.d);
    const top = reviews.slice(0, 3);
    return pick(top[Math.floor(Math.random() * top.length)]);
  }

  // 4. New cards (or an EN→DE card early rather than stalling).
  if (fresh) return pick({ ...fresh, isNew: !fresh.waiting });

  // 5. Nothing due, nothing new: missed or starred cards early, else the soonest due.
  const early = later.filter(c => c.missed || isStarred(c.word.id)).sort((a, b) => a.d - b.d);
  if (early.length) return pick(early[0]);
  later.sort((a, b) => a.d - b.d);
  return pick(later[0] || { word: deckWords()[0], dir: 'de-en' });
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

  // Progress bar shows the deck's current milestone.
  const list   = ms();
  const m      = currentMilestone();
  const group  = list[m];
  const done   = milestoneDone(m);
  const target = group.words.length;
  const chunked = !GROUPS[deck] && list.length > 1;
  document.getElementById('milestone-title').innerHTML =
    `${escapeHtml(DECK_NAME[deck])} · ` + (chunked ? `Milestone ${m + 1} of ${list.length}` : escapeHtml(group.name)) +
    (group.in90 ? ' <span class="ms-90">90% SET</span>' : '');
  document.getElementById('progress-bar').style.width = `${Math.min(100, Math.round(done / target * 100))}%`;
  document.getElementById('progress-label').textContent =
    m === list.length - 1 ? `${done} / ${target} done` : `${done} / ${target} done to unlock next`;
  updateModeChip();

  // Celebrate when a new milestone unlocks during this session.
  if (shownMilestone !== null && m > shownMilestone) {
    const banner = document.getElementById('milestone-banner');
    banner.textContent = `🎉 ${list[m - 1].name} complete! ${group.name} is unlocked.`;
    banner.classList.remove('hidden');
    setTimeout(() => banner.classList.add('hidden'), 8000);
  }
  shownMilestone = m;

  renderGoal(document.getElementById('goal'));
  renderDeckBars();
  const learned = deckWords().filter(isWordLearned).length;
  document.getElementById('stats-detail').textContent =
    `${DECK_NAME[deck]}: ${learned.toLocaleString('en')} / ${deckWords().length.toLocaleString('en')} learned · ${countDue()} due for review`;
}

// The 90% goal: how much of the deck's 90% set you know, and how much exam text all your words cover.
function renderGoal(el) {
  if (!el) return;
  const set = deckWords().filter(w => w.in90);
  const known = set.filter(isWordLearned).length;
  const cov = examCoverage();
  el.innerHTML =
    `<div class="goal-top"><span>${escapeHtml(DECK_NAME[deck])} you know</span><b>${known.toLocaleString('en')} of ${set.length.toLocaleString('en')}</b></div>` +
    `<div class="goal-bar"><i style="width:${set.length ? Math.round(known / set.length * 100) : 0}%"></i></div>` +
    `<div class="goal-sub">in the 90% set · all your words cover <b>${Math.round(cov)}%</b> of telc exam text (goal: 90%)</div>`;
}

// Deck chips at the top of both views.
function renderDeckBars() {
  const html = DECKS.map(d => {
    const due = countDue(d.id);
    return `<button class="deck${d.id === deck ? ' on' : ''}" data-deck="${d.id}" type="button">${escapeHtml(d.name)}` +
           `<small>${DECK_WORDS[d.id].length.toLocaleString('en')} words${due ? ` · ${due} due` : ''}</small></button>`;
  }).join('');
  document.querySelectorAll('.deck-bar').forEach(el => { el.innerHTML = html; });
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.deck-bar .deck');
  if (chip) setDeck(chip.dataset.deck);
});

// ── Milestones page ───────────────────────────────────────────────────────────
// A list of every milestone; open one to glance at its words, German and English.
// A second tab lists the difficult (starred) words from every milestone.
// Short labels for word types.
const POS_LABEL = {
  noun: 'noun', verb: 'verb', adjective: 'adj.', adverb: 'adv.', preposition: 'prep.',
  conjunction: 'conj.', pronoun: 'pron.', determiner: 'det.', number: 'num.',
  particle: 'particle', interjection: 'interj.', prefix: 'prefix', phrase: 'phrase',
};
function posLabel(word) {
  const base = word.pos && word.pos !== 'other' ? (POS_LABEL[word.pos] || word.pos) : '';
  if (!word.vtype || word.vtype === 'regular') return base;
  const helper = word.vtype === 'modal' && ['sein', 'haben', 'werden'].includes(word.de);
  return `${base} · ${helper ? 'helper' : word.vtype}`;
}

// Purple tags (+Dat, auf + Akk, n-decl., separable) and an orange label for words added from the telc exams.
function tagsHtml(word, cls = 'tag') {
  return (word.tags || []).map(t => `<span class="${cls}">${escapeHtml(t)}</span>`).join('') +
         (word.isNew ? `<span class="${cls} tag-new">NEW · from telc exams</span>` : '');
}

// Case a preposition takes: Akk, Dativ, Wechsel (Akk for movement, Dativ for location) or Genitiv.
const CASE_TITLE = {
  Akk:     'Always followed by the accusative',
  Dativ:   'Always followed by the dative',
  Wechsel: 'Two-way: accusative for movement (wohin?), dative for location (wo?)',
  Genitiv: 'Followed by the genitive (often the dative in everyday speech)',
};
function caseChip(word, extraClass = '') {
  if (!word.case) return '';
  return `<span class="case-chip case-${word.case.toLowerCase()} ${extraClass}" title="${CASE_TITLE[word.case]}">${word.case}</span>`;
}

function wordStatus(word) {
  if (isWordLearned(word)) return 'learned';
  if (DIRS.some(dir => isSeen(word.id, dir))) return 'started';
  return 'new';
}

function renderWordRow(w) {
  const pos     = posLabel(w);
  const forms   = w.forms ? `<div class="ms-forms">${escapeHtml(w.forms)}</div>` : '';
  const ex      = w.ex ? `<div class="ms-ex">${highlightWord(w.ex, w)}</div>` : '';
  const starred = isStarred(w.id);
  return `<div class="ms-row ms-${wordStatus(w)}">` +
           `<span class="ms-dot" title="${wordStatus(w)}"></span>` +
           `<div class="ms-left">` +
             `<span class="ms-de">${escapeHtml(w.de)}</span>` +
             (pos ? ` <span class="pos-chip">${pos}</span>` : '') +
             (w.case ? ' ' + caseChip(w) : '') +
             ((w.tags || w.isNew) ? ` <span class="ms-tags">${tagsHtml(w)}</span>` : '') +
             (w.ndecl ? `<div class="ms-forms">${escapeHtml(w.ndecl)}</div>` : '') +
             forms +
           `</div>` +
           `<div class="ms-en">${escapeHtml(w.en)}</div>` +
           `<button class="ms-star${starred ? ' on' : ''}" data-id="${w.id}" type="button" ` +
             `aria-label="${starred ? 'Unmark' : 'Mark'} as difficult">${starred ? '★' : '☆'}</button>` +
           ex +
         `</div>`;
}

function renderMilestoneWords(i) {
  return '<div class="ms-words">' + ms()[i].words.map(renderWordRow).join('') + '</div>';
}

function updateDifficultCount() {
  document.getElementById('difficult-count').textContent = starredWords().length;
}

function renderDifficult() {
  const words = starredWords();
  updateDifficultCount();
  const head = document.getElementById('difficult-summary');
  const btn  = document.getElementById('practise-difficult-btn');
  const list = document.getElementById('difficult-list');
  if (!words.length) {
    head.textContent = 'No difficult words yet. Tap ☆ on a card, or next to any word in a milestone, to add it here.';
    btn.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  const groups = new Map();
  for (const w of words) {
    const g = `${DECK_NAME[w.deck]} · ${DECK_MS[w.deck][MILESTONE_OF.get(w.id)].name}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(w);
  }
  head.textContent = `${words.length} difficult word${words.length === 1 ? '' : 's'} from ` +
    `${groups.size} milestone${groups.size === 1 ? '' : 's'} (all decks)`;
  btn.classList.remove('hidden');
  list.innerHTML = '<div class="ms-item"><div class="ms-words">' +
    [...groups.entries()].map(([m, ws]) =>
      `<div class="group-label">${escapeHtml(m)}</div>` + ws.map(renderWordRow).join('')
    ).join('') + '</div></div>';
}

function renderMilestones() {
  const current = currentMilestone();
  renderGoal(document.getElementById('ms-summary'));
  renderDeckBars();
  updateDifficultCount();
  const list = document.getElementById('ms-list');
  const groups = ms();
  const lastIn90 = groups.reduce((a, g, i) => (g.in90 ? i : a), -1);
  list.innerHTML = groups.map((group, i) => {
    const done   = milestoneDone(i);
    const pct    = Math.round(done / group.words.length * 100);
    const state  = i < current ? 'done' : i === current ? 'current' : 'locked';
    const chip   = { done: 'Done', current: 'Current', locked: 'Locked' }[state];
    return `<details class="ms-item ms-${state}" data-index="${i}"${i === current ? ' open' : ''}>` +
             `<summary>` +
               `<span class="ms-name">${escapeHtml(group.name)}</span>` +
               `<span class="ms-range">${escapeHtml(group.sub)}</span>` +
               (group.in90 ? `<span class="ms-90">90% SET</span>` : '') +
               `<span class="ms-chip">${chip}</span>` +
               `<span class="ms-bar"><span style="width:${pct}%"></span></span>` +
               `<span class="ms-count">${done}/${group.words.length}</span>` +
             `</summary>` +
             `<div class="ms-body">${i === current ? renderMilestoneWords(i) : ''}</div>` +
           `</details>` +
           (i === lastIn90 && i < groups.length - 1 ? `<div class="ms-goal">🎯 90% goal for ${escapeHtml(DECK_NAME[deck].toLowerCase())}: up to ${escapeHtml(group.name.toLowerCase())}</div>` : '');
  }).join('');

  // Fill a milestone's word list only when it's opened (keeps the page fast).
  list.querySelectorAll('details').forEach(d => d.addEventListener('toggle', () => {
    const body = d.querySelector('.ms-body');
    if (d.open && !body.innerHTML) body.innerHTML = renderMilestoneWords(+d.dataset.index);
  }));

  const cur = list.querySelector('.ms-current');
  if (cur) setTimeout(() => cur.scrollIntoView({ block: 'start' }), 0);
}

// Simple routing: #milestones and #difficult show the lists, anything else shows practice.
function showView() {
  const hash      = location.hash;
  const onList    = hash === '#milestones' || hash === '#difficult';
  const onDiff    = hash === '#difficult';
  document.getElementById('practice-view').classList.toggle('hidden', onList);
  document.getElementById('milestones-view').classList.toggle('hidden', !onList);
  document.getElementById('view-btn').textContent = onList ? 'Practice' : 'Milestones';
  document.getElementById('tab-all').classList.toggle('active', !onDiff);
  document.getElementById('tab-difficult').classList.toggle('active', onDiff);
  document.getElementById('all-panel').classList.toggle('hidden', onDiff);
  document.getElementById('difficult-panel').classList.toggle('hidden', !onDiff);
  if (onDiff) renderDifficult();
  else if (onList) renderMilestones();
  else updateScoreBar();
}

document.getElementById('view-btn').addEventListener('click', () => {
  const onList = location.hash === '#milestones' || location.hash === '#difficult';
  location.hash = onList ? '' : '#milestones';
});
document.getElementById('tab-all').addEventListener('click', () => { location.hash = '#milestones'; });
document.getElementById('tab-difficult').addEventListener('click', () => { location.hash = '#difficult'; });
window.addEventListener('hashchange', showView);

// Stars next to words on the Milestones page.
document.getElementById('milestones-view').addEventListener('click', (e) => {
  const btn = e.target.closest('.ms-star');
  if (!btn) return;
  const on = toggleStar(Number(btn.dataset.id));
  btn.classList.toggle('on', on);
  btn.textContent = on ? '★' : '☆';
  btn.setAttribute('aria-label', `${on ? 'Unmark' : 'Mark'} as difficult`);
  if (location.hash === '#difficult') renderDifficult();
  else updateDifficultCount();
});

// Practise only the difficult words.
document.getElementById('practise-difficult-btn').addEventListener('click', () => {
  difficultMode = true;
  difficultDone = new Set();
  location.hash = '';
  nextCard();
});

document.getElementById('mode-exit').addEventListener('click', () => {
  difficultMode = false;
  updateScoreBar();
  nextCard();
});

function updateModeChip() {
  const chip = document.getElementById('mode-chip');
  const total = starredWords().length;
  if (difficultMode && total) {
    const left = starredWords().filter(w => !difficultDone.has(w.id)).length;
    document.getElementById('mode-text').textContent =
      `★ Practising difficult words · ${left} of ${total} left`;
  } else {
    difficultMode = false;
  }
  chip.classList.toggle('hidden', !difficultMode);
  document.getElementById('milestone-title').classList.toggle('hidden', difficultMode);
  document.querySelector('.progress-row').classList.toggle('hidden', difficultMode);
}

// The star on the flashcard.
function updateStarBtn() {
  const btn = document.getElementById('star-btn');
  const on = isStarred(currentWord.id);
  btn.classList.toggle('on', on);
  btn.textContent = on ? '★' : '☆';
  btn.setAttribute('aria-label', `${on ? 'Unmark' : 'Mark'} as difficult`);
}

let starHintTimer = null;
document.getElementById('star-btn').addEventListener('click', () => {
  const on = toggleStar(currentWord.id);
  updateStarBtn();
  const hint = document.getElementById('star-hint');
  hint.textContent = on ? 'Marked difficult' : 'Removed from difficult';
  hint.classList.remove('hidden');
  clearTimeout(starHintTimer);
  starHintTimer = setTimeout(() => hint.classList.add('hidden'), 1500);
  updateModeChip();
});

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
  // Prepositions also show the case they take (shown in both directions).
  document.getElementById('case').outerHTML =
    caseChip(currentWord, 'case-chip-card').replace('<span ', '<span id="case" ') || '<span id="case" class="hidden"></span>';
  document.getElementById('word').textContent =
    currentDir === 'de-en' ? currentWord.de : currentWord.en;

  // Forms are a hint on DE→EN; on EN→DE they would give the answer away.
  const formsEl = document.getElementById('forms');
  formsEl.innerHTML = currentDir === 'de-en' ? formsHtml(currentWord) : '';
  const tagEl = document.getElementById('tag-row');
  tagEl.innerHTML = currentDir === 'de-en' ? tagsHtml(currentWord) : (currentWord.isNew ? tagsHtml({ isNew: true }) : '');
  tagEl.classList.toggle('hidden', !tagEl.innerHTML);
  const hint = currentDir === 'en-de' && currentWord.pos === 'noun' ? 'Type it with der, die or das' : '';
  document.getElementById('answer-hint').textContent = hint;
  document.getElementById('answer-hint').classList.toggle('hidden', !hint);
  document.getElementById('speak-btn').style.visibility = currentDir === 'de-en' ? 'visible' : 'hidden';
  lastKey = statKey(currentWord.id, currentDir);
  updateStarBtn();
  hide('star-hint');
  hide('details');

  document.getElementById('answer-input').value = '';
  setPhase('input');
  document.getElementById('answer-input').focus();
}

// Verbs: three boxes (er/sie/es · Präteritum · Perfekt). Others: the forms in brackets.
function formsHtml(word) {
  if (!word.forms) return '';
  const parts = word.forms.split(',').map(x => x.trim());
  if (word.pos === 'verb' && parts.length === 3) {
    const labels = ['er/sie/es', 'Präteritum', 'Perfekt'];
    return '<div class="forms-big">' + parts.map((f, i) => `<div><small>${labels[i]}</small>${escapeHtml(f)}</div>`).join('') + '</div>';
  }
  return escapeHtml(`(${word.forms})`);
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
  if (difficultMode && correct) difficultDone.add(currentWord.id);
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
    const articleOnly = currentDir === 'en-de' && currentWord.pos === 'noun' &&
      looseDe(stripArticle(input)) === looseDe(stripArticle(currentWord.de));
    msgEl.textContent = articleOnly ? '✗ Wrong article' : '✗ Wrong.';
    msgEl.className = 'result-message wrong';
    document.getElementById('result-answer').textContent =
      (articleOnly ? `You wrote: ${input.trim()} · ` : '') + `Answer: ${correctText}`;
  }
  if (currentDir === 'en-de' && (currentWord.tags || currentWord.ndecl)) {
    const tagEl = document.getElementById('tag-row');
    tagEl.innerHTML = tagsHtml(currentWord) + (currentWord.ndecl ? `<span class="tag tag-grey">${escapeHtml(currentWord.ndecl)}</span>` : '');
    tagEl.classList.remove('hidden');
  }
  showDetails();
  setPhase('result');
  document.getElementById('next-btn').focus({ preventScroll: true });
}

function handleShowMe() {
  document.getElementById('revealed-answer').textContent = correctAnswerText();
  showDetails();
  setPhase('show');
}

function handleSelfRate(knew) {
  recordResult(currentWord.id, currentDir, knew);
  if (difficultMode && knew) difficultDone.add(currentWord.id);
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
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();   // the same Enter must not also trigger "Next"
    handleCheck();
  }
});

// After an answer, Enter goes to the next card (wherever the focus is).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || location.hash) return;
  if (document.getElementById('result-phase').classList.contains('hidden')) return;
  if (document.activeElement && document.activeElement.id === 'next-btn') return;   // the button handles it
  e.preventDefault();
  nextCard();
});

document.getElementById('reset-btn').addEventListener('click', () => {
  if (confirm('Reset all progress? This cannot be undone.')) {
    localStorage.removeItem(STORAGE_KEY);
    if (currentUser) {
      // Only the flashcard stats: the same document also holds the Learn app's progress.
      db.collection('users').doc(currentUser.uid).update({ stats: firebase.firestore.FieldValue.delete() })
        .catch(e => console.warn('Firestore reset failed:', e));
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
renderDeckBars();
updateScoreBar();
nextCard();
showView();
