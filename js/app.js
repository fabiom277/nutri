// ── Nutrì — app.js ──────────────────────────────────
import {
  supabase, signUp, signIn, signOut, getSession, onAuthChange,
  getProfile, upsertProfile, getAllRecipes,
  getExcludedIds, excludeRecipe,
  getConfirmedMeals, confirmMeal, unconfirmMeal,
  getWeightLogs, addWeightLog, deleteWeightLog,
  getRatings, setRating, savePushSubscription
} from './supabase.js';

import {
  calcBMR, calcTDEE, calcTargetCalories, calcBMI, bmiStatus,
  caloriesBySlot, activeSlots, generateWeeklyPlan, replaceRecipe,
  filterRecipes, scaleRecipeToTarget, recipeScore,
  buildShoppingList, formatDate, formatDateShort
} from './nutrition.js';

// ── State ─────────────────────────────────────────────
const state = {
  session: null,
  profile: null,
  recipes: [],
  plan: null,
  excluded: [],
  ratings: {},
  rejectedPerSlot: {},
  confirmedMeals: [],
  weightLogs: [],
  shoppingChecked: {},
  selectedShoppingDays: [],
  currentDayIndex: 0,      // giorno visualizzato nel piano (0 = oggi)
  currentModal: null,
};

// ── Toast ─────────────────────────────────────────────
function toast(msg, type = 'success') {
  const c = document.querySelector('.toast-container') || (() => {
    const d = document.createElement('div');
    d.className = 'toast-container';
    document.body.appendChild(d);
    return d;
  })();
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3100);
}

// ── Router ────────────────────────────────────────────
const PAGES = ['piano', 'calendario', 'spesa', 'profilo'];

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const page = document.getElementById(`page-${name}`);
  if (page) page.classList.add('active');
  document.querySelector(`.nav-item[data-page="${name}"]`)?.classList.add('active');

  if (name === 'piano')      renderPiano();
  if (name === 'spesa')      renderSpesa();
  if (name === 'profilo')    renderProfilo();

  // Pagine async: spinner immediato poi render
  if (name === 'dashboard') {
    const el = document.getElementById('page-dashboard');
    if (el) el.innerHTML = '<div id="main-content"><div class="loading-wrap"><div class="spinner"></div><p>Caricamento progressi...</p></div></div>';
    renderDashboard().catch(e => {
      console.error('[renderDashboard]', e);
      const el = document.getElementById('page-dashboard');
      if (el) el.innerHTML = `<div id="main-content"><div class="card mt-16" style="text-align:center;padding:32px"><p>⚠️ Errore caricamento: ${e.message}</p></div></div>`;
    });
  }
  if (name === 'calendario') {
    const el = document.getElementById('page-calendario');
    if (el) el.innerHTML = '<div id="main-content"><div class="loading-wrap"><div class="spinner"></div><p>Caricamento calendario...</p></div></div>';
    calendarYear  = null;
    calendarMonth = null;
    renderCalendar().catch(e => {
      console.error('[renderCalendar]', e);
      const el = document.getElementById('page-calendario');
      if (el) el.innerHTML = `<div id="main-content"><div class="card mt-16" style="text-align:center;padding:32px"><p>⚠️ Errore caricamento: ${e.message}</p></div></div>`;
    });
  }
}

// ── Init ─────────────────────────────────────────────
async function init() {
  const session = await getSession();
  if (session) {
    state.session = session;
    await loadUserData();
  } else {
    showAuth();
  }

  onAuthChange(async (s) => {
    state.session = s;
    if (s) { await loadUserData(); }
    else   { showAuth(); }
  });

  setupNavigation();
  setupAuth();
  setupOnboarding();

  // Registra service worker per PWA e notifiche push
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/nutri/sw.js', { scope: '/nutri/' })
      .then(reg => { console.log('[SW] registrato', reg.scope); })
      .catch(e => console.warn('[SW] errore:', e));
  }
}

let _loadInProgress = false;

async function loadUserData() {
  if (_loadInProgress) return;
  _loadInProgress = true;
  try {
    const uid = state.session.user.id;
    const [profile, recipes, excluded, weightLogs] = await Promise.all([
      getProfile(uid),
      getAllRecipes(),
      getExcludedIds(uid),
      getWeightLogs(uid),
    ]);

    state.profile    = profile;
    state.recipes    = recipes;
    state.excluded   = excluded;
    state.weightLogs = weightLogs;

    // Ratings: non-bloccante (tabella potrebbe non esistere ancora)
    try { state.ratings = await getRatings(uid); } catch (e) {
      console.warn('[loadUserData] getRatings failed (non-critical):', e);
      state.ratings = {};
    }

    if (!profile || !profile.onboarding_complete) {
      showOnboarding();
      return;
    }

    // Ricostruisce il piano dagli ID salvati
    const savedPlan = profile.current_plan;
    if (savedPlan && savedPlan.days) {
      state.plan = hydratePlan(savedPlan, recipes);

      // Migrazione formato legacy (solo UUID → ora { id, cal, macros })
      // Se i slot hanno calorie base (non scalate), ri-scala e risalva
      if (state.plan && profile.target_calories) {
        const needsMigration = state.plan.days.some(d =>
          Object.values(d.slots).some(r => r && !r._hydrated)
        );
        if (needsMigration) {
          const calSlots = caloriesBySlot(profile.target_calories, profile.meal_schedule);
          const slots    = activeSlots(profile.meal_schedule);
          for (const day of state.plan.days) {
            for (const slot of slots) {
              const r = day.slots[slot];
              if (r && !r._hydrated) {
                day.slots[slot] = scaleRecipeToTarget(r, calSlots[slot], profile.meal_schedule);
              }
            }
          }
          // Risalva il piano col nuovo formato
          savePlanCompact().catch(e => console.warn('[migration] savePlanCompact:', e));
        }
      }
    }

    if (!state.plan || !state.plan.days?.length) {
      // Nessun piano: genera da zero
      await generateAndSavePlan();
    } else {
      // Piano esistente: avanza la finestra se oggi è cambiato
      await rollPlanForward();
    }

    await loadConfirmedMeals();
    showApp();

    // Se notifiche attive, controlla pasti mancanti oggi
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      setTimeout(scheduleLocalReminders, 2000);
    }

  } catch (e) {
    console.error('[loadUserData]', e);
    toast('Errore caricamento dati: ' + (e.message || ''), 'error');
  } finally {
    _loadInProgress = false;
  }
}

/**
 * Avanza la finestra del piano al giorno corrente.
 * - Rimuove i giorni passati (< oggi)
 * - Aggiunge giorni nuovi in fondo per mantenere 7 giorni totali
 * - NON cancella le conferme dei giorni rimossi (rimangono nel calendario)
 * - NON azzera le conferme dei giorni futuri già confermati
 */
let _rollInProgress = false;

