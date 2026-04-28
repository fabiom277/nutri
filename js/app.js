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
  if (name === 'calendario') {
    // Reset al mese corrente quando si entra nel calendario dal menu
    calendarYear  = null;
    calendarMonth = null;
    renderCalendar();
  }
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

    state.profile    = profile;
    state.recipes    = recipes;
    state.excluded   = excluded;
    state.weightLogs = weightLogs;

    if (!profile || !profile.onboarding_complete) {
      showOnboarding();
      return;
    }

    // Ricostruisce o genera il piano PRIMA di mostrare l'app
    const savedPlan = profile.current_plan;
    if (savedPlan && savedPlan.days) {
      state.plan = hydratePlan(savedPlan, recipes);
    }
    if (!state.plan || !state.plan.days?.length) {
      try {
        await generateAndSavePlan();
      } catch (e) {
        console.warn('[loadUserData] generateAndSavePlan failed:', e);
      }
    }

    await loadConfirmedMeals();

    // Solo ora mostra l'app (state.plan è già pronto)
    showApp();

  } catch (e) {
    console.error('[loadUserData]', e);
    toast('Errore caricamento dati: ' + (e.message || ''), 'error');
  }
}

/**
 * Ricostruisce il piano completo dagli ID salvati nel DB
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
        // Formato nuovo: val è una stringa UUID
        if (typeof val === 'string') return [slot, recipeMap[val] || null];
        // Formato vecchio: val è già un oggetto ricetta (retrocompatibilità)
        if (typeof val === 'object' && val.id) return [slot, recipeMap[val.id] || val];
        return [slot, null];
      })
    )
  }));

  // Verifica che almeno un giorno abbia almeno una ricetta valida
  const hasAnyRecipe = days.some(d =>
    Object.values(d.slots).some(r => r !== null)
  );
  if (!hasAnyRecipe) return null;

  return { days, generatedAt: compactPlan.generatedAt };
}

async function loadConfirmedMeals() {
  const uid = state.session.user.id;
  // Carica 60 giorni: 30 passati + 30 futuri (copre storico calendario + piano corrente)
  const from = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const to   = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
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

  // Salva su Supabase solo gli ID (payload minimo)
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

  // Svuota le conferme della settimana corrente: il piano è cambiato
  // e i vecchi pasti confermati non corrispondono più alle nuove ricette
  try {
    const uid = state.session.user.id;
    const from = plan.days[0]?.date;
    const to   = plan.days[plan.days.length - 1]?.date;
    if (from && to) {
      const { error } = await supabase
        .from('confirmed_meals')
        .delete()
        .eq('user_id', uid)
        .gte('plan_date', from)
        .lte('plan_date', to);
      if (!error) state.confirmedMeals = state.confirmedMeals.filter(
        cm => cm.plan_date < from || cm.plan_date > to
      );
    }
  } catch (e) {
    console.warn('[generateAndSavePlan] clear confirmed failed (non-critical):', e);
  }
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
          <div class="meal-row-top">
            <span class="meal-slot-badge slot-${slot}">${slot}</span>
            <div class="meal-info">
              <div class="meal-name">${recipe.name}</div>
              <div class="meal-kcal">${recipe.calories} <span>kcal</span></div>
              <div class="macro-bar">
                <span class="macro-chip p">Proteine ${p}g</span>
                <span class="macro-chip c">Carboidrati ${c}g</span>
                <span class="macro-chip f">Grassi ${f}g</span>
              </div>
            </div>
          </div>
          <div class="meal-actions">
            <button class="meal-action-btn details btn-details" data-day="${d}" data-slot="${slot}">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              Dettagli
            </button>
            <button class="meal-action-btn replace btn-replace" data-day="${d}" data-slot="${slot}" ${isConfirmed ? 'disabled title="Rimuovi la conferma per poter sostituire"' : ''}>
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
              Sostituisci
            </button>
            <button class="meal-action-btn confirm${isConfirmed ? ' active' : ''} btn-confirm" data-day="${d}" data-slot="${slot}">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
              ${isConfirmed ? 'Confermato' : 'Conferma'}
            </button>
            <button class="meal-action-btn exclude btn-exclude" data-day="${d}" data-slot="${slot}" ${isConfirmed ? 'disabled title="Rimuovi la conferma per poter eliminare"' : ''}>
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

  // Carica pasti confermati del mese visualizzato
  const firstDay = new Date(year, month, 1).toISOString().split('T')[0];
  const lastDay  = new Date(year, month + 1, 0).toISOString().split('T')[0];
  let confirmed = [];
  try {
    confirmed = await getConfirmedMeals(state.session?.user?.id || 'x', firstDay, lastDay);
  } catch {}

  const confirmedDates = new Set(confirmed.map(c => c.plan_date));
  const monthName = new Date(year, month, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });

  const firstDow   = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = (firstDow + 6) % 7; // Lunedì = 0
  const todayStr   = now.toISOString().split('T')[0];

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
        <div class="card" style="text-align:center;padding:32px">
          <p style="font-size:1.5rem;margin-bottom:8px">🍽️</p>
          <p class="text-soft">Nessun pasto confermato nei giorni selezionati.<br>
          Vai nel Piano e conferma i pasti che vuoi cucinare.</p>
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
