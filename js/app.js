// ── Nutrì — app.js ──────────────────────────────────
import {
  supabase, signUp, signIn, signOut, getSession, onAuthChange,
  getProfile, upsertProfile, getAllRecipes,
  getExcludedIds, excludeRecipe,
  getConfirmedMeals, confirmMeal, unconfirmMeal,
  getWeightLogs, addWeightLog, deleteWeightLog
} from './supabase.js';

import {
  calcBMR, calcTDEE, calcTargetCalories, calcBMI, bmiStatus,
  caloriesBySlot, activeSlots, generateWeeklyPlan, replaceRecipe,
  buildShoppingList, formatDate, formatDateShort
} from './nutrition.js';

// ── State ─────────────────────────────────────────────
const state = {
  session: null,
  profile: null,
  recipes: [],
  plan: null,
  excluded: [],
  rejectedPerSlot: {}, // { 'colazione': [id,...], ... }
  confirmedMeals: [],
  weightLogs: [],
  shoppingChecked: {},
  selectedShoppingDays: [],
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
  if (name === 'calendario') renderCalendar();
  if (name === 'spesa')      renderSpesa();
  if (name === 'profilo')    renderProfilo();
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
}

async function loadUserData() {
  try {
    const uid = state.session.user.id;
    const [profile, recipes, excluded, weightLogs] = await Promise.all([
      getProfile(uid),
      getAllRecipes(),
      getExcludedIds(uid),
      getWeightLogs(uid),
    ]);

    state.profile  = profile;
    state.recipes  = recipes;
    state.excluded = excluded;
    state.weightLogs = weightLogs;

    if (!profile || !profile.onboarding_complete) {
      showOnboarding();
    } else {
      showApp();

      // Ricostruisce il piano dagli ID (formato compatto) oppure genera nuovo
      const savedPlan = profile.current_plan;
      if (savedPlan && savedPlan.days) {
        state.plan = hydratePlan(savedPlan, recipes);
      }
      if (!state.plan) await generateAndSavePlan();

      await loadConfirmedMeals();
    }
  } catch (e) {
    console.error('[loadUserData]', e);
    toast('Errore caricamento dati: ' + (e.message || ''), 'error');
  }
}

/**
 * Ricostruisce il piano completo dagli ID salvati nel DB
 */
function hydratePlan(compactPlan, recipes) {
  const recipeMap = {};
  for (const r of recipes) recipeMap[r.id] = r;

  // Supporta sia il formato vecchio (oggetti completi) che quello nuovo (solo ID)
  const days = compactPlan.days.map(d => ({
    date: d.date,
    slots: Object.fromEntries(
      Object.entries(d.slots).map(([slot, val]) => {
        if (!val) return [slot, null];
        // Formato nuovo: val è una stringa UUID
        if (typeof val === 'string') return [slot, recipeMap[val] || null];
        // Formato vecchio: val è già un oggetto ricetta (retrocompatibilità)
        if (typeof val === 'object' && val.id) return [slot, recipeMap[val.id] || val];
        return [slot, null];
      })
    )
  }));

  return { days, generatedAt: compactPlan.generatedAt };
}

async function loadConfirmedMeals() {
  const uid = state.session.user.id;
  const from = new Date().toISOString().split('T')[0];
  const to = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  state.confirmedMeals = await getConfirmedMeals(uid, from, to);
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
  document.getElementById('btn-login').addEventListener('click', async () => {
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
  });

  // Register
  document.getElementById('btn-register').addEventListener('click', async () => {
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
  });

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
  updateStepIndicator();
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
    showOnboardingSummary();
  }
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
      <div class="flex items-center justify-between mb-16">
        <div>
          <div class="bold" style="font-size:2rem">${Math.round(kcal)} <span style="font-size:1rem;font-weight:400">kcal/giorno</span></div>
          <div class="text-soft" style="font-size:0.85rem">Metabolismo basale: ${Math.round(bmr)} kcal · BMI: ${bmi.toFixed(1)}</div>
        </div>
        <span class="bmi-pill ${status.cls}">${status.label}</span>
      </div>
      <div class="macro-bar">
        <span class="macro-chip p">Proteine ~25%</span>
        <span class="macro-chip c">Carboidrati ~50%</span>
        <span class="macro-chip f">Grassi ~25%</span>
      </div>
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