async function rollPlanForward() {
  if (!state.plan?.days?.length) return;
  if (_rollInProgress) return; // previene doppia esecuzione concorrente
  _rollInProgress = true;

  try {
    // Data locale (non UTC) — evita bug timezone (es. UTC+2 = 2h di sfasamento)
    const todayLocal = new Date();
    const today = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth()+1).padStart(2,'0')}-${String(todayLocal.getDate()).padStart(2,'0')}`;

    // Deduplicazione preventiva: rimuovi date duplicate già presenti in stato
    const seenDates = new Set();
    state.plan.days = state.plan.days.filter(d => {
      if (seenDates.has(d.date)) return false;
      seenDates.add(d.date);
      return true;
    });

    const planStart = state.plan.days[0].date;

    // Piano già aggiornato a oggi o futuro
    if (planStart >= today) return;

    // Tieni solo i giorni da oggi in poi
    const keptDays = state.plan.days.filter(d => d.date >= today);
    const daysNeeded = 7 - keptDays.length;

    if (daysNeeded === 0) {
      state.plan.days = keptDays;
      await savePlanCompact();
      return;
    }

    // Calcola la data di partenza per i nuovi giorni
    // Usa aritmetica locale per evitare bug DST/timezone
    const lastKeptDate = keptDays.length > 0
      ? keptDays[keptDays.length - 1].date
      : (() => {
          const d = new Date(todayLocal);
          d.setDate(d.getDate() - 1);
          return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        })();

    // Pool di ID già usati nella finestra mantenuta (evita ripetizioni immediate)
    const usedIds = new Set(
      keptDays.flatMap(d => Object.values(d.slots).filter(Boolean).map(r => r.id || r))
    );

    const slots    = activeSlots(state.profile.meal_schedule);
    const calSlots = caloriesBySlot(state.profile.target_calories, state.profile.meal_schedule);
    const newDays  = [];

    for (let i = 0; i < daysNeeded; i++) {
      // Aritmetica locale: parte da lastKeptDate e aggiunge (i+1) giorni
      const [ly, lm, ld] = lastKeptDate.split('-').map(Number);
      const d = new Date(ly, lm - 1, ld + (i + 1));
      const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

      const daySlots = {};
      for (const slot of slots) {
        const target     = calSlots[slot];
        const candidates = filterRecipes(state.recipes, state.profile, slot, state.excluded);
        const fresh      = candidates.filter(r => !usedIds.has(r.id));
        const pool       = fresh.length ? fresh : candidates;

        if (!pool.length) { daySlots[slot] = null; continue; }

        const sorted = [...pool].sort((a, b) =>
          Math.abs(a.calories - target) - Math.abs(b.calories - target)
        );
        const chosen = sorted.slice(0, Math.min(4, sorted.length))[
          Math.floor(Math.random() * Math.min(4, sorted.length))
        ];

        daySlots[slot] = scaleRecipeToTarget(chosen, target, state.profile.meal_schedule);
        usedIds.add(chosen.id);
      }

      newDays.push({ date, slots: daySlots });
    }

    state.plan.days = [...keptDays, ...newDays];
    await savePlanCompact();

  } finally {
    _rollInProgress = false;
  }
}

/**
 * Salva il piano su Supabase in formato compatto.
 * Salva ID + calories scalate + macros scalati per ogni slot,
 * così al ricaricamento le kcal mostrate sono quelle reali (non le base).
 */
async function savePlanCompact() {
  const planCompact = {
    generatedAt: state.plan.generatedAt || new Date().toISOString(),
    days: state.plan.days.map(d => ({
      date: d.date,
      slots: Object.fromEntries(
        Object.entries(d.slots).map(([slot, recipe]) => [
          slot,
          recipe ? {
            id:       recipe.id,
            cal:      recipe.calories,          // calorie scalate
            macros:   recipe.macros || null,    // macros scalati
          } : null
        ])
      )
    }))
  };
  await upsertProfile(state.session.user.id, {
    current_plan: planCompact,
    plan_generated_at: new Date().toISOString()
  });
}

/**
 * Ricostruisce il piano dagli ID salvati nel DB.
 * Ripristina le calorie scalate salvate nel piano (non quelle base del DB).
 */
function hydratePlan(compactPlan, recipes) {
  if (!compactPlan?.days?.length) return null;

  const recipeMap = {};
  for (const r of recipes) recipeMap[r.id] = r;

  const days = compactPlan.days.map(d => ({
    date: d.date,
    slots: Object.fromEntries(
      Object.entries(d.slots || {}).map(([slot, val]) => {
        if (!val) return [slot, null];

        // Formato nuovo: { id, cal, macros }
        if (typeof val === 'object' && val.id && val.cal) {
          const base = recipeMap[val.id];
          if (!base) return [slot, null];
          return [slot, {
            ...base,
            calories: val.cal,                        // usa calorie scalate
            macros:   val.macros || base.macros,      // usa macros scalati
            _hydrated: true,
          }];
        }
        // Formato stringa UUID (legacy)
        if (typeof val === 'string') return [slot, recipeMap[val] || null];
        // Formato oggetto completo (legacy vecchissimo)
        if (typeof val === 'object' && val.id) return [slot, recipeMap[val.id] || val];

        return [slot, null];
      })
    )
  }));

  const hasAnyRecipe = days.some(d => Object.values(d.slots).some(r => r !== null));
  if (!hasAnyRecipe) return null;

  return { days, generatedAt: compactPlan.generatedAt };
}

async function loadConfirmedMeals() {
  const uid = state.session.user.id;
  // Date locali (non UTC) per evitare sfasamento timezone
  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  const localDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const past = new Date(now); past.setDate(now.getDate() - 30);
  const fut  = new Date(now); fut.setDate(now.getDate() + 30);
  state.confirmedMeals = await getConfirmedMeals(uid, localDate(past), localDate(fut));
}

// ── Auth UI ───────────────────────────────────────────
function showAuth() {
  document.getElementById('auth-page').classList.remove('hidden');
  document.getElementById('app-wrapper').classList.add('hidden');
  document.getElementById('onboarding-wrapper').classList.add('hidden');
}

function showApp() {
  document.getElementById('auth-page').classList.add('hidden');
  document.getElementById('onboarding-wrapper').classList.add('hidden');
  document.getElementById('app-wrapper').classList.remove('hidden');
  showPage('piano');
}

function showOnboarding() {
  document.getElementById('auth-page').classList.add('hidden');
  document.getElementById('app-wrapper').classList.add('hidden');
  document.getElementById('onboarding-wrapper').classList.remove('hidden');
  startOnboarding();
}

function setupAuth() {
  // Tab switching
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.tab;
      document.getElementById('auth-login').classList.toggle('hidden', mode !== 'login');
      document.getElementById('auth-register').classList.toggle('hidden', mode !== 'register');
    });
  });

  // Login
  const doLogin = async () => {
    const email = document.getElementById('login-email').value.trim();
    const pass  = document.getElementById('login-pass').value;
    if (!email || !pass) return toast('Inserisci email e password', 'error');
    try {
      document.getElementById('btn-login').disabled = true;
      await signIn(email, pass);
    } catch (e) {
      toast(e.message || 'Credenziali errate', 'error');
    } finally {
      document.getElementById('btn-login').disabled = false;
    }
  };
  document.getElementById('btn-login').addEventListener('click', doLogin);
  document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('login-pass').addEventListener('keydown',  e => { if (e.key === 'Enter') doLogin(); });

  // Register
  const doRegister = async () => {
    const email = document.getElementById('reg-email').value.trim();
    const pass  = document.getElementById('reg-pass').value;
    if (!email || !pass) return toast('Inserisci email e password', 'error');
    if (pass.length < 6) return toast('Password minimo 6 caratteri', 'error');
    try {
      document.getElementById('btn-register').disabled = true;
      await signUp(email, pass);
      toast('Registrazione ok! Controlla la tua email per confermare.');
    } catch (e) {
      toast(e.message || 'Errore registrazione', 'error');
    } finally {
      document.getElementById('btn-register').disabled = false;
    }
  };
  document.getElementById('btn-register').addEventListener('click', doRegister);
  document.getElementById('reg-email').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
  document.getElementById('reg-pass').addEventListener('keydown',  e => { if (e.key === 'Enter') doRegister(); });

  // Guest
  document.getElementById('btn-guest').addEventListener('click', async () => {
    try {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
    } catch (e) {
      // Fallback: mostra app con dati demo
      state.profile = getDemoProfile();
      state.recipes = getDemoRecipes();
      state.plan = generateWeeklyPlan(state.recipes, state.profile, []);
      showApp();
    }
  });
}

function getDemoProfile() {
  return {
    id: 'guest', age: 30, sex: 'M', weight: 75, height: 175,
    activity_level: 'moderato', goal: 'mantenere', diet_type: 'standard',
    meal_schedule: 'standard', allergies: [], dislikes: [],
    bmr: 1785, tdee: 2765, target_calories: 2765, bmi: 24.5,
    onboarding_complete: true, current_plan: null
  };
}

function getDemoRecipes() { return []; }

// ── Onboarding ────────────────────────────────────────
let currentStep = 0;
const STEPS = 5;

function startOnboarding() {
  currentStep = 0;
  updateStepIndicator();
  showStep(0);
}

function setupOnboarding() {
  // Choice cards
  document.querySelectorAll('.choice-card').forEach(card => {
    card.addEventListener('click', () => {
      const group = card.dataset.group;
      document.querySelectorAll(`.choice-card[data-group="${group}"]`).forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });

  // Next / Prev buttons
  document.getElementById('btn-next')?.addEventListener('click', nextStep);
  document.getElementById('btn-prev')?.addEventListener('click', prevStep);

  // Tag inputs (allergies / dislikes)
  setupTagInput('allergies-input', 'allergies-tags');
  setupTagInput('dislikes-input', 'dislikes-tags');
}

function setupTagInput(inputId, tagsId) {
  const input = document.getElementById(inputId);
  const tagsEl = document.getElementById(tagsId);
  if (!input || !tagsEl) return;
  const tags = [];

  function renderTags() {
    tagsEl.innerHTML = tags.map((t,i) => `
      <span class="tag-pill">${t}<button data-i="${i}">×</button></span>
    `).join('');
    tagsEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => { tags.splice(+btn.dataset.i, 1); renderTags(); });
    });
  }

  input.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      const val = input.value.trim().replace(/,$/, '');
      if (val && !tags.includes(val)) tags.push(val);
      input.value = '';
      renderTags();
    }
  });

  input._getTags = () => tags;
}

function showStep(n) {
  document.querySelectorAll('.onboarding-step').forEach((s,i) => {
    s.classList.toggle('active', i === n);
  });
  const prevBtn = document.getElementById('btn-prev');
  if (prevBtn) prevBtn.style.visibility = n === 0 ? 'hidden' : 'visible';
  // Progress bar animata
  const fill = document.getElementById('ob-progress-fill');
  if (fill) fill.style.width = `${Math.round((n + 1) / STEPS * 100)}%`;
  updateStepIndicator();
  // Aggiorna anteprima kcal live se siamo all'ultimo step
  if (n === STEPS - 1) showOnboardingSummary();
}

function updateStepIndicator() {
  document.querySelectorAll('.step-dot').forEach((d,i) => {
    d.classList.toggle('active', i === currentStep);
    d.classList.toggle('done', i < currentStep);
  });
}

async function nextStep() {
  const btn = document.getElementById('btn-next');
  if (currentStep === STEPS - 1) {
    btn.textContent = 'Salvataggio...';
    btn.disabled = true;
    try {
      await saveOnboarding();
    } catch (e) {
      console.error('[nextStep] uncaught error:', e);
      toast('Errore: ' + (e.message || JSON.stringify(e)), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Inizia →';
    }
    return;
  }
  if (!validateStep(currentStep)) return;
  currentStep++;
  showStep(currentStep);
  if (currentStep === STEPS - 1) {
    document.getElementById('btn-next').textContent = 'Inizia →';
  }
  // Summary live: aggiorna ogni volta che si avanza verso l'ultimo step
  showOnboardingSummary();
}

function prevStep() {
  if (currentStep > 0) { currentStep--; showStep(currentStep); }
  document.getElementById('btn-next').textContent = 'Avanti →';
}

function validateStep(step) {
  if (step === 0) {
    const age = document.getElementById('ob-age')?.value;
    const peso = document.getElementById('ob-weight')?.value;
    const alt = document.getElementById('ob-height')?.value;
    if (!age || !peso || !alt || !document.querySelector('.choice-card[data-group="sex"].selected')) {
      toast('Compila tutti i campi', 'error'); return false;
    }
  }
  if (step === 2 && !document.querySelector('.choice-card[data-group="activity"].selected')) {
    toast('Seleziona il livello di attività', 'error'); return false;
  }
  if (step === 3 && !document.querySelector('.choice-card[data-group="goal"].selected')) {
    toast('Seleziona un obiettivo', 'error'); return false;
  }
  if (step === 4) {
    if (!document.querySelector('.choice-card[data-group="diet"].selected')) {
      toast('Seleziona il regime alimentare', 'error'); return false;
    }
    if (!document.querySelector('.choice-card[data-group="schedule"].selected')) {
      toast('Seleziona la distribuzione dei pasti', 'error'); return false;
    }
  }
  return true;
}

function showOnboardingSummary() {
  const age    = +document.getElementById('ob-age').value;
  const weight = +document.getElementById('ob-weight').value;
  const height = +document.getElementById('ob-height').value;
  const sex    = document.querySelector('.choice-card[data-group="sex"].selected')?.dataset.value;
  const act    = document.querySelector('.choice-card[data-group="activity"].selected')?.dataset.value;
  const goal   = document.querySelector('.choice-card[data-group="goal"].selected')?.dataset.value;

  const bmr  = calcBMR(weight, height, age, sex);
  const tdee = calcTDEE(bmr, act);
  const kcal = calcTargetCalories(tdee, goal);
  const bmi  = calcBMI(weight, height);
  const status = bmiStatus(bmi);

  const el = document.getElementById('ob-summary');
  if (el) el.innerHTML = `
    <div class="card mt-16">
      <div class="flex items-center justify-between" style="margin-bottom:12px">
        <div>
          <div style="font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);margin-bottom:4px">Il tuo fabbisogno</div>
          <div class="bold" style="font-size:2.2rem;color:var(--green-dark);line-height:1">${Math.round(kcal)} <span style="font-size:1rem;font-weight:400;color:var(--text-soft)">kcal/giorno</span></div>
          <div class="text-soft" style="font-size:0.82rem;margin-top:4px">BMR: ${Math.round(bmr)} kcal · TDEE: ${Math.round(tdee)} kcal</div>
        </div>
        <span class="bmi-pill ${status.cls}">${status.label} ${bmi.toFixed(1)}</span>
      </div>
      <div style="background:var(--green-pale);border-radius:8px;padding:10px 12px;margin-bottom:12px">
        <div style="font-size:0.8rem;font-weight:600;color:var(--green-dark);margin-bottom:6px">Distribuzione giornaliera</div>
        <div class="macro-bar">
          <span class="macro-chip p">Proteine ~25%</span>
          <span class="macro-chip c">Carboidrati ~50%</span>
          <span class="macro-chip f">Grassi ~25%</span>
        </div>
      </div>
      <p style="font-size:0.8rem;color:var(--text-soft)">
        🎯 Con questo fabbisogno genereremo un piano settimanale con ricette calibrate per te.
      </p>
    </div>
  `;
}

async function saveOnboarding() {
  const uid = state.session?.user?.id;
  if (!uid) {
    toast('Sessione scaduta. Rieffettua il login.', 'error');
    showAuth();
    return;
  }

  const age    = +document.getElementById('ob-age')?.value || 0;
  const weight = +document.getElementById('ob-weight')?.value || 0;
  const height = +document.getElementById('ob-height')?.value || 0;
  const sex    = document.querySelector('.choice-card[data-group="sex"].selected')?.dataset.value;
  const act    = document.querySelector('.choice-card[data-group="activity"].selected')?.dataset.value;
  const goal   = document.querySelector('.choice-card[data-group="goal"].selected')?.dataset.value;
  const diet   = document.querySelector('.choice-card[data-group="diet"].selected')?.dataset.value;
  const sched  = document.querySelector('.choice-card[data-group="schedule"].selected')?.dataset.value;

  if (!sex || !act || !goal || !diet || !sched) {
    toast('Compila tutte le sezioni prima di salvare', 'error');
    return;
  }

  const alginput = document.getElementById('allergies-input');
  const disinput = document.getElementById('dislikes-input');
  const allergies = alginput?._getTags?.() || [];
  const dislikes  = disinput?._getTags?.() || [];

  const bmr  = calcBMR(weight, height, age, sex);
  const tdee = calcTDEE(bmr, act);
  const kcal = calcTargetCalories(tdee, goal);
  const bmi  = calcBMI(weight, height);

  // 1. Salva profilo
  let profile;
  try {
    profile = await upsertProfile(uid, {
      age, weight, height, sex,
      activity_level: act, goal, diet_type: diet, meal_schedule: sched,
      allergies, dislikes,
      bmr: Math.round(bmr), tdee: Math.round(tdee),
      target_calories: Math.round(kcal), bmi: +bmi.toFixed(2),
      onboarding_complete: true
    });
  } catch (e) {
    console.error('[saveOnboarding] upsertProfile error:', e);
    toast('Errore salvataggio profilo: ' + (e.message || e.code || 'sconosciuto'), 'error');
    return;
  }

  // Usa il profilo restituito, o costruiscilo localmente se Supabase non lo ritorna
  state.profile = profile || {
    id: uid, age, weight, height, sex,
    activity_level: act, goal, diet_type: diet, meal_schedule: sched,
    allergies, dislikes,
    bmr: Math.round(bmr), tdee: Math.round(tdee),
    target_calories: Math.round(kcal), bmi: +bmi.toFixed(2),
    onboarding_complete: true
  };

  // 2. Registra peso iniziale (non bloccante)
  addWeightLog(uid, weight, 'Peso iniziale').catch(e =>
    console.warn('[saveOnboarding] addWeightLog failed (non-critical):', e)
  );

  // 3. Genera piano settimanale
  try {
    await generateAndSavePlan();
  } catch (e) {
    console.warn('[saveOnboarding] generateAndSavePlan failed, proceeding without plan:', e);
    // Non bloccare: l'utente arriva comunque all'app e il piano viene rigenereato al caricamento
  }

  toast('Profilo salvato! Benvenuto su Nutrì 🎉');
  showApp();
}

// ── Ricerca ricette nel piano ─────────────────────────
function renderSearchResults(dayIdx) {
  const q    = document.getElementById('recipe-search-input')?.value.toLowerCase().trim() || '';
  const slot = document.getElementById('recipe-slot-select')?.value || 'pranzo';
  const el   = document.getElementById('recipe-search-results');
  if (!el) return;

  const candidates = filterRecipes(state.recipes, state.profile, slot, state.excluded);
  const filtered   = q
    ? candidates.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.ingredients?.some(i => i.name.toLowerCase().includes(q)) ||
        r.tags?.some(t => t.toLowerCase().includes(q))
      )
    : candidates;

  if (!filtered.length) {
    el.innerHTML = `<p class="text-soft" style="text-align:center;padding:24px">Nessuna ricetta trovata</p>`;
    return;
  }

  const calSlots = caloriesBySlot(state.profile?.target_calories || 2000, state.profile?.meal_schedule || 'standard');
  const target   = calSlots[slot] || 500;

  el.innerHTML = filtered.slice(0, 20).map(r => `
    <div class="search-result-item" data-rid="${r.id}" data-slot="${slot}" data-day="${dayIdx}">
      ${r.image_url ? `<div class="search-thumb" style="background-image:url(${r.image_url})"></div>` : '<div class="search-thumb search-thumb-empty">🍽️</div>'}
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.name}</div>
        <div style="font-size:0.78rem;color:var(--text-soft);margin-top:2px">${r.calories} kcal base · target ${target} kcal</div>
        <div class="macro-bar" style="margin-top:4px">
          <span class="macro-chip p">P ${r.macros?.proteine || 0}g</span>
          <span class="macro-chip c">C ${r.macros?.carboidrati || 0}g</span>
          <span class="macro-chip f">G ${r.macros?.grassi || 0}g</span>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" style="flex-shrink:0" onclick="applyRecipeToSlot('${r.id}','${slot}',${dayIdx})">Usa</button>
    </div>
  `).join('');
}

window.applyRecipeToSlot = async function(recipeId, slot, dayIdx) {
  const recipe = state.recipes.find(r => r.id === recipeId);
  if (!recipe) return;

  const calSlots = caloriesBySlot(state.profile?.target_calories || 2000, state.profile?.meal_schedule || 'standard');
  const scaled   = scaleRecipeToTarget(recipe, calSlots[slot], state.profile?.meal_schedule || 'standard');

  state.plan.days[dayIdx].slots[slot] = scaled;
  await savePlanCompact();

  document.getElementById('search-recipe-overlay')?.classList.remove('open');
  renderPiano();
  toast(`"${recipe.name}" aggiunto al ${slot} ✓`);
};

// ── Smart Rigenera ────────────────────────────────────
// Rigenera solo i pasti NON confermati, lascia intatti i confermati
async function smartRegenerate() {
  if (!state.plan?.days?.length) { await generateAndSavePlan(); return; }

  const confirmedSet = new Set(
    state.confirmedMeals.map(cm => `${cm.plan_date}|${cm.meal_slot}`)
  );
  const slots    = activeSlots(state.profile.meal_schedule);
  const calSlots = caloriesBySlot(state.profile.target_calories, state.profile.meal_schedule);
  const usedIds  = new Set();

  // Raccogli ID già in uso (confermati) per evitare ripetizioni
  for (const day of state.plan.days) {
    for (const slot of slots) {
      const key = `${day.date}|${slot}`;
      if (confirmedSet.has(key) && day.slots[slot]?.id) {
        usedIds.add(day.slots[slot].id);
      }
    }
  }

  for (const day of state.plan.days) {
    for (const slot of slots) {
      const key = `${day.date}|${slot}`;
      if (confirmedSet.has(key)) continue; // confermato: non toccare

      const target     = calSlots[slot];
      const candidates = filterRecipes(state.recipes, state.profile, slot, state.excluded);
      const fresh      = candidates.filter(r => !usedIds.has(r.id));
      const pool       = fresh.length ? fresh : candidates;
      if (!pool.length) continue;

      const sorted = [...pool].sort((a, b) =>
        Math.abs(a.calories - target) - Math.abs(b.calories - target)
      );
      const chosen = sorted.slice(0, Math.min(4, sorted.length))[
        Math.floor(Math.random() * Math.min(4, sorted.length))
      ];
      day.slots[slot] = scaleRecipeToTarget(chosen, target, state.profile.meal_schedule);
      usedIds.add(chosen.id);
    }
  }

  await savePlanCompact();
}

// ── Dashboard Progressi ───────────────────────────────
async function renderDashboard() {
  const el  = document.getElementById('page-dashboard');
  const uid = state.session?.user?.id;
  if (!el) return;

  const now      = new Date();
  const pad      = n => String(n).padStart(2, '0');
  const localStr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const todayStr = localStr(now);

  // Carica confirmed meals (ultime 5 settimane)
  let confirmed = state.confirmedMeals;
  try {
    const past35 = new Date(now); past35.setDate(now.getDate() - 35);
    const fut7   = new Date(now); fut7.setDate(now.getDate() + 7);
    if (!confirmed.some(c => c.plan_date >= localStr(past35))) {
      confirmed = await getConfirmedMeals(uid, localStr(past35), localStr(fut7));
    }
  } catch(e) { console.warn('[dashboard] getConfirmedMeals:', e); }

  const slots = activeSlots(state.profile?.meal_schedule || 'standard');
  const target = Math.round(state.profile?.target_calories || 0);

  // ── Ultimi 7 giorni ──
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now); d.setDate(now.getDate() - (6 - i));
    return localStr(d);
  });

  // Streak: giorni consecutivi terminando da ieri con almeno 1 pasto confermato
  let streak = 0;
  for (let i = 0; i < 60; i++) {
    const d = new Date(now); d.setDate(now.getDate() - 1 - i);
    const ds = localStr(d);
    if (confirmed.some(c => c.plan_date === ds)) streak++;
    else break;
  }
  // Se oggi ha già pasti confermati, conta anche oggi
  if (confirmed.some(c => c.plan_date === todayStr)) streak++;

  // Aderenza ultimi 7gg
  const daysWithMeals = last7.filter(d => confirmed.some(c => c.plan_date === d)).length;
  const adherencePct  = Math.round((daysWithMeals / 7) * 100);

  // Kcal per giorno (ultimi 7)
  const kcalPerDay = last7.map(d => {
    const meals = confirmed.filter(c => c.plan_date === d);
    return meals.reduce((s, c) => s + (c.scaled_calories || c.recipes?.calories || 0), 0);
  });

  // Kcal media giornaliera (solo giorni con dati)
  const daysWithKcal  = kcalPerDay.filter(k => k > 0);
  const avgKcalDay    = daysWithKcal.length
    ? Math.round(daysWithKcal.reduce((s, k) => s + k, 0) / daysWithKcal.length)
    : 0;

  // Macro medi (settimana corrente)
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
  const weekMeals = confirmed.filter(c => c.plan_date >= localStr(weekStart) && c.plan_date <= todayStr);
  let totP = 0, totC = 0, totF = 0, mealCount = 0;
  for (const c of weekMeals) {
    const m = c.recipes?.macros; if (!m) continue;
    const sc = (c.scaled_calories && c.recipes?.calories) ? c.scaled_calories / c.recipes.calories : 1;
    totP += (m.proteine || 0) * sc; totC += (m.carboidrati || 0) * sc; totF += (m.grassi || 0) * sc;
    mealCount++;
  }
  const avgP = mealCount ? Math.round(totP / mealCount) : 0;
  const avgC = mealCount ? Math.round(totC / mealCount) : 0;
  const avgF = mealCount ? Math.round(totF / mealCount) : 0;

  // Peso
  const logs   = state.weightLogs;
  const firstW = logs[0]?.weight;
  const lastW  = logs[logs.length - 1]?.weight;
  const deltaW = (firstW && lastW && logs.length > 1) ? (lastW - firstW).toFixed(1) : null;

  // Rating
  const liked    = Object.values(state.ratings).filter(v => v ===  1).length;
  const disliked = Object.values(state.ratings).filter(v => v === -1).length;

  // ── Empty state ──
  const hasEnoughData = daysWithMeals >= 2;
  const emptyBanner   = hasEnoughData ? '' : `
    <div class="card mt-16" style="text-align:center;padding:28px 20px;border:2px dashed var(--border)">
      <div style="font-size:2.5rem;margin-bottom:10px">🥗</div>
      <h3 style="margin-bottom:6px">Inizia a confermare i pasti</h3>
      <p class="text-soft" style="font-size:0.875rem">Le statistiche si aggiornano man mano che confermi i tuoi pasti nel Piano. Ci vogliono almeno 2 giorni di dati.</p>
    </div>`;

  el.innerHTML = `
    <div id="main-content">
      <h2 style="margin-bottom:20px">Progressi</h2>
      ${emptyBanner}

      <!-- KPI -->
      <div class="progress-grid">
        <div class="progress-card">
          <div class="big-num">${avgKcalDay || '–'}</div>
          <div class="big-label">kcal media/giorno</div>
          <div class="sub-info">Target: ${target} kcal
            ${avgKcalDay && target ? `<br><strong style="color:${Math.abs(avgKcalDay-target)<150?'var(--green)':'var(--accent)'}">
              ${avgKcalDay > target ? '+' : ''}${avgKcalDay - target} kcal</strong>` : ''}
          </div>
        </div>
        <div class="progress-card">
          <div class="big-num${streak > 0 ? ' streak-num' : ''}">${streak > 0 ? '🔥' : '–'} ${streak > 0 ? streak : ''}</div>
          <div class="big-label">Streak giorni</div>
          <div class="sub-info">${streak > 0 ? `${streak} giorno/i consecutiv${streak===1?'o':'i'}` : 'Nessuno streak attivo'}</div>
        </div>
        <div class="progress-card">
          <div class="big-num">${adherencePct}%</div>
          <div class="big-label">Aderenza 7 giorni</div>
          <div class="adherence-bar-wrap" style="margin:8px 0 4px">
            <div class="adherence-bar-fill" style="width:${adherencePct}%"></div>
          </div>
          <div class="sub-info">${daysWithMeals}/7 giorni</div>
        </div>
        <div class="progress-card">
          <div class="big-num" style="${deltaW !== null ? `color:${+deltaW <= 0 ? 'var(--green-dark)' : 'var(--accent)'}` : ''}">
            ${deltaW !== null ? `${+deltaW > 0 ? '+' : ''}${deltaW} kg` : '–'}
          </div>
          <div class="big-label">Variazione peso</div>
          <div class="sub-info">${logs.length > 1 ? `${firstW} → ${lastW} kg` : 'Registra il peso nel profilo'}</div>
        </div>
      </div>

      <!-- Grafico kcal a barre -->
      <div class="card mt-16">
        <h3 style="margin-bottom:16px">Kcal ultimi 7 giorni</h3>
        <canvas id="kcal-bar-chart" height="140"></canvas>
        <div style="display:flex;justify-content:flex-end;margin-top:6px;gap:16px;font-size:0.72rem;color:var(--text-soft)">
          <span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:3px;background:var(--green);display:inline-block"></span> Kcal consumate</span>
          <span style="display:flex;align-items:center;gap:4px"><span style="width:16px;height:2px;background:#aaa;display:inline-block;border-top:2px dashed #aaa"></span> Target</span>
        </div>
      </div>

      <!-- Macro medi -->
      ${mealCount > 0 ? `
      <div class="card mt-16">
        <h3 style="margin-bottom:12px">Macro medi a pasto — questa settimana</h3>
        <div class="macro-donut-row">
          <div class="macro-donut-item p"><div class="val" style="color:#C2410C">${avgP}g</div><div class="lbl">Proteine</div></div>
          <div class="macro-donut-item c"><div class="val" style="color:#15803D">${avgC}g</div><div class="lbl">Carboidrati</div></div>
          <div class="macro-donut-item f"><div class="val" style="color:#1D4ED8">${avgF}g</div><div class="lbl">Grassi</div></div>
        </div>
      </div>` : ''}

      <!-- Peso -->
      ${logs.length >= 2 ? `
      <div class="card mt-16">
        <h3 style="margin-bottom:12px">Andamento peso</h3>
        <canvas id="dash-weight-chart" class="weight-chart"></canvas>
      </div>` : ''}

      <!-- Rating ricette -->
      <div class="card mt-16">
        <h3 style="margin-bottom:8px">Le tue preferenze</h3>
        <div style="display:flex;gap:12px">
          <div style="flex:1;text-align:center;padding:12px;background:var(--green-pale);border-radius:10px">
            <div style="font-size:1.6rem">👍</div>
            <div style="font-size:1.4rem;font-weight:700;color:var(--green-dark)">${liked}</div>
            <div style="font-size:0.75rem;color:var(--text-soft)">piaciute</div>
          </div>
          <div style="flex:1;text-align:center;padding:12px;background:#FFF1F2;border-radius:10px">
            <div style="font-size:1.6rem">👎</div>
            <div style="font-size:1.4rem;font-weight:700;color:#BE123C">${disliked}</div>
            <div style="font-size:0.75rem;color:var(--text-soft)">non piaciute</div>
          </div>
        </div>
      </div>

      <!-- Notifiche -->
      <div class="card mt-16">
        <div class="flex items-center justify-between">
          <div>
            <h3>Notifiche pasti</h3>
            <p style="font-size:0.82rem;margin-top:4px">Promemoria giornaliero per confermare i pasti.</p>
          </div>
          <button class="btn btn-secondary btn-sm" id="btn-enable-notif">🔔 Attiva</button>
        </div>
        <p id="notif-status" style="font-size:0.78rem;color:var(--text-soft);margin-top:8px"></p>
      </div>

    </div>`;

  // ── Grafico a barre kcal ──
  setTimeout(() => {
    const canvas = document.getElementById('kcal-bar-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W   = canvas.parentElement.offsetWidth - 32;
    const H   = 140;
    canvas.width = W; canvas.height = H;
    const pad2   = 36;
    const barW   = Math.floor((W - pad2 * 2) / 7) - 4;
    const maxVal = Math.max(target * 1.15, ...kcalPerDay, 100);

    ctx.clearRect(0, 0, W, H);

    // Griglia orizzontale
    ctx.strokeStyle = 'rgba(128,128,128,0.12)'; ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach(f => {
      const y = H - 24 - (H - 40) * f;
      ctx.beginPath(); ctx.moveTo(pad2, y); ctx.lineTo(W - 8, y); ctx.stroke();
    });

    // Linea target tratteggiata
    if (target > 0) {
      const ty = H - 24 - (H - 40) * (target / maxVal);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(128,128,128,0.5)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(pad2, ty); ctx.lineTo(W - 8, ty); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Barre + etichette
    last7.forEach((dateStr, i) => {
      const x    = pad2 + i * ((W - pad2 * 2) / 7) + 2;
      const kcal = kcalPerDay[i];
      const barH = kcal > 0 ? Math.max(4, Math.round((H - 40) * (kcal / maxVal))) : 0;
      const y    = H - 24 - barH;

      // Barra
      if (kcal > 0) {
        const pct = kcal / target;
        ctx.fillStyle = pct >= 0.9 && pct <= 1.12 ? '#1D9E75'
          : pct < 0.9  ? '#5DCAA5'
          : '#FF7043';
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
        ctx.fill();

        // Valore sopra la barra
        if (barH > 14) {
          ctx.fillStyle = '#666'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(kcal >= 1000 ? `${(kcal/1000).toFixed(1)}k` : kcal, x + barW/2, y - 3);
        }
      }

      // Etichetta giorno
      const d   = new Date(dateStr + 'T12:00:00');
      const dow = d.toLocaleDateString('it-IT', { weekday: 'narrow' });
      const dom = d.getDate();
      ctx.fillStyle = dateStr === todayStr ? '#1D9E75' : 'rgba(128,128,128,0.7)';
      ctx.font = `${dateStr === todayStr ? '700' : '400'} 9px Inter,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`${dow} ${dom}`, x + barW/2, H - 8);
    });

    // Asse Y labels
    ctx.fillStyle = 'rgba(128,128,128,0.6)'; ctx.font = '8px Inter,sans-serif'; ctx.textAlign = 'right';
    [0.5, 1].forEach(f => {
      const y   = H - 24 - (H - 40) * f;
      const val = Math.round(maxVal * f);
      ctx.fillText(val >= 1000 ? `${(val/1000).toFixed(1)}k` : val, pad2 - 2, y + 3);
    });
  }, 80);

  // Grafico peso
  if (logs.length >= 2) setTimeout(() => renderWeightChart('dash-weight-chart'), 100);

  // Notifiche
  const btn = document.getElementById('btn-enable-notif');
  const statusEl = document.getElementById('notif-status');
  updateNotifButton(btn, statusEl);
  btn?.addEventListener('click', () => requestNotificationPermission(btn, statusEl));
}
async function generateAndSavePlan() {
  if (!state.recipes.length) {
    try { state.recipes = await getAllRecipes(); } catch {}
  }
  const plan = generateWeeklyPlan(state.recipes, state.profile, state.excluded, state.ratings);
  state.plan = plan;

  await savePlanCompact();

  // Rigenerazione manuale: svuota le conferme della nuova finestra
  // (i pasti sono cambiati, vanno riconfermati)
  try {
    const uid  = state.session.user.id;
    const from = plan.days[0]?.date;
    const to   = plan.days[plan.days.length - 1]?.date;
    if (from && to) {
      await supabase
        .from('confirmed_meals')
        .delete()
        .eq('user_id', uid)
        .gte('plan_date', from)
        .lte('plan_date', to);
      state.confirmedMeals = state.confirmedMeals.filter(
        cm => cm.plan_date < from || cm.plan_date > to
      );
    }
  } catch (e) {
    console.warn('[generateAndSavePlan] clear confirmed failed:', e);
  }
}

