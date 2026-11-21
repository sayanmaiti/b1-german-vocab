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
const TOTAL_COMBOS = WORDS.length * 2;
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

// ── Auth UI ───────────────────────────────────────────────────────────────────
// Signed out: a "Sign in" button opens a panel with Google or email + password.
// Signed in: the account name and a "Sign out" button.
function updateAuthUI(user) {
  const statusEl = document.getElementById('auth-status');
  const btnEl    = document.getElementById('auth-btn');
  if (user) {
    statusEl.textContent = user.displayName || user.email;
    btnEl.textContent = 'Sign out';
    hide('login-panel');
  } else {
    statusEl.textContent = '';
    btnEl.textContent = 'Sign in';
  }
}

function setAuthMessage(text, isError = true) {
  const el = document.getElementById('login-message');
  el.textContent = text || '';
  el.className = 'login-message' + (isError ? ' error' : ' info');
}

// Friendly text for Firebase's error codes.
function authErrorText(e) {
  const messages = {
    'auth/invalid-email':          'That email address doesn\u2019t look right.',
    'auth/missing-password':       'Please enter your password.',
    'auth/weak-password':          'Choose a password with at least 6 characters.',
    'auth/email-already-in-use':   'An account with this email already exists. Sign in instead.',
    'auth/invalid-credential':     'Wrong email or password.',
    'auth/wrong-password':         'Wrong email or password.',
    'auth/user-not-found':         'No account with this email. Create one instead.',
    'auth/too-many-requests':      'Too many attempts. Please wait a moment and try again.',
    'auth/operation-not-allowed':  'Email sign-in isn\u2019t switched on in Firebase yet.',
    'auth/network-request-failed': 'No connection. Check your internet and try again.',
  };
  return messages[e && e.code] || 'Something went wrong. Please try again.';
}

function loginFields() {
  return {
    email:    document.getElementById('login-email').value.trim(),
    password: document.getElementById('login-password').value,
  };
}

async function runAuth(action) {
  setAuthMessage('');
  try {
    await action();
  } catch (e) {
    console.warn('Auth failed:', e);
    setAuthMessage(authErrorText(e));
  }
}

document.getElementById('auth-btn').addEventListener('click', () => {
  if (currentUser) {
    auth.signOut();
  } else {
    document.getElementById('login-panel').classList.toggle('hidden');
    setAuthMessage('');
    document.getElementById('login-email').focus();
  }
});

document.getElementById('google-btn').addEventListener('click', () =>
  runAuth(() => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()))
);

document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { email, password } = loginFields();
  runAuth(() => auth.signInWithEmailAndPassword(email, password));
});

document.getElementById('signup-btn').addEventListener('click', () => {
  const { email, password } = loginFields();
  runAuth(() => auth.createUserWithEmailAndPassword(email, password));
});

document.getElementById('forgot-btn').addEventListener('click', () => {
  const { email } = loginFields();
  if (!email) { setAuthMessage('Enter your email first, then tap \u201cForgot password?\u201d.'); return; }
  runAuth(async () => {
    await auth.sendPasswordResetEmail(email);
    setAuthMessage(`If an account exists for ${email}, a reset link is on its way.`, false);
  });
});

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

  for (const word of WORDS) {           // WORDS is sorted by rank
    if (!isSeen(word.id, 'de-en')) return { word, dir: 'de-en' };
    const deEn = getStat(word.id, 'de-en');
    if (!isSeen(word.id, 'en-de') && deEn.correct > 0 && now - (deEn.lastSeen || 0) > EN_DE_DELAY) {
      return { word, dir: 'en-de' };
    }
  }

  const rest = upcoming.concat(due).filter(notLast).sort((a, b) => a.d - b.d);
  return rest[0] || due[0] || { word: WORDS[0], dir: 'de-en' };
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

  // "Learned" = answered correctly at least once and not currently failed.
  let learned = 0;
  for (const word of WORDS) {
    for (const dir of DIRS) {
      const s = getStat(word.id, dir);
      if (s.correct > 0 && (s.interval === undefined || s.interval > 0)) learned++;
    }
  }
  const pct = Math.round((learned / TOTAL_COMBOS) * 100);
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = `${pct}% learned`;

  document.getElementById('stats-detail').textContent =
    `${learned} / ${TOTAL_COMBOS} learned · ${countDue()} due for review`;
}

// ── Core flow ─────────────────────────────────────────────────────────────────
function nextCard() {
  const picked = pickNext();
  currentWord = picked.word;
  currentDir  = picked.dir;

  document.getElementById('direction').innerHTML =
    currentDir === 'de-en' ? 'DE &rarr; EN' : 'EN &rarr; DE';
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

// Show the example sentence, the sentence from the telc mock and the exam parts.
function showDetails() {
  const set = (id, text) => {
    const el = document.getElementById(id);
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  };
  set('detail-example', currentWord.ex);
  set('detail-exam', currentWord.exam ? `telc mock: ${currentWord.exam}` : '');
  set('detail-parts', currentWord.parts ? `In the exam: ${currentWord.parts.join(', ')}` : '');
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