// ── Piano generazione ─────────────────────────────────
async function generateAndSavePlan() {
  if (!state.recipes.length) {
    try { state.recipes = await getAllRecipes(); } catch {}
  }
  const plan = generateWeeklyPlan(state.recipes, state.profile, state.excluded);
  state.plan = plan;

  // Salva su Supabase solo gli ID (payload minimo), non gli oggetti completi
  const planCompact = {
    generatedAt: plan.generatedAt,
    days: plan.days.map(d => ({
      date: d.date,
      slots: Object.fromEntries(
        Object.entries(d.slots).map(([slot, recipe]) => [slot, recipe?.id || null])
      )
    }))
  };

  await upsertProfile(state.session.user.id, {
    current_plan: planCompact,
    plan_generated_at: new Date().toISOString()
  });
}

// ── Render Piano ──────────────────────────────────────
function renderPiano() {
  const el = document.getElementById('page-piano');
  if (!state.plan || !state.plan.days) {
    el.innerHTML = `<div id="main-content"><div class="loading-wrap"><div class="spinner"></div><p>Generazione piano...</p></div></div>`;
    return;
  }

  const slots = activeSlots(state.profile?.meal_schedule || 'standard');

  const confirmedMap = {};
  for (const cm of state.confirmedMeals) {
    confirmedMap[`${cm.plan_date}|${cm.meal_slot}`] = cm.recipe_id;
  }

  let html = `<div id="main-content">
    <div class="week-header">
      <h2>Il tuo Piano</h2>
      <button class="btn btn-secondary btn-sm" id="btn-regen">↻ Rigenera settimana</button>
    </div>`;

  for (let d = 0; d < state.plan.days.length; d++) {
    const day = state.plan.days[d];
    const label = formatDate(day.date);

    // Calcola totale kcal giornaliero
    const totalKcal = slots.reduce((sum, slot) => {
      return sum + (day.slots[slot]?.calories || 0);
    }, 0);

    html += `
      <div class="day-card">
        <div class="day-card-header">
          <span class="day-label">${label}</span>
          <span class="day-total-kcal">${totalKcal} kcal totali</span>
        </div>
        <div class="day-meals-list">`;

    for (const slot of slots) {
      const recipe = day.slots[slot];
      if (!recipe) continue;
      const isConfirmed = !!confirmedMap[`${day.date}|${slot}`];
      const p = recipe.macros?.proteine    || 0;
      const c = recipe.macros?.carboidrati || 0;
      const f = recipe.macros?.grassi      || 0;

      html += `
        <div class="meal-row${isConfirmed ? ' confirmed' : ''}" data-day="${d}" data-slot="${slot}">
          <div>
            <span class="meal-slot-badge slot-${slot}">${slot}</span>
          </div>
          <div class="meal-info">
            <div class="meal-name">${recipe.name}</div>
            <div class="meal-kcal">${recipe.calories} <span>kcal</span></div>
            <div class="macro-bar">
              <span class="macro-chip p">Proteine ${p}g</span>
              <span class="macro-chip c">Carboidrati ${c}g</span>
              <span class="macro-chip f">Grassi ${f}g</span>
            </div>
          </div>
          <div class="meal-actions">
            <button class="meal-action-btn details btn-details" data-day="${d}" data-slot="${slot}" title="Vedi ricetta">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              Dettagli
            </button>
            <button class="meal-action-btn replace btn-replace" data-day="${d}" data-slot="${slot}" title="Sostituisci con altra ricetta">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
              Sostituisci
            </button>
            <button class="meal-action-btn confirm${isConfirmed ? ' active' : ''} btn-confirm" data-day="${d}" data-slot="${slot}" title="${isConfirmed ? 'Pasto confermato – clicca per rimuovere' : 'Conferma questo pasto'}">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
              ${isConfirmed ? 'Confermato' : 'Conferma'}
            </button>
            <button class="meal-action-btn exclude btn-exclude" data-day="${d}" data-slot="${slot}" title="Rimuovi questa ricetta dai suggerimenti">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Elimina
            </button>
          </div>
        </div>`;
    }

    html += `</div></div>`;
  }

  html += `</div>`;
  el.innerHTML = html;

  // Events
  el.querySelector('#btn-regen')?.addEventListener('click', async () => {
    toast('Rigenerazione in corso...', 'info');
    await generateAndSavePlan();
    renderPiano();
  });

  el.querySelectorAll('.btn-details').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openRecipeModal(+btn.dataset.day, btn.dataset.slot); });
  });
  el.querySelectorAll('.btn-replace').forEach(btn => {
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await handleReplace(+btn.dataset.day, btn.dataset.slot); });
  });
  el.querySelectorAll('.btn-confirm').forEach(btn => {
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await handleConfirm(+btn.dataset.day, btn.dataset.slot); });
  });
  el.querySelectorAll('.btn-exclude').forEach(btn => {
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await handleExclude(+btn.dataset.day, btn.dataset.slot); });
  });
  el.querySelectorAll('.meal-row').forEach(row => {
    row.addEventListener('click', () => openRecipeModal(+row.dataset.day, row.dataset.slot));
  });
}