// ── Render Piano ──────────────────────────────────────
function renderPiano() {
  const el = document.getElementById('page-piano');
  if (!state.plan || !state.plan.days) {
    el.innerHTML = `<div id="main-content">
      <div class="empty-state">
        <img src="assets/empty-plan.svg" alt="">
        <h3>Piano non ancora generato</h3>
        <p>Completa il tuo profilo per generare il piano alimentare personalizzato.</p>
      </div>
    </div>`;
    return;
  }

  const slots = activeSlots(state.profile?.meal_schedule || 'standard');
  const confirmedMap = {};
  for (const cm of state.confirmedMeals) {
    confirmedMap[`${cm.plan_date}|${cm.meal_slot}`] = cm.recipe_id;
  }

  // Clamp index
  const maxIdx = state.plan.days.length - 1;
  if (state.currentDayIndex > maxIdx) state.currentDayIndex = 0;
  const dayIdx = state.currentDayIndex;
  const day    = state.plan.days[dayIdx];

  // ── Day tabs ──
  const tabsHtml = state.plan.days.map((d, i) => {
    const dateObj = new Date(d.date + 'T12:00:00');
    const dow = dateObj.toLocaleDateString('it-IT', { weekday: 'short' });
    const dom = dateObj.getDate();
    const isToday = i === 0;
    const hasAll  = slots.every(s => !!confirmedMap[`${d.date}|${s}`]);
    return `<button class="day-tab${i === dayIdx ? ' active' : ''}" data-i="${i}">
      <span class="day-tab-dow">${dow}</span>
      <span class="day-tab-dom">${dom}</span>
      ${hasAll ? '<span class="day-tab-dot confirmed"></span>' : ''}
    </button>`;
  }).join('');

  // ── Totale kcal giorno ──
  const totalKcal = slots.reduce((s, slot) => s + (day.slots[slot]?.calories || 0), 0);

  // ── Meal cards ──
  let mealsHtml = '';
  for (const slot of slots) {
    const recipe = day.slots[slot];
    if (!recipe) continue;
    const isConfirmed = !!confirmedMap[`${day.date}|${slot}`];
    const p = recipe.macros?.proteine    || 0;
    const c = recipe.macros?.carboidrati || 0;
    const f = recipe.macros?.grassi      || 0;
    const ratingVal = state.ratings[recipe.id] || 0;
    const imgSrc = recipe.image_url || '';

    mealsHtml += `
      <div class="meal-card${isConfirmed ? ' confirmed' : ''}" data-day="${dayIdx}" data-slot="${slot}">
        <div class="meal-card-inner">
          ${imgSrc ? `<div class="meal-thumb" style="background-image:url(${imgSrc})"></div>` : `<div class="meal-thumb meal-thumb-empty"><svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M18 8h1a4 4 0 010 8h-1M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8zM6 1v3M10 1v3M14 1v3"/></svg></div>`}
          <div class="meal-card-body">
            <div class="meal-card-header">
              <span class="meal-slot-badge slot-${slot}">${slot}</span>
              ${isConfirmed ? '<span class="confirmed-badge">✓ Confermato</span>' : ''}
              <button class="meal-menu-btn" data-day="${dayIdx}" data-slot="${slot}" title="Opzioni">⋮</button>
            </div>
            <div class="meal-card-name">${recipe.name}</div>
            <div class="meal-card-kcal">${recipe.calories} <span>kcal</span></div>
            <div class="macro-bar">
              <span class="macro-chip p">Proteine ${p}g</span>
              <span class="macro-chip c">Carboidrati ${c}g</span>
              <span class="macro-chip f">Grassi ${f}g</span>
            </div>
          </div>
        </div>
        <div class="meal-card-actions">
          <button class="meal-action-pill btn-replace${isConfirmed?' disabled':''}" data-day="${dayIdx}" data-slot="${slot}" ${isConfirmed?'disabled':''}>
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
            Sostituisci
          </button>
          <button class="meal-action-pill btn-confirm${isConfirmed?' active':''}" data-day="${dayIdx}" data-slot="${slot}">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            ${isConfirmed ? 'Confermato' : 'Conferma'}
          </button>
        </div>
        <div class="meal-dropdown hidden" data-day="${dayIdx}" data-slot="${slot}">
          <button class="meal-dd-item btn-details" data-day="${dayIdx}" data-slot="${slot}">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Dettagli ricetta
          </button>
          <div class="meal-dd-divider"></div>
          <button class="meal-dd-item rating-btn like${ratingVal===1?' active':''}" data-rid="${recipe.id}" data-val="1">
            👍 Mi piace
          </button>
          <button class="meal-dd-item rating-btn dislike${ratingVal===-1?' active':''}" data-rid="${recipe.id}" data-val="-1">
            👎 Non mi piace
          </button>
          <div class="meal-dd-divider"></div>
          <button class="meal-dd-item btn-exclude danger${isConfirmed?' disabled':''}" data-day="${dayIdx}" data-slot="${slot}" ${isConfirmed?'disabled':''}>
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Elimina dai suggerimenti
          </button>
        </div>
      </div>`;
  }

  el.innerHTML = `
    <div id="main-content" class="piano-main">
      <div class="piano-header">
        <div class="piano-header-row">
          <h2>Il tuo Piano</h2>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" id="btn-print-plan" title="Stampa">🖨</button>
            <button class="btn btn-ghost btn-sm" id="btn-search-recipe" title="Cerca ricetta">🔍</button>
            <button class="btn btn-secondary btn-sm" id="btn-regen">↻ Rigenera liberi</button>
          </div>
        </div>
        <div class="day-tabs-wrap">
          <div class="day-tabs">${tabsHtml}</div>
        </div>
      </div>

      <div class="piano-day-view" id="piano-day-view">
        <div class="piano-day-nav">
          <button class="day-nav-btn" id="btn-prev-day" ${dayIdx === 0 ? 'disabled' : ''}>‹</button>
          <div class="piano-day-title">
            <strong>${new Date(day.date + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
            <span class="day-kcal-badge">${totalKcal} kcal</span>
          </div>
          <button class="day-nav-btn" id="btn-next-day" ${dayIdx === maxIdx ? 'disabled' : ''}>›</button>
        </div>
        <div class="meals-list">${mealsHtml}</div>
      </div>
    </div>

    <!-- Search recipe modal -->
    <div id="search-recipe-overlay" class="modal-overlay">
      <div class="modal-sheet" style="max-width:560px">
        <button id="search-recipe-close" style="position:absolute;right:16px;top:14px;background:none;border:none;font-size:1.4rem;cursor:pointer;color:#aaa">×</button>
        <div class="modal-handle"></div>
        <h3 style="margin-bottom:14px">Cerca una ricetta</h3>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input type="text" id="recipe-search-input" placeholder="Es: pollo, pasta, zucchine..." style="flex:1">
          <select id="recipe-slot-select" style="width:130px">
            ${slots.map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
        <div id="recipe-search-results" style="max-height:340px;overflow-y:auto"></div>
      </div>
    </div>`;

  // ── Events ──
  // Tabs giorno
  el.querySelectorAll('.day-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.currentDayIndex = +tab.dataset.i;
      renderPiano();
    });
  });

  // Nav prev/next con direzione per animazione
  el.querySelector('#btn-prev-day')?.addEventListener('click', () => {
    if (state.currentDayIndex > 0) { state._swipeDir = 'left'; state.currentDayIndex--; renderPiano(); }
  });
  el.querySelector('#btn-next-day')?.addEventListener('click', () => {
    if (state.currentDayIndex < maxIdx) { state._swipeDir = 'right'; state.currentDayIndex++; renderPiano(); }
  });

  // Applica classe animazione al contenuto del giorno
  const dayView = el.querySelector('#piano-day-view');
  if (dayView && state._swipeDir) {
    dayView.classList.add(state._swipeDir === 'right' ? 'slide-in-right' : 'slide-in-left');
    state._swipeDir = null;
  }

  // Swipe touch con direzione per animazione
  let touchStartX = 0;
  const view = el.querySelector('#piano-day-view');
  view?.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  view?.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) < 50) return;
    if (dx < 0 && state.currentDayIndex < maxIdx) {
      state._swipeDir = 'right'; state.currentDayIndex++; renderPiano();
    }
    if (dx > 0 && state.currentDayIndex > 0) {
      state._swipeDir = 'left'; state.currentDayIndex--; renderPiano();
    }
  }, { passive: true });

  // Rigenera
  el.querySelector('#btn-regen')?.addEventListener('click', async () => {
    toast('Rigenerazione pasti liberi...', 'info');
    await smartRegenerate();
    renderPiano();
  });
  el.querySelector('#btn-print-plan')?.addEventListener('click', () => window.print());

  // Search recipe
  el.querySelector('#btn-search-recipe')?.addEventListener('click', () => {
    document.getElementById('search-recipe-overlay')?.classList.add('open');
    document.getElementById('recipe-search-input')?.focus();
  });
  document.getElementById('search-recipe-close')?.addEventListener('click', () => {
    document.getElementById('search-recipe-overlay')?.classList.remove('open');
  });
  document.getElementById('search-recipe-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });
  const searchInput = document.getElementById('recipe-search-input');
  searchInput?.addEventListener('input', () => renderSearchResults(dayIdx));
  document.getElementById('recipe-slot-select')?.addEventListener('change', () => renderSearchResults(dayIdx));

  // Click card → apre modal (ma non se clicchi sul menu o dentro il dropdown)
  el.querySelectorAll('.meal-card-inner').forEach(inner => {
    inner.addEventListener('click', e => {
      if (e.target.closest('.meal-menu-btn')) return;
      const card = inner.closest('.meal-card');
      openRecipeModal(+card.dataset.day, card.dataset.slot);
    });
  });

  // Menu ⋮
  el.querySelectorAll('.meal-menu-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const slot = btn.dataset.slot;
      const d    = btn.dataset.day;
      // Chiudi tutti gli altri dropdown aperti
      el.querySelectorAll('.meal-dropdown').forEach(dd => {
        if (dd.dataset.slot !== slot || dd.dataset.day !== d) dd.classList.add('hidden');
      });
      const dd = el.querySelector(`.meal-dropdown[data-day="${d}"][data-slot="${slot}"]`);
      dd?.classList.toggle('hidden');
    });
  });

  // Chiudi dropdown cliccando fuori
  document.addEventListener('click', closeAllDropdowns, { once: false });
  function closeAllDropdowns(e) {
    if (!e.target.closest('.meal-menu-btn') && !e.target.closest('.meal-dropdown')) {
      el.querySelectorAll('.meal-dropdown').forEach(dd => dd.classList.add('hidden'));
    }
  }

  // Azioni nel dropdown
  el.querySelectorAll('.btn-details').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); closeDropdowns(); openRecipeModal(+btn.dataset.day, btn.dataset.slot); });
  });
  el.querySelectorAll('.btn-replace').forEach(btn => {
    btn.addEventListener('click', async e => { e.stopPropagation(); closeDropdowns(); if (!btn.disabled) await handleReplace(+btn.dataset.day, btn.dataset.slot); });
  });
  el.querySelectorAll('.btn-confirm').forEach(btn => {
    btn.addEventListener('click', async e => { e.stopPropagation(); closeDropdowns(); await handleConfirm(+btn.dataset.day, btn.dataset.slot); });
  });
  el.querySelectorAll('.btn-exclude').forEach(btn => {
    btn.addEventListener('click', async e => { e.stopPropagation(); closeDropdowns(); if (!btn.disabled) await handleExclude(+btn.dataset.day, btn.dataset.slot); });
  });
  el.querySelectorAll('.rating-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const rid = btn.dataset.rid;
      const val = +btn.dataset.val;
      const newVal = (state.ratings[rid] || 0) === val ? 0 : val;
      state.ratings[rid] = newVal;
      await setRating(state.session.user.id, rid, newVal).catch(console.warn);
      closeDropdowns();
      renderPiano();
    });
  });

  function closeDropdowns() {
    el.querySelectorAll('.meal-dropdown').forEach(dd => dd.classList.add('hidden'));
  }
}


async function handleReplace(dayIdx, slot) {
  const day     = state.plan.days[dayIdx];
  const current = day.slots[slot];
  if (!current) return;

  // Chiave per giorno+slot (non globale per slot, altrimenti si esaurisce tra i 7 giorni)
  const key = `${dayIdx}_${slot}`;
  if (!state.rejectedPerSlot[key]) state.rejectedPerSlot[key] = [];
  state.rejectedPerSlot[key].push(current.id);

  let next = replaceRecipe(
    state.recipes, state.profile, slot,
    state.plan, dayIdx,
    state.rejectedPerSlot[key],
    state.excluded, state.ratings
  );

  // Pool esaurito: azzera i rifiutati e ricomincia il giro
  if (!next) {
    state.rejectedPerSlot[key] = [current.id]; // mantieni solo l'attuale per non riproporre subito
    next = replaceRecipe(
      state.recipes, state.profile, slot,
      state.plan, dayIdx,
      state.rejectedPerSlot[key],
      state.excluded, state.ratings
    );
  }

  if (!next) { toast('Nessuna ricetta disponibile per questo slot', 'info'); return; }

  state.plan.days[dayIdx].slots[slot] = next;
  await upsertProfile(state.session.user.id, { current_plan: state.plan });
  renderPiano();
  toast('Ricetta sostituita!');
}

async function handleConfirm(dayIdx, slot) {
  const day    = state.plan.days[dayIdx];
  const recipe = day.slots[slot];
  if (!recipe) return;
  const uid            = state.session.user.id;
  const alreadyConfirmed = state.confirmedMeals.find(
    cm => cm.plan_date === day.date && cm.meal_slot === slot
  );

  if (alreadyConfirmed) {
    await unconfirmMeal(uid, day.date, slot);
    state.confirmedMeals = state.confirmedMeals.filter(
      cm => !(cm.plan_date === day.date && cm.meal_slot === slot)
    );
    toast('Conferma rimossa');
  } else {
    // Salva anche le kcal scalate così il calendario le mostra correttamente
    const scaledKcal = recipe.calories || null;
    const cm = await confirmMeal(uid, day.date, slot, recipe.id, scaledKcal);
    // Arricchisci con i dati della ricetta scalata per uso locale (calendario)
    cm.recipes         = recipe;
    cm.scaled_calories = scaledKcal;
    state.confirmedMeals.push(cm);
    toast('Pasto confermato ✓');
  }
  renderPiano();
}

async function handleExclude(dayIdx, slot) {
  const day = state.plan.days[dayIdx];
  const recipe = day.slots[slot];
  if (!recipe) return;
  if (!confirm(`Eliminare "${recipe.name}" dai tuoi suggerimenti?`)) return;

  await excludeRecipe(state.session.user.id, recipe.id);
  state.excluded.push(recipe.id);

  // Sostituisci subito
  await handleReplace(dayIdx, slot);
  toast('Ricetta eliminata');
}

// ── Modal Ricetta ─────────────────────────────────────
function openRecipeModal(dayIdx, slot) {
  const recipe = state.plan?.days?.[dayIdx]?.slots?.[slot];
  if (!recipe) return;

  const overlay = document.getElementById('modal-overlay');
  const body    = document.getElementById('modal-body');

  const ingredients = recipe.ingredients?.map(i =>
    `<div class="ingredient-item">${i.name}: <strong>${i.amount}${i.unit || ''}</strong></div>`
  ).join('') || '';

  const instructions = recipe.instructions?.map((step, i) => `
    <div class="instruction-step">
      <div class="step-num">${i+1}</div>
      <div class="step-text">${step}</div>
    </div>
  `).join('') || '';

  const status = bmiStatus(state.profile?.bmi || 22);

  body.innerHTML = `
    <div class="modal-handle"></div>
    ${recipe.image_url ? `<img class="modal-recipe-img" src="${recipe.image_url}" alt="${recipe.name}" loading="lazy">` : ''}
    <h2 style="margin-bottom:6px">${recipe.name}</h2>
    <p style="margin-bottom:16px">${recipe.description || ''}</p>

    <div class="flex gap-12" style="flex-wrap:wrap;margin-bottom:20px">
      <div class="stat-box" style="flex:1;min-width:80px"><div class="stat-value">${recipe.calories}</div><div class="stat-label">kcal</div></div>
      <div class="stat-box" style="flex:1;min-width:80px"><div class="stat-value">${recipe.macros?.proteine || 0}g</div><div class="stat-label">Proteine</div></div>
      <div class="stat-box" style="flex:1;min-width:80px"><div class="stat-value">${recipe.macros?.carboidrati || 0}g</div><div class="stat-label">Carbo</div></div>
      <div class="stat-box" style="flex:1;min-width:80px"><div class="stat-value">${recipe.macros?.grassi || 0}g</div><div class="stat-label">Grassi</div></div>
      ${recipe.prep_time ? `<div class="stat-box" style="flex:1;min-width:80px"><div class="stat-value">${recipe.prep_time}'</div><div class="stat-label">Preparazione</div></div>` : ''}
    </div>

    <h3 style="margin-bottom:10px">Ingredienti</h3>
    <div class="ingredient-list" style="margin-bottom:20px">${ingredients}</div>

    <h3 style="margin-bottom:10px">Preparazione</h3>
    <div style="margin-bottom:20px">${instructions}</div>

    ${recipe.source_url ? `<a href="${recipe.source_url}" target="_blank" rel="noopener" class="btn btn-secondary w-full" style="justify-content:center">Ricetta originale ↗</a>` : ''}
  `;

  overlay.classList.add('open');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
});

function closeModal() {
  document.getElementById('modal-overlay')?.classList.remove('open');
}

// ── Render Calendario ─────────────────────────────────
// Tiene traccia del mese visualizzato tra le chiamate
let calendarYear  = null;
let calendarMonth = null;

async function renderCalendar(yearOverride, monthOverride) {
  const el  = document.getElementById('page-calendario');
  const now = new Date();

  // Prima chiamata: usa mese corrente; successive: usa quello passato
  if (yearOverride !== undefined) {
    calendarYear  = yearOverride;
    calendarMonth = monthOverride;
  } else if (calendarYear === null) {
    calendarYear  = now.getFullYear();
    calendarMonth = now.getMonth();
  }

  const year  = calendarYear;
  const month = calendarMonth;

  // Date mese: usa aritmetica locale (non toISOString che converte in UTC)
  const pad = n => String(n).padStart(2, '0');
  const firstDay = `${year}-${pad(month + 1)}-01`;
  const lastDayNum = new Date(year, month + 1, 0).getDate(); // giorni nel mese
  const lastDay  = `${year}-${pad(month + 1)}-${pad(lastDayNum)}`;
  let confirmed = [];
  try {
    confirmed = await getConfirmedMeals(state.session?.user?.id || 'x', firstDay, lastDay);
  } catch {}

  const confirmedDates = new Set(confirmed.map(c => c.plan_date));
  const monthName = new Date(year, month, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });

  const firstDow   = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = (firstDow + 6) % 7; // Lunedì = 0
  const todayD  = new Date();
  const todayStr = `${todayD.getFullYear()}-${pad(todayD.getMonth()+1)}-${pad(todayD.getDate())}`;

  // Calcola mese precedente e successivo
  const prevYear  = month === 0  ? year - 1 : year;
  const prevMonth = month === 0  ? 11        : month - 1;
  const nextYear  = month === 11 ? year + 1 : year;
  const nextMonth = month === 11 ? 0         : month + 1;

  const days = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
  let grid = days.map(d => `<div class="cal-header">${d}</div>`).join('');
  for (let i = 0; i < startOffset; i++) grid += `<div class="cal-day empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === todayStr;
    const hasData = confirmedDates.has(dateStr);
    grid += `<div class="cal-day${isToday ? ' today' : ''}${hasData ? ' has-data' : ''}" data-date="${dateStr}">${d}</div>`;
  }

  el.innerHTML = `
    <div id="main-content">
      <div class="flex items-center justify-between" style="margin-bottom:20px">
        <button class="btn btn-ghost btn-sm" id="cal-prev" style="font-size:1.1rem">‹</button>
        <h2 style="text-transform:capitalize;flex:1;text-align:center">${monthName}</h2>
        <button class="btn btn-ghost btn-sm" id="cal-next" style="font-size:1.1rem">›</button>
      </div>
      <div class="card">
        <div class="calendar-grid">${grid}</div>
      </div>
      <div id="cal-day-detail" class="mt-16"></div>
    </div>`;

  // Navigazione mesi
  el.querySelector('#cal-prev').addEventListener('click', () => renderCalendar(prevYear, prevMonth));
  el.querySelector('#cal-next').addEventListener('click', () => renderCalendar(nextYear, nextMonth));

  // Click su giorno
  el.querySelectorAll('.cal-day:not(.empty)').forEach(cell => {
    cell.addEventListener('click', () => showDayDetail(cell.dataset.date, confirmed));
  });
}

function showDayDetail(date, confirmed) {
  const dayMeals = confirmed.filter(c => c.plan_date === date);
  const el = document.getElementById('cal-day-detail');
  if (!dayMeals.length) {
    el.innerHTML = `
      <div class="empty-state" style="padding:24px 16px">
        <img src="assets/empty-calendar.svg" alt="" style="width:90px">
        <p class="text-soft">Nessun pasto confermato per <strong>${formatDateShort(date)}</strong></p>
      </div>`;
    return;
  }
  const label = formatDate(date);
  const totalKcal = dayMeals.reduce((s, m) => s + (m.scaled_calories || m.recipes?.calories || 0), 0);

  let html = `
    <div class="flex items-center justify-between" style="margin-bottom:12px">
      <h3>${label}</h3>
      <span class="day-total-kcal">${totalKcal} kcal totali</span>
    </div>`;

  for (const m of dayMeals) {
    const r    = m.recipes;
    const kcal = m.scaled_calories || r?.calories || '–';
    if (!r) continue;
    html += `
      <div class="meal-row" style="cursor:default">
        <div class="meal-row-top">
          <span class="meal-slot-badge slot-${m.meal_slot}">${m.meal_slot}</span>
          <div class="meal-info">
            <div class="meal-name">${r.name}</div>
            <div class="meal-kcal">${kcal} <span>kcal</span></div>
          </div>
        </div>
      </div>`;
  }
  el.innerHTML = html;
}

// ── Render Spesa ──────────────────────────────────────
function renderSpesa() {
  const el = document.getElementById('page-spesa');
  if (!state.plan || !state.plan.days) {
    el.innerHTML = `<div id="main-content"><p class="text-soft">Piano non disponibile.</p></div>`;
    return;
  }

  const days = state.plan.days;

  // Quanti pasti confermati per ogni giorno (per mostrare badge)
  const confirmedByDate = {};
  for (const cm of state.confirmedMeals) {
    confirmedByDate[cm.plan_date] = (confirmedByDate[cm.plan_date] || 0) + 1;
  }

  const dayBtns = days.map((d, i) => {
    const count = confirmedByDate[d.date] || 0;
    const badge = count > 0 ? `<span style="font-size:0.7rem;background:var(--green);color:#fff;border-radius:50%;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;margin-left:4px">${count}</span>` : '';
    return `<button class="day-toggle${state.selectedShoppingDays.includes(i) ? ' selected' : ''}" data-day="${i}">
      ${formatDateShort(d.date)}${badge}
    </button>`;
  }).join('');

  el.innerHTML = `
    <div id="main-content">
      <h2 style="margin-bottom:6px">Lista della Spesa</h2>
      <p class="text-soft" style="margin-bottom:4px">Seleziona i giorni per cui fare la spesa.</p>
      <p class="text-soft" style="margin-bottom:16px;font-size:0.82rem">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="vertical-align:-1px"><polyline points="20 6 9 17 4 12"/></svg>
        La lista include solo i pasti che hai confermato — il numero verde indica quanti pasti confermati ha ogni giorno.
      </p>
      <div class="shopping-day-selector">${dayBtns}</div>
      <button class="btn btn-primary w-full" id="btn-gen-shopping" style="margin-bottom:24px">Genera lista della spesa</button>
      <div id="shopping-list"></div>
    </div>`;

  el.querySelectorAll('.day-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = +btn.dataset.day;
      if (state.selectedShoppingDays.includes(idx)) {
        state.selectedShoppingDays = state.selectedShoppingDays.filter(d => d !== idx);
        btn.classList.remove('selected');
      } else {
        state.selectedShoppingDays.push(idx);
        btn.classList.add('selected');
      }
    });
  });

  el.querySelector('#btn-gen-shopping').addEventListener('click', () => {
    if (!state.selectedShoppingDays.length) { toast('Seleziona almeno un giorno', 'error'); return; }

    // Calcola le date selezionate
    const selectedDates = state.selectedShoppingDays.map(i => days[i]?.date).filter(Boolean);

    // Filtra i pasti confermati per quelle date
    const confirmedForDays = state.confirmedMeals.filter(cm => selectedDates.includes(cm.plan_date));

    if (!confirmedForDays.length) {
      toast('Nessun pasto confermato nei giorni selezionati', 'info');
      document.getElementById('shopping-list').innerHTML = `
        <div class="empty-state">
          <img src="assets/empty-shopping.svg" alt="">
          <h3>Nessun pasto confermato</h3>
          <p>Vai nel Piano, conferma i pasti che vuoi cucinare, poi torna qui a generare la lista.</p>
        </div>`;
      return;
    }

    // Risolve le ricette dagli ID confermati
    const recipeMap = {};
    for (const r of state.recipes) recipeMap[r.id] = r;

    const confirmedRecipes = confirmedForDays
      .map(cm => recipeMap[cm.recipe_id])
      .filter(Boolean);

    const list = buildShoppingListFromRecipes(confirmedRecipes);
    const totalConfirmed = confirmedForDays.length;
    renderShoppingList(list, totalConfirmed);
  });
}

