// ── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'b1_vocab_stats';
const TOTAL_COMBOS = WORDS.length * 2; // each word has DE→EN and EN→DE
const ARTICLES = ['der ', 'die ', 'das ', 'den ', 'dem ', 'des '];

// ── State ────────────────────────────────────────────────────────────────────
let stats = {};          // persisted word stats
let currentWord = null;
let currentDir = null;   // 'de-en' | 'en-de'
let sessionCorrect = 0;
let sessionAttempts = 0;

// ── Persistence ──────────────────────────────────────────────────────────────
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
}

function statKey(wordId, dir) {
  return `${wordId}_${dir}`;
}

function getStat(wordId, dir) {
  return stats[statKey(wordId, dir)] || { correct: 0, attempts: 0 };
}

function recordResult(wordId, dir, isCorrect) {
  const key = statKey(wordId, dir);
  if (!stats[key]) stats[key] = { correct: 0, attempts: 0 };
  stats[key].attempts += 1;
  if (isCorrect) stats[key].correct += 1;
  stats[key].lastSeen = Date.now();
  saveStats();
}

// ── Priority algorithm ───────────────────────────────────────────────────────
// Higher value = show sooner.
// Balances: high-frequency words (40%) + weak/unseen words (60%)
function priority(word, dir) {
  const total = WORDS.length;
  const freqScore = (total - word.rank + 1) / total; // rank 1 → 1.0
  const stat = getStat(word.id, dir);
  const weakScore = stat.attempts > 0
    ? 1 - (stat.correct / stat.attempts)
    : 0.5; // unseen = neutral weakness
  return 0.4 * freqScore + 0.6 * weakScore;
}

function pickNext() {
  const candidates = [];
  for (const word of WORDS) {
    for (const dir of ['de-en', 'en-de']) {
      candidates.push({ word, dir, p: priority(word, dir) });
    }
  }
  candidates.sort((a, b) => b.p - a.p);

  // Pick randomly from top 5 to add variety and avoid being too deterministic
  const pool = candidates.slice(0, 5);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Answer checking ──────────────────────────────────────────────────────────
function normalize(s) {
  return s.trim().toLowerCase();
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
    // Accept any "/" separated variant
    const variants = currentWord.en.split('/').map(v => normalize(v));
    return variants.some(v => v === user);
  } else {
    // EN → DE: accept with or without article
    const canonical = normalize(currentWord.de);
    const withoutArt = normalize(stripArticle(currentWord.de));
    return user === canonical || user === withoutArt;
  }
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function show(id)  { document.getElementById(id).classList.remove('hidden'); }
function hide(id)  { document.getElementById(id).classList.add('hidden'); }

function setPhase(phase) {
  // phase: 'input' | 'show' | 'result'
  const phases = { 'input': 'input-phase', 'show': 'show-phase', 'result': 'result-phase' };
  for (const [key, elId] of Object.entries(phases)) {
    key === phase ? show(elId) : hide(elId);
  }
}

function updateScoreBar() {
  // Session score
  document.getElementById('session-score').textContent =
    `${sessionCorrect} / ${sessionAttempts} correct`;

  // Mastery progress: combos with at least 1 correct answer
  let mastered = 0;
  for (const word of WORDS) {
    for (const dir of ['de-en', 'en-de']) {
      if (getStat(word.id, dir).correct > 0) mastered++;
    }
  }
  const pct = Math.round((mastered / TOTAL_COMBOS) * 100);
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = `${pct}% mastered`;

  // Footer detail
  const totalAttempts = Object.values(stats)
    .reduce((sum, s) => sum + (s.attempts || 0), 0);
  document.getElementById('stats-detail').textContent =
    `${mastered} / ${TOTAL_COMBOS} combos mastered · ${totalAttempts} total attempts`;
}

// ── Core flow ────────────────────────────────────────────────────────────────
function nextCard() {
  const picked = pickNext();
  currentWord = picked.word;
  currentDir  = picked.dir;

  document.getElementById('direction').innerHTML =
    currentDir === 'de-en' ? 'DE &rarr; EN' : 'EN &rarr; DE';

  document.getElementById('word').textContent =
    currentDir === 'de-en' ? currentWord.de : currentWord.en;

  document.getElementById('answer-input').value = '';
  setPhase('input');
  document.getElementById('answer-input').focus();
}

function handleCheck() {
  const input = document.getElementById('answer-input').value;
  if (!input.trim()) return;

  const correct = isCorrectAnswer(input);
  recordResult(currentWord.id, currentDir, correct);
  sessionAttempts++;
  if (correct) sessionCorrect++;
  updateScoreBar();

  const correctText = currentDir === 'de-en' ? currentWord.en : currentWord.de;
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

  setPhase('result');
}

function handleShowMe() {
  const correctText = currentDir === 'de-en' ? currentWord.en : currentWord.de;
  document.getElementById('revealed-answer').textContent = correctText;
  setPhase('show');
}

function handleSelfRate(knew) {
  recordResult(currentWord.id, currentDir, knew);
  sessionAttempts++;
  if (knew) sessionCorrect++;
  updateScoreBar();
  nextCard();
}

// ── Event listeners ──────────────────────────────────────────────────────────
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
    stats = {};
    sessionCorrect = 0;
    sessionAttempts = 0;
    updateScoreBar();
    nextCard();
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
loadStats();
updateScoreBar();
nextCard();