async function handleReplace(dayIdx, slot) {
  const day = state.plan.days[dayIdx];
  const current = day.slots[slot];
  if (!current) return;

  if (!state.rejectedPerSlot[slot]) state.rejectedPerSlot[slot] = [];
  state.rejectedPerSlot[slot].push(current.id);

  const next = replaceRecipe(
    state.recipes, state.profile, slot,
    state.plan, dayIdx,
    state.rejectedPerSlot[slot],
    state.excluded
  );
  if (!next) { toast('Nessuna altra ricetta disponibile', 'info'); return; }

  state.plan.days[dayIdx].slots[slot] = next;
  await upsertProfile(state.session.user.id, { current_plan: state.plan });
  renderPiano();
  toast('Ricetta sostituita!');
}

async function handleConfirm(dayIdx, slot) {
  const day = state.plan.days[dayIdx];
  const recipe = day.slots[slot];
  if (!recipe) return;
  const uid = state.session.user.id;
  const confirmedKey = `${day.date}|${slot}`;
  const alreadyConfirmed = state.confirmedMeals.find(cm => cm.plan_date === day.date && cm.meal_slot === slot);

  if (alreadyConfirmed) {
    await unconfirmMeal(uid, day.date, slot);
    state.confirmedMeals = state.confirmedMeals.filter(cm => !(cm.plan_date === day.date && cm.meal_slot === slot));
    toast('Conferma rimossa');
  } else {
    const cm = await confirmMeal(uid, day.date, slot, recipe.id);
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
async function renderCalendar() {
  const el = document.getElementById('page-calendario');
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  // Carica pasti confermati del mese
  const firstDay = new Date(year, month, 1).toISOString().split('T')[0];
  const lastDay  = new Date(year, month + 1, 0).toISOString().split('T')[0];
  let confirmed = [];
  try {
    confirmed = await getConfirmedMeals(state.session?.user?.id || 'x', firstDay, lastDay);
  } catch {}

  const confirmedDates = new Set(confirmed.map(c => c.plan_date));

  const monthName = now.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = (firstDow + 6) % 7; // Lunedì = 0

  const days = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
  let grid = days.map(d => `<div class="cal-header">${d}</div>`).join('');

  for (let i = 0; i < startOffset; i++) grid += `<div class="cal-day empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === now.toISOString().split('T')[0];
    const hasData = confirmedDates.has(dateStr);
    grid += `<div class="cal-day${isToday ? ' today' : ''}${hasData ? ' has-data' : ''}" data-date="${dateStr}">${d}</div>`;
  }

  el.innerHTML = `
    <div id="main-content">
      <h2 style="margin-bottom:20px;text-transform:capitalize">${monthName}</h2>
      <div class="card">
        <div class="calendar-grid">${grid}</div>
      </div>
      <div id="cal-day-detail" class="mt-16"></div>
    </div>`;

  el.querySelectorAll('.cal-day:not(.empty)').forEach(cell => {
    cell.addEventListener('click', () => showDayDetail(cell.dataset.date, confirmed));
  });
}

function showDayDetail(date, confirmed) {
  const dayMeals = confirmed.filter(c => c.plan_date === date);
  const el = document.getElementById('cal-day-detail');
  if (!dayMeals.length) {
    el.innerHTML = `<p class="text-soft center">Nessun pasto confermato per ${formatDateShort(date)}</p>`;
    return;
  }
  const label = formatDate(date);
  let html = `<h3 style="margin-bottom:12px">${label}</h3>`;
  for (const m of dayMeals) {
    const r = m.recipes;
    if (!r) continue;
    html += `
      <div class="meal-row" style="cursor:default">
        <span class="meal-slot-badge slot-${m.meal_slot}">${m.meal_slot}</span>
        <div class="meal-info">
          <div class="meal-name">${r.name}</div>
          <div class="meal-meta">${r.calories} kcal</div>
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
  let dayBtns = days.map((d, i) => `
    <button class="day-toggle${state.selectedShoppingDays.includes(i) ? ' selected' : ''}" data-day="${i}">
      ${formatDateShort(d.date)}
    </button>
  `).join('');

  el.innerHTML = `
    <div id="main-content">
      <h2 style="margin-bottom:6px">Lista della Spesa</h2>
      <p class="text-soft" style="margin-bottom:16px">Seleziona i giorni per cui fare la spesa</p>
      <div class="shopping-day-selector">${dayBtns}</div>
      <button class="btn btn-primary w-full" id="btn-gen-shopping" style="margin-bottom:24px">Genera lista</button>
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
    const list = buildShoppingList(state.plan, state.selectedShoppingDays);
    renderShoppingList(list);
  });
}

function renderShoppingList(list) {
  const el = document.getElementById('shopping-list');
  const catOrder = ['Carne e Pesce','Verdure e Ortaggi','Frutta','Latticini e Uova','Pasta e Cereali','Legumi','Dispensa','Frutta secca','Altro'];

  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <h3>Lista generata</h3>
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

  const logsHtml = state.weightLogs.slice(-5).reverse().map(l => `
    <div class="weight-log-entry">
      <span>${new Date(l.logged_at).toLocaleDateString('it-IT')}</span>
      <span class="bold text-green">${l.weight} kg</span>
    </div>
  `).join('');

  el.innerHTML = `
    <div id="main-content">
      <h2 style="margin-bottom:20px">Profilo</h2>

      <div class="bmr-card">
        <h3>Calorie giornaliere</h3>
        <div class="kcal">${Math.round(p.target_calories || 0)}</div>
        <p>BMR: ${Math.round(p.bmr || 0)} kcal · TDEE: ${Math.round(p.tdee || 0)} kcal</p>
        <p>Obiettivo: <strong>${p.goal || '–'}</strong> · Attività: <strong>${p.activity_level || '–'}</strong></p>
      </div>

      <div class="profile-stat-grid">
        <div class="stat-box"><div class="stat-value">${p.weight || '–'} kg</div><div class="stat-label">Peso attuale</div></div>
        <div class="stat-box"><div class="stat-value">${p.height || '–'} cm</div><div class="stat-label">Altezza</div></div>
        <div class="stat-box"><div class="stat-value">${(p.bmi || 0).toFixed(1)}</div><div class="stat-label">BMI <span class="bmi-pill ${status.cls}">${status.label}</span></div></div>
        <div class="stat-box"><div class="stat-value">${p.age || '–'}</div><div class="stat-label">Età</div></div>
      </div>

      <div class="card mt-16">
        <div class="flex items-center justify-between" style="margin-bottom:14px">
          <h3>Andamento peso</h3>
          <button class="btn btn-secondary btn-sm" id="btn-add-weight">+ Peso</button>
        </div>
        <canvas id="weight-chart" class="weight-chart"></canvas>
        <div id="weight-logs-list" style="margin-top:12px">${logsHtml}</div>
      </div>

      <div class="card mt-16">
        <h3 style="margin-bottom:12px">Impostazioni dieta</h3>
        <div class="profile-stat-grid">
          <div class="stat-box"><div class="stat-value" style="font-size:1rem">${p.diet_type || '–'}</div><div class="stat-label">Regime</div></div>
          <div class="stat-box"><div class="stat-value" style="font-size:0.85rem">${p.meal_schedule?.replace('_',' ') || '–'}</div><div class="stat-label">Distribuzione pasti</div></div>
        </div>
        <div style="margin-top:12px">
          ${p.allergies?.length ? `<p><strong>Allergie:</strong> ${p.allergies.join(', ')}</p>` : ''}
          ${p.dislikes?.length  ? `<p><strong>Non graditi:</strong> ${p.dislikes.join(', ')}</p>` : ''}
        </div>
        <button class="btn btn-secondary w-full mt-16" id="btn-edit-profile">✏ Modifica profilo</button>
      </div>

      <button class="btn btn-ghost w-full mt-16" id="btn-logout" style="color:#c00">Esci dall'account</button>
    </div>`;

  renderWeightChart();

  document.getElementById('btn-add-weight')?.addEventListener('click', () => promptWeightEntry());
  document.getElementById('btn-logout')?.addEventListener('click', async () => { await signOut(); });
  document.getElementById('btn-edit-profile')?.addEventListener('click', () => {
    document.getElementById('onboarding-wrapper').classList.remove('hidden');
    document.getElementById('app-wrapper').classList.add('hidden');
    startOnboarding();
  });
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

function renderWeightChart() {
  const canvas = document.getElementById('weight-chart');
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