/**
 * Aggrega ingredienti da un array di ricette già risolte
 */
function buildShoppingListFromRecipes(recipes) {
  const raw = {};

  for (const recipe of recipes) {
    if (!recipe?.ingredients) continue;
    for (const ing of recipe.ingredients) {
      const key = `${ing.name.toLowerCase()}||${ing.unit || ''}`;
      if (raw[key]) {
        raw[key].amount += ing.amount || 0;
      } else {
        raw[key] = { name: ing.name, unit: ing.unit || '', amount: ing.amount || 0 };
      }
    }
  }

  const CATS = {
    'Carne e Pesce':    ['pollo','manzo','vitello','tacchino','macinato','coniglio','salmone','tonno','orata','branzino','merluzzo','sgombro','alici','acciughe','gamberetti','trancio'],
    'Verdure e Ortaggi':['zucchine','carote','spinaci','broccoli','pomodori','peperoni','cipolla','aglio','sedano','melanzane','asparagi','lattuga','rucola','cetriolo','patate','zucca','cipollotto','fagiolini'],
    'Frutta':           ['mela','banana','fragole','mirtilli','limone','lime','avocado','arancia','pera','kiwi','albicocche'],
    'Latticini e Uova': ['yogurt','ricotta','parmigiano','feta','grana','latte','uova','uovo','albume','formaggio','kefir','mozzarella','burro'],
    'Pasta e Cereali':  ['pasta','spaghetti','fusilli','penne','riso','farro','orzo','cous','quinoa','avena','gallette','pane','fette biscottate'],
    'Legumi':           ['ceci','fagioli','lenticchie','piselli','soia','fave','edamame','tofu'],
    'Dispensa':         ['olio','sale','pepe','curry','curcuma','cannella','zenzero','rosmarino','basilico','timo','origano','prezzemolo','paprika','cumino','miele','confettura','aceto','capperi','olive','tahini'],
    'Frutta secca':     ['mandorle','noci','nocciole','pistacchi','anacardi','pinoli','semi'],
  };

  const categorized = {};
  for (const item of Object.values(raw)) {
    let cat = 'Altro';
    const nameLow = item.name.toLowerCase();
    for (const [c, keywords] of Object.entries(CATS)) {
      if (keywords.some(k => nameLow.includes(k))) { cat = c; break; }
    }
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(item);
  }

  // Ordina gli ingredienti alfabeticamente dentro ogni categoria
  for (const cat of Object.keys(categorized)) {
    categorized[cat].sort((a, b) => a.name.localeCompare(b.name, 'it'));
  }

  return categorized;
}

function renderShoppingList(list, confirmedCount = 0) {
  const el = document.getElementById('shopping-list');
  const catOrder = ['Carne e Pesce','Verdure e Ortaggi','Frutta','Latticini e Uova','Pasta e Cereali','Legumi','Dispensa','Frutta secca','Altro'];

  const totalItems = Object.values(list).reduce((s, arr) => s + arr.length, 0);

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div>
        <h3 style="margin-bottom:2px">Lista generata</h3>
        <p style="font-size:0.78rem;color:var(--text-soft)">${confirmedCount} pasto/i confermati · ${totalItems} ingredienti</p>
      </div>
      <button class="btn btn-ghost btn-sm" id="btn-print">🖨 Stampa</button>
    </div>`;

  for (const cat of catOrder) {
    if (!list[cat]?.length) continue;
    html += `<div class="shopping-category"><h4>${cat}</h4>`;
    for (const item of list[cat]) {
      const key = `${item.name}||${item.unit}`;
      const checked = !!state.shoppingChecked[key];
      const amtDisplay = item.unit === 'pz' ? `${item.amount} pz` :
                         item.unit === 'pizzico' ? `q.b.` :
                         `${item.amount}${item.unit}`;
      html += `
        <div class="shopping-item${checked ? ' checked' : ''}" data-key="${key}">
          <div class="check-box${checked ? ' checked' : ''}">${checked ? '✓' : ''}</div>
          <span class="item-name">${item.name}</span>
          <span class="item-amount">${amtDisplay}</span>
        </div>`;
    }
    html += `</div>`;
  }

  el.innerHTML = html;

  el.querySelectorAll('.shopping-item').forEach(row => {
    row.addEventListener('click', () => {
      const key = row.dataset.key;
      state.shoppingChecked[key] = !state.shoppingChecked[key];
      renderShoppingList(list); // re-render with updated state
    });
  });

  document.getElementById('btn-print')?.addEventListener('click', () => window.print());
}

// ── Render Profilo ────────────────────────────────────
function renderProfilo() {
  const p = state.profile;
  if (!p) return;
  const el = document.getElementById('page-profilo');
  const status = bmiStatus(p.bmi || 22);

  const ACTIVITY_LABELS = { sedentario:'Sedentario', leggero:'Leggero', moderato:'Moderato', attivo:'Attivo', atleta:'Atleta' };
  const GOAL_LABELS     = { dimagrire:'Perdere peso', mantenere:'Mantenere', aumentare:'Aumentare massa' };
  const DIET_LABELS     = { standard:'Onnivoro', vegetariana:'Vegetariano', vegana:'Vegano' };
  const SCHED_LABELS    = { standard:'3 pasti + spuntino', intermittente_colazione:'Digiuno 16:8 (mattina)', intermittente_pranzo:'Digiuno 16:8 (pomeriggio)' };

  const logsHtml = state.weightLogs.length
    ? state.weightLogs.slice(-5).reverse().map(l => `
        <div class="weight-log-entry">
          <span>${new Date(l.logged_at).toLocaleDateString('it-IT')}</span>
          <strong class="text-green">${l.weight} kg</strong>
        </div>`).join('')
    : '<p class="text-soft" style="font-size:0.85rem">Nessun peso registrato</p>';

  el.innerHTML = `
    <div id="main-content">
      <h2 style="margin-bottom:20px">Profilo</h2>

      <!-- Card calorie -->
      <div class="bmr-card">
        <h3>Calorie giornaliere</h3>
        <div class="kcal">${Math.round(p.target_calories || 0)}</div>
        <p>Metabolismo basale: ${Math.round(p.bmr || 0)} kcal · TDEE: ${Math.round(p.tdee || 0)} kcal</p>
        <p style="margin-top:4px">Obiettivo: <strong>${GOAL_LABELS[p.goal] || p.goal || '–'}</strong> · Attività: <strong>${ACTIVITY_LABELS[p.activity_level] || p.activity_level || '–'}</strong></p>
      </div>

      <!-- Stats -->
      <div class="profile-stat-grid">
        <div class="stat-box"><div class="stat-value">${p.weight || '–'} kg</div><div class="stat-label">Peso</div></div>
        <div class="stat-box"><div class="stat-value">${p.height || '–'} cm</div><div class="stat-label">Altezza</div></div>
        <div class="stat-box"><div class="stat-value">${(p.bmi || 0).toFixed(1)}</div><div class="stat-label">BMI <span class="bmi-pill ${status.cls}">${status.label}</span></div></div>
        <div class="stat-box"><div class="stat-value">${p.age || '–'}</div><div class="stat-label">Età</div></div>
      </div>

      <!-- Peso nel tempo -->
      <div class="card mt-16">
        <div class="flex items-center justify-between" style="margin-bottom:14px">
          <h3>Andamento peso</h3>
          <button class="btn btn-secondary btn-sm" id="btn-add-weight">+ Registra peso</button>
        </div>
        <canvas id="weight-chart" class="weight-chart"></canvas>
        <div id="weight-logs-list" style="margin-top:12px">${logsHtml}</div>
      </div>

      <!-- Impostazioni dieta (sola lettura) -->
      <div class="card mt-16">
        <div class="flex items-center justify-between" style="margin-bottom:14px">
          <h3>Impostazioni dieta</h3>
          <button class="btn btn-primary btn-sm" id="btn-edit-profile">✏ Modifica</button>
        </div>
        <div class="profile-stat-grid">
          <div class="stat-box"><div class="stat-value" style="font-size:0.9rem">${DIET_LABELS[p.diet_type] || p.diet_type || '–'}</div><div class="stat-label">Regime</div></div>
          <div class="stat-box"><div class="stat-value" style="font-size:0.8rem">${SCHED_LABELS[p.meal_schedule] || p.meal_schedule || '–'}</div><div class="stat-label">Pasti</div></div>
        </div>
        ${(p.allergies?.length || p.dislikes?.length) ? `
          <div style="margin-top:12px;font-size:0.875rem;display:flex;flex-direction:column;gap:4px">
            ${p.allergies?.length ? `<div><strong>Allergie:</strong> ${p.allergies.join(', ')}</div>` : ''}
            ${p.dislikes?.length  ? `<div><strong>Non graditi:</strong> ${p.dislikes.join(', ')}</div>` : ''}
          </div>` : ''}
      </div>

      <button class="btn btn-ghost w-full mt-16" id="btn-logout" style="color:#BE123C">Esci dall'account</button>
    </div>

    <!-- ── Modal modifica profilo ── -->
    <div id="edit-profile-overlay" class="modal-overlay">
      <div class="modal-sheet" style="max-width:560px">
        <button id="edit-profile-close" style="position:absolute;right:20px;top:16px;background:none;border:none;font-size:1.5rem;cursor:pointer;color:#aaa;line-height:1">×</button>
        <div class="modal-handle"></div>
        <h2 style="margin-bottom:20px">Modifica profilo</h2>

        <div style="display:flex;flex-direction:column;gap:18px">

          <!-- Dati fisici -->
          <div class="card card-sm" style="background:#f8fffe">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--green-dark);margin-bottom:12px">Dati fisici</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
              <div class="input-group">
                <label>Età</label>
                <input type="number" id="ep-age" value="${p.age || ''}" min="10" max="100">
              </div>
              <div class="input-group">
                <label>Peso (kg)</label>
                <input type="number" id="ep-weight" value="${p.weight || ''}" step="0.1" min="30" max="300">
              </div>
              <div class="input-group">
                <label>Altezza (cm)</label>
                <input type="number" id="ep-height" value="${p.height || ''}" min="100" max="250">
              </div>
            </div>
            <div class="input-group" style="margin-top:12px">
              <label>Sesso biologico</label>
              <div style="display:flex;gap:8px">
                <label class="ep-radio-btn${p.sex === 'M' ? ' selected' : ''}" data-group="ep-sex" data-value="M">♂ Uomo</label>
                <label class="ep-radio-btn${p.sex === 'F' ? ' selected' : ''}" data-group="ep-sex" data-value="F">♀ Donna</label>
              </div>
            </div>
          </div>

          <!-- Stile di vita -->
          <div class="card card-sm" style="background:#f8fffe">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--green-dark);margin-bottom:12px">Stile di vita</div>
            <div class="input-group">
              <label>Livello di attività</label>
              <div style="display:flex;flex-direction:column;gap:6px" id="ep-activity-group">
                ${[['sedentario','🪑 Sedentario','Lavoro d\'ufficio, poca attività'],['leggero','🚶 Leggero','1-2 allenamenti/settimana'],['moderato','🚴 Moderato','3-4 allenamenti/settimana'],['attivo','🏃 Attivo','5+ allenamenti/settimana'],['atleta','🏋️ Atleta','Allenamento intenso quotidiano']].map(([val, label, sub]) => `
                  <label class="ep-radio-btn ep-radio-row${p.activity_level === val ? ' selected' : ''}" data-group="ep-activity" data-value="${val}">
                    <span style="font-weight:600">${label}</span><span style="font-size:0.75rem;color:#888;margin-left:auto">${sub}</span>
                  </label>`).join('')}
              </div>
            </div>
          </div>

          <!-- Obiettivo -->
          <div class="card card-sm" style="background:#f8fffe">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--green-dark);margin-bottom:12px">Obiettivo</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${[['dimagrire','⚖️ Perdere peso'],['mantenere','⚡ Mantenere'],['aumentare','💪 Aumentare massa']].map(([val, label]) => `
                <label class="ep-radio-btn${p.goal === val ? ' selected' : ''}" data-group="ep-goal" data-value="${val}">${label}</label>`).join('')}
            </div>
          </div>

          <!-- Regime e pasti -->
          <div class="card card-sm" style="background:#f8fffe">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--green-dark);margin-bottom:12px">Dieta e pasti</div>
            <div class="input-group" style="margin-bottom:12px">
              <label>Regime alimentare</label>
              <div style="display:flex;gap:8px">
                ${[['standard','🍖 Onnivoro'],['vegetariana','🥗 Vegetariano'],['vegana','🌱 Vegano']].map(([val, label]) => `
                  <label class="ep-radio-btn${p.diet_type === val ? ' selected' : ''}" data-group="ep-diet" data-value="${val}">${label}</label>`).join('')}
              </div>
            </div>
            <div class="input-group">
              <label>Distribuzione pasti</label>
              <div style="display:flex;flex-direction:column;gap:6px">
                ${[['standard','3 pasti + spuntino','Colazione · Spuntino · Pranzo · Cena'],['intermittente_colazione','Digiuno 16:8 mattina','Colazione · Spuntino · Pranzo'],['intermittente_pranzo','Digiuno 16:8 pomeriggio','Pranzo · Cena']].map(([val, label, sub]) => `
                  <label class="ep-radio-btn ep-radio-row${p.meal_schedule === val ? ' selected' : ''}" data-group="ep-schedule" data-value="${val}">
                    <span style="font-weight:600">${label}</span><span style="font-size:0.75rem;color:#888;margin-left:auto">${sub}</span>
                  </label>`).join('')}
              </div>
            </div>
          </div>

          <!-- Allergie e dislikes -->
          <div class="card card-sm" style="background:#f8fffe">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--green-dark);margin-bottom:12px">Allergie e preferenze</div>
            <div class="input-group" style="margin-bottom:12px">
              <label>Allergie / intolleranze</label>
              <div class="tag-input-wrap">
                <div class="tags-list" id="ep-allergies-tags"></div>
                <input type="text" id="ep-allergies-input" placeholder="premi Enter dopo ogni voce">
              </div>
            </div>
            <div class="input-group">
              <label>Cibi non graditi</label>
              <div class="tag-input-wrap">
                <div class="tags-list" id="ep-dislikes-tags"></div>
                <input type="text" id="ep-dislikes-input" placeholder="premi Enter dopo ogni voce">
              </div>
            </div>
          </div>

          <button class="btn btn-primary w-full" id="btn-save-profile" style="padding:14px">Salva modifiche</button>
        </div>
      </div>
    </div>`;

  renderWeightChart();

  // Inizializza tag inputs con valori esistenti
  setupEditTagInput('ep-allergies-input', 'ep-allergies-tags', p.allergies || []);
  setupEditTagInput('ep-dislikes-input',  'ep-dislikes-tags',  p.dislikes  || []);

  // Radio buttons stile
  document.querySelectorAll('.ep-radio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group;
      document.querySelectorAll(`.ep-radio-btn[data-group="${group}"]`).forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  // Apri/chiudi modal
  document.getElementById('btn-edit-profile').addEventListener('click', () => {
    document.getElementById('edit-profile-overlay').classList.add('open');
  });
  document.getElementById('edit-profile-close').addEventListener('click', () => {
    document.getElementById('edit-profile-overlay').classList.remove('open');
  });
  document.getElementById('edit-profile-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });

  // Salva
  document.getElementById('btn-save-profile').addEventListener('click', saveProfileEdit);

  document.getElementById('btn-add-weight')?.addEventListener('click', promptWeightEntry);
  document.getElementById('btn-logout')?.addEventListener('click', async () => { await signOut(); });
}

function setupEditTagInput(inputId, tagsId, initialTags = []) {
  const input = document.getElementById(inputId);
  const tagsEl = document.getElementById(tagsId);
  if (!input || !tagsEl) return;
  const tags = [...initialTags];

  function renderTags() {
    tagsEl.innerHTML = tags.map((t, i) =>
      `<span class="tag-pill">${t}<button data-i="${i}">×</button></span>`
    ).join('');
    tagsEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => { tags.splice(+btn.dataset.i, 1); renderTags(); });
    });
  }

  input.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      const val = input.value.trim().replace(/,$/, '');
      if (val && !tags.includes(val)) tags.push(val);
      input.value = '';
      renderTags();
    }
  });

  input._getTags = () => tags;
  renderTags();
}

async function saveProfileEdit() {
  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true;
  btn.textContent = 'Salvataggio...';

  try {
    const uid = state.session?.user?.id;
    if (!uid) throw new Error('Sessione scaduta, rieffettua il login');

    const age    = +document.getElementById('ep-age')?.value || 0;
    const weight = +document.getElementById('ep-weight')?.value || 0;
    const height = +document.getElementById('ep-height')?.value || 0;
    const sex      = document.querySelector('.ep-radio-btn[data-group="ep-sex"].selected')?.dataset.value;
    const act      = document.querySelector('.ep-radio-btn[data-group="ep-activity"].selected')?.dataset.value;
    const goal     = document.querySelector('.ep-radio-btn[data-group="ep-goal"].selected')?.dataset.value;
    const diet     = document.querySelector('.ep-radio-btn[data-group="ep-diet"].selected')?.dataset.value;
    const sched    = document.querySelector('.ep-radio-btn[data-group="ep-schedule"].selected')?.dataset.value;
    const allergies = document.getElementById('ep-allergies-input')?._getTags?.() || [];
    const dislikes  = document.getElementById('ep-dislikes-input')?._getTags?.()  || [];

    if (!age || !weight || !height || !sex || !act || !goal || !diet || !sched) {
      throw new Error('Compila tutti i campi obbligatori');
    }

    const bmr  = calcBMR(weight, height, age, sex);
    const tdee = calcTDEE(bmr, act);
    const kcal = calcTargetCalories(tdee, goal);
    const bmi  = calcBMI(weight, height);

    const updated = await upsertProfile(uid, {
      age, weight, height, sex,
      activity_level: act, goal, diet_type: diet, meal_schedule: sched,
      allergies, dislikes,
      bmr: Math.round(bmr), tdee: Math.round(tdee),
      target_calories: Math.round(kcal), bmi: +bmi.toFixed(2),
    });

    state.profile = updated || { ...state.profile, age, weight, height, sex, activity_level: act, goal, diet_type: diet, meal_schedule: sched, allergies, dislikes, bmr: Math.round(bmr), tdee: Math.round(tdee), target_calories: Math.round(kcal), bmi: +bmi.toFixed(2) };

    // Rigenera il piano con le nuove preferenze
    state.rejectedPerSlot = {};
    await generateAndSavePlan();

    document.getElementById('edit-profile-overlay').classList.remove('open');
    toast('Profilo aggiornato! Piano ricalcolato ✓');
    renderProfilo();

  } catch (e) {
    console.error('[saveProfileEdit]', e);
    toast(e.message || 'Errore durante il salvataggio', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salva modifiche';
  }
}

function promptWeightEntry() {
  const val = prompt('Inserisci il peso attuale (kg):');
  if (!val || isNaN(parseFloat(val))) return;
  const weight = parseFloat(val);
  addWeightLog(state.session.user.id, weight).then(log => {
    state.weightLogs.push(log);
    upsertProfile(state.session.user.id, { weight });
    state.profile.weight = weight;
    renderProfilo();
    toast('Peso registrato!');
  });
}

// ── Notifiche PWA ─────────────────────────────────────
function updateNotifButton(btn, statusEl) {
  if (!btn) return;
  if (!('Notification' in window)) {
    btn.textContent = '🔕 Non supportate'; btn.disabled = true; return;
  }
  if (Notification.permission === 'granted') {
    btn.textContent = '✓ Attive'; btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Le notifiche sono attive.';
  } else if (Notification.permission === 'denied') {
    btn.textContent = '🚫 Bloccate'; btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Hai bloccato le notifiche. Abilitale dalle impostazioni del browser.';
  } else {
    btn.textContent = '🔔 Attiva notifiche'; btn.disabled = false;
  }
}

async function requestNotificationPermission(btn, statusEl) {
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      // Mostra subito una notifica di test
      reg.showNotification('Nutrì 🌿', {
        body: 'Notifiche attivate! Ti ricorderemo di confermare i pasti.',
        icon: '/nutri/assets/icon-192.png',
        tag: 'nutri-test',
      });
      // Salva subscription se Push API disponibile
      if ('PushManager' in window) {
        // VAPID key pubblica — per ora usa notification semplici (senza server push)
        // Per push server-side serve una backend function
      }
      toast('Notifiche attivate! ✓');
      // Pianifica reminder locale tramite Notification
      scheduleLocalReminders();
    } catch (e) { console.warn('Notif error:', e); }
  }
  updateNotifButton(btn, statusEl);
}

function scheduleLocalReminders() {
  // Usa un approccio semplice: all'apertura dell'app mostra reminder
  // se ci sono pasti del giorno non confermati
  const now    = new Date();
  const pad    = n => String(n).padStart(2, '0');
  const today  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const slots  = activeSlots(state.profile?.meal_schedule || 'standard');

  if (!state.plan?.days) return;
  const todayPlan = state.plan.days.find(d => d.date === today);
  if (!todayPlan) return;

  const confirmedToday = state.confirmedMeals.filter(c => c.plan_date === today).map(c => c.meal_slot);
  const missing = slots.filter(s => !confirmedToday.includes(s));
  if (missing.length > 0 && Notification.permission === 'granted') {
    new Notification('Nutrì 🌿', {
      body: `Hai ancora ${missing.length} pasto/i da confermare oggi: ${missing.join(', ')}.`,
      icon: '/nutri/assets/icon-192.png',
      tag: 'nutri-daily',
    });
  }
}

// ── Weight chart ──────────────────────────────────────
function renderWeightChart(canvasId = 'weight-chart') {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !state.weightLogs.length) return;

  const labels = state.weightLogs.map(l => new Date(l.logged_at).toLocaleDateString('it-IT', { day:'numeric', month:'short' }));
  const data   = state.weightLogs.map(l => l.weight);

  // Mini canvas chart (no external lib needed for simple line)
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 320;
  const H = 140;
  canvas.width = W; canvas.height = H;

  const min = Math.min(...data) - 1;
  const max = Math.max(...data) + 1;
  const xStep = (W - 60) / Math.max(data.length - 1, 1);

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#e8f8f2'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = 20 + (H - 40) * i / 4;
    ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(W - 10, y); ctx.stroke();
  }

  // Line
  ctx.beginPath();
  ctx.strokeStyle = '#1D9E75'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  data.forEach((v, i) => {
    const x = 40 + i * xStep;
    const y = 20 + (H - 40) * (1 - (v - min) / (max - min));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Dots & labels
  data.forEach((v, i) => {
    const x = 40 + i * xStep;
    const y = 20 + (H - 40) * (1 - (v - min) / (max - min));
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#1D9E75'; ctx.fill();
    if (i === 0 || i === data.length - 1 || data.length <= 6) {
      ctx.fillStyle = '#0F6E56'; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`${v}kg`, x, y - 8);
    }
  });
}

// ── Navigation ────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => showPage(item.dataset.page));
  });
}

// ── Boot ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
