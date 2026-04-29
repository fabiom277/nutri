// ── Nutrì — nutrition.js ─────────────────────────────
// Mifflin-St Jeor + scaling dinamico ricette

const ACTIVITY = {
  sedentario: 1.2, leggero: 1.375, moderato: 1.55, attivo: 1.725, atleta: 1.9
};
const GOAL_DELTA = { dimagrire: -500, mantenere: 0, aumentare: 300 };

const SLOT_RATIOS = {
  standard:                { colazione: 0.22, spuntino: 0.10, pranzo: 0.38, cena: 0.30 },
  intermittente_colazione: { colazione: 0.35, spuntino: 0.28, pranzo: 0.37 },
  intermittente_pranzo:    { pranzo: 0.50, cena: 0.50 },
};

// ── Formule metabolismo ───────────────────────────────
function calcBMR(weight, height, age, sex) {
  const base = 10 * weight + 6.25 * height - 5 * age;
  return sex === 'M' ? base + 5 : base - 161;
}
function calcTDEE(bmr, level) { return bmr * (ACTIVITY[level] || 1.2); }
function calcTargetCalories(tdee, goal) {
  return Math.max(1200, tdee + (GOAL_DELTA[goal] || 0));
}
function calcBMI(weight, height) {
  const hm = height / 100; return weight / (hm * hm);
}
function bmiStatus(bmi) {
  if (bmi < 18.5) return { label: 'Sottopeso',  cls: 'bmi-under'  };
  if (bmi < 25)   return { label: 'Normopeso',  cls: 'bmi-normal' };
  if (bmi < 30)   return { label: 'Sovrappeso', cls: 'bmi-over'   };
  return                 { label: 'Obesità',     cls: 'bmi-obese'  };
}
function caloriesBySlot(targetCal, schedule) {
  const ratios = SLOT_RATIOS[schedule] || SLOT_RATIOS.standard;
  return Object.fromEntries(
    Object.entries(ratios).map(([s, r]) => [s, Math.round(targetCal * r)])
  );
}
function activeSlots(schedule) {
  return Object.keys(SLOT_RATIOS[schedule] || SLOT_RATIOS.standard);
}

// ── Calcolo kcal ──────────────────────────────────────
function ingredientKcal(ing, amount) {
  const unit = (ing.unit || 'g').toLowerCase();
  const kp100 = ing.kcal_per_100 || 0;
  if (!amount || !kp100) return 0;
  if (unit === 'pz')     return kp100 * amount * 0.55;
  if (unit === 'pizzico' || ing.priority === 99) return 0;
  return kp100 * amount / 100;
}
function calcRecipeKcal(amounts, ings) {
  return ings.reduce((s, ing, i) => s + ingredientKcal(ing, amounts[i] ?? ing.amount), 0);
}

// ── Scaling dinamico ──────────────────────────────────
/**
 * Scala una ricetta template verso targetKcal.
 * Usa kcal_max_scaled pre-calcolato per sapere fin dove può arrivare.
 * Se il max non basta, applica ingredienti correttivi ad alta densità.
 */
function scaleRecipeToTarget(recipe, targetKcal, schedule) {
  const ings = recipe.ingredients;
  if (!ings || !ings.length) return recipe;

  // Parti dai minimi per ingredienti scalabili, fisso per condimenti
  const amounts = ings.map(ing =>
    (ing.step && ing.priority < 99) ? (ing.min ?? ing.amount) : ing.amount
  );

  let kcal = calcRecipeKcal(amounts, ings);
  const LOW = 0.93, HIGH = 1.08;

  // ── Fase 1: scaling per priorità (1=carbs, 2=grassi, 3=proteine) ──
  let iter = 120;
  outer: while (kcal < targetKcal * LOW && iter-- > 0) {
    let improved = false;
    for (const prio of [1, 2, 3]) {
      for (let i = 0; i < ings.length; i++) {
        const ing = ings[i];
        if (ing.priority !== prio || !ing.step) continue;
        const maxAmt = ing.max ?? ing.amount * 2;
        if (amounts[i] + ing.step <= maxAmt) {
          amounts[i] += ing.step;
          kcal = calcRecipeKcal(amounts, ings);
          improved = true;
          if (kcal >= targetKcal * LOW) break outer;
        }
      }
    }
    if (!improved) break;
  }

  // ── Fase 2: correttivi ad alta densità ──
  if (kcal < targetKcal * LOW) {
    kcal = applyCorrectiveIngredients(ings, amounts, targetKcal - kcal, kcal, schedule);
  }

  // ── Fase 3: taglia se sopra 108% ──
  if (kcal > targetKcal * HIGH) {
    for (let i = 0; i < ings.length; i++) {
      const ing = ings[i];
      if (ing.priority !== 1 || !ing.step) continue;
      while (kcal > targetKcal * HIGH && amounts[i] - ing.step >= (ing.min ?? 0)) {
        amounts[i] -= ing.step;
        kcal = calcRecipeKcal(amounts, ings);
      }
      if (kcal <= targetKcal * HIGH) break;
    }
  }

  const baseKcal = recipe.calories || 1;
  const scale = Math.max(0.5, kcal / baseKcal);
  const bm = recipe.macros || {};

  return {
    ...recipe,
    calories:    Math.round(kcal),
    macros: {
      proteine:    Math.round((bm.proteine    || 0) * scale),
      carboidrati: Math.round((bm.carboidrati || 0) * scale),
      grassi:      Math.round((bm.grassi      || 0) * scale),
    },
    ingredients: ings.map((ing, i) => ({ ...ing, amount: amounts[i] })),
    _scaled: true,
  };
}

// Correttivi in ordine di preferenza (alta densità, gusto neutro)
const CORRECTIVES = [
  { keyword: 'olio',       kcal_per_g: 9.0,  step: 5,  max_add: 25 },
  { keyword: 'mandorle',   kcal_per_g: 5.8,  step: 10, max_add: 40 },
  { keyword: 'noci',       kcal_per_g: 6.5,  step: 10, max_add: 30 },
  { keyword: 'parmigiano', kcal_per_g: 4.3,  step: 10, max_add: 40 },
  { keyword: 'avocado',    kcal_per_g: 1.6,  step: 20, max_add: 80 },
];
const CORRECTIVES_IF = [
  { keyword: 'pane',       kcal_per_g: 2.3,  step: 20, max_add: 80 },
  { keyword: 'riso',       kcal_per_g: 3.5,  step: 20, max_add: 100 },
  { keyword: 'pasta',      kcal_per_g: 3.5,  step: 20, max_add: 100 },
  ...CORRECTIVES,
];

function applyCorrectiveIngredients(ings, amounts, deficit, kcal, schedule) {
  const list = schedule !== 'standard' && deficit > 100 ? CORRECTIVES_IF : CORRECTIVES;
  for (const corr of list) {
    if (deficit <= 50) break;
    const idx = ings.findIndex(i => i.name.toLowerCase().includes(corr.keyword));

    if (idx !== -1) {
      // Ingrediente già presente: aumenta la quantità
      const ing = ings[idx];
      const maxAmt = ing.max ?? amounts[idx] * 2.5;
      const headroom = Math.min(corr.max_add, maxAmt - amounts[idx]);
      if (headroom > 0) {
        const stepsNeeded = Math.ceil(deficit / (corr.kcal_per_g * corr.step));
        const stepsMax    = Math.floor(headroom / corr.step);
        const steps       = Math.min(stepsNeeded, stepsMax);
        if (steps > 0) {
          const added = steps * corr.step;
          amounts[idx] += added;
          const addedKcal = corr.kcal_per_g * added;
          kcal    += addedKcal;
          deficit -= addedKcal;
        }
      }
    } else if (deficit > 150) {  // aggiunge anche in standard se deficit elevato
      // Ingrediente assente: aggiungilo come nuovo elemento al pasto (solo IF)
      const addAmt = Math.min(corr.max_add,
        Math.ceil(deficit / corr.kcal_per_g / corr.step) * corr.step);
      if (addAmt >= corr.step) {
        ings.push({
          name: corr.keyword === 'olio' ? "olio extravergine d'oliva" :
                corr.keyword === 'mandorle' ? 'mandorle' :
                corr.keyword === 'pane' ? 'pane integrale' :
                corr.keyword === 'riso' ? 'riso integrale' : corr.keyword,
          amount: addAmt, unit: corr.keyword === 'olio' ? 'ml' : 'g',
          kcal_per_100: corr.kcal_per_g * 100,
          min: corr.step, max: corr.max_add, step: corr.step, priority: 2,
          category: corr.keyword === 'pane' || corr.keyword === 'riso' ? 'carboidrati' : 'grassi',
          _corrective: true,
        });
        amounts.push(addAmt);
        const addedKcal = corr.kcal_per_g * addAmt;
        kcal    += addedKcal;
        deficit -= addedKcal;
      }
    }
  }
  return kcal;
}

// ── Selezione candidati per slot ─────────────────────
/**
 * Filtra i candidati per fattibilità calorica:
 * kcal_max_scaled deve essere >= soglia% del target.
 * Soglia: 85% → se vuota, abbassa a 65% → se ancora vuota, nessun filtro.
 */
function feasibleCandidates(pool, targetKcal) {
  for (const threshold of [0.85, 0.65, 0]) {
    const f = threshold > 0
      ? pool.filter(r => (r.kcal_max_scaled ?? r.calories * 1.5) >= targetKcal * threshold)
      : pool;
    if (f.length > 0) return f;
  }
  return pool;
}

// ── Filtro ricette per dieta/allergie ─────────────────
const FOOD_CATS = {
  pesce:       ['salmone','trota','orata','branzino','tonno','merluzzo','sgombro','alici','acciughe','dentice','spigola'],
  crostacei:   ['gamberi','gamberetti','scampi','aragoste','granchi','mazzancolle','astici'],
  molluschi:   ['cozze','vongole','calamari','seppie','polpo','ostriche'],
  funghi:      ['funghi','porcini','champignon','shitake','pleurotus'],
  formaggi:    ['parmigiano','grana','pecorino','ricotta','feta','mozzarella','scamorza','gorgonzola','formaggio'],
  uova:        ['uova','uovo','albume','tuorlo'],
  carne:       ['pollo','manzo','vitello','maiale','tacchino','agnello','coniglio','prosciutto','salame','bresaola','speck'],
  legumi:      ['ceci','fagioli','lenticchie','piselli','soia','fave'],
  fruttasecca: ['mandorle','noci','nocciole','pistacchi','anacardi','pinoli','arachidi'],
};

function filterRecipes(recipes, profile, slot, excluded = []) {
  const { diet_type, allergies = [], dislikes = [] } = profile;
  const bannedWords = new Set();
  for (const d of [...dislikes, ...allergies]) {
    const dl = d.toLowerCase().trim();
    bannedWords.add(dl);
    for (const [cat, words] of Object.entries(FOOD_CATS)) {
      if (dl === cat || dl.includes(cat) || cat.includes(dl))
        words.forEach(w => bannedWords.add(w));
    }
  }
  return recipes.filter(r => {
    if (!r.meal_type.includes(slot))  return false;
    if (excluded.includes(r.id))      return false;
    if (diet_type === 'vegana' && !r.diet_type.includes('vegana')) return false;
    if (diet_type === 'vegetariana'
      && !r.diet_type.includes('vegetariana')
      && !r.diet_type.includes('vegana')) return false;
    for (const a of allergies) {
      if (r.allergens?.some(al => al.toLowerCase().includes(a.toLowerCase()))) return false;
    }
    for (const bw of bannedWords) {
      if (r.name.toLowerCase().includes(bw)) return false;
      if (r.ingredients?.some(i => i.name.toLowerCase().includes(bw))) return false;
      if (r.tags?.some(t => t.toLowerCase().includes(bw))) return false;
    }
    return true;
  });
}

// ── Generazione piano settimanale ─────────────────────
/**
 * Calcola uno score per la selezione ricetta.
 * Priorità: liked > neutro >> disliked
 * @param {Object} recipe
 * @param {number} target kcal target slot
 * @param {Object} ratings { recipeId: 1 | -1 }
 */
function recipeScore(recipe, target, ratings = {}) {
  const rating    = ratings[recipe.id] || 0;
  const kcalDist  = Math.abs(recipe.calories - target);
  // Base score: inverso della distanza calorica (più vicino = meglio)
  let score = 1000 - kcalDist;
  // Bonus/malus rating
  if (rating ===  1) score += 400;   // 👍 preferita fortemente
  if (rating === -1) score -= 600;   // 👎 evitata fortemente
  return score;
}

function generateWeeklyPlan(recipes, profile, excludedIds = [], ratings = {}) {
  const slots    = activeSlots(profile.meal_schedule);
  const calSlots = caloriesBySlot(profile.target_calories, profile.meal_schedule);
  const todayLocal = new Date();
  const pad = n => String(n).padStart(2, '0');

  // Pool per slot — esclude le ricette con 👎 forte se ci sono alternative
  const pools = {};
  for (const slot of slots) {
    const all      = filterRecipes(recipes, profile, slot, excludedIds);
    const liked    = all.filter(r => (ratings[r.id] || 0) >=  0);
    pools[slot]    = shuffleArray(liked.length >= 3 ? liked : all);
  }

  const usedIds = new Set();
  const days = [];

  for (let d = 0; d < 7; d++) {
    const date    = new Date(todayLocal.getFullYear(), todayLocal.getMonth(), todayLocal.getDate() + d);
    const dateStr = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
    const daySlots = {};
    let dayKcal = 0;

    for (const slot of slots) {
      const target = calSlots[slot];
      const pool   = pools[slot];
      if (!pool.length) { daySlots[slot] = null; continue; }

      const fresh   = pool.filter(r => !usedIds.has(r.id));
      const search  = fresh.length ? fresh : pool;
      const feasible = feasibleCandidates(search, target);

      // Ordina per score (kcal + rating) invece di solo distanza calorica
      const sorted = [...feasible].sort((a, b) =>
        recipeScore(b, target, ratings) - recipeScore(a, target, ratings)
      );
      // Top 5 per varietà (non sempre la migliore)
      const topN   = sorted.slice(0, Math.min(5, sorted.length));
      // Peso casuale ma sbilanciato verso le prime: scegli con probabilità 40/30/15/10/5
      const weights = [40, 30, 15, 10, 5].slice(0, topN.length);
      const total   = weights.reduce((s, w) => s + w, 0);
      let rand      = Math.random() * total;
      let chosen    = topN[0];
      for (let i = 0; i < topN.length; i++) {
        rand -= weights[i];
        if (rand <= 0) { chosen = topN[i]; break; }
      }

      const scaled = scaleRecipeToTarget(chosen, target, profile.meal_schedule);
      daySlots[slot] = scaled;
      dayKcal += scaled.calories;
      usedIds.add(chosen.id);

      const idx = pool.findIndex(r => r.id === chosen.id);
      if (idx > -1) pool.splice(idx, 1);
    }

    days.push({ date: dateStr, slots: daySlots, totalKcal: Math.round(dayKcal) });
  }

  return { days, generatedAt: new Date().toISOString() };
}

function replaceRecipe(recipes, profile, slot, currentPlan, dayIndex, rejectedForSlot = [], excludedIds = [], ratings = {}) {
  const target  = caloriesBySlot(profile.target_calories, profile.meal_schedule)[slot];
  const usedIds = new Set(currentPlan.days.flatMap(d => d.slots[slot]?.id ? [d.slots[slot].id] : []));

  let candidates = filterRecipes(recipes, profile, slot, excludedIds)
    .filter(r => !rejectedForSlot.includes(r.id));

  // Evita ricette con 👎 se ci sono alternative sufficienti
  const positives = candidates.filter(r => (ratings[r.id] || 0) >= 0);
  if (positives.length >= 3) candidates = positives;

  const fresh = candidates.filter(r => !usedIds.has(r.id));
  const pool  = feasibleCandidates(fresh.length ? fresh : candidates, target);
  if (!pool.length) return null;

  // Usa score per privilegiare le 👍
  const sorted = [...pool].sort((a, b) => recipeScore(b, target, ratings) - recipeScore(a, target, ratings));
  const topN   = sorted.slice(0, Math.min(5, sorted.length));
  const chosen = topN[Math.floor(Math.random() * topN.length)];
  return scaleRecipeToTarget(chosen, target, profile.meal_schedule);
}

// ── Lista della spesa ─────────────────────────────────
function buildShoppingList(plan, selectedDayIndices) {
  const raw = {};
  for (const idx of selectedDayIndices) {
    const day = plan.days[idx];
    if (!day) continue;
    for (const recipe of Object.values(day.slots)) {
      if (!recipe?.ingredients) continue;
      for (const ing of recipe.ingredients) {
        const key = `${ing.name.toLowerCase()}||${ing.unit || ''}`;
        if (raw[key]) raw[key].amount += ing.amount || 0;
        else raw[key] = { name: ing.name, unit: ing.unit || '', amount: ing.amount || 0 };
      }
    }
  }
  const CATS = {
    'Carne e Pesce':    ['pollo','manzo','vitello','tacchino','macinato','coniglio','salmone','tonno','orata','branzino','merluzzo','sgombro','gamberetti','trancio','acciughe'],
    'Verdure e Ortaggi':['zucchine','carote','spinaci','broccoli','pomodori','peperoni','cipolla','aglio','sedano','melanzane','asparagi','lattuga','rucola','cetriolo','patate','zucca'],
    'Frutta':           ['mela','banana','fragole','mirtilli','limone','lime','avocado','arancia','pera','kiwi','albicocche'],
    'Latticini e Uova': ['yogurt','ricotta','parmigiano','feta','grana','latte','uova','uovo','albume','formaggio','kefir'],
    'Pasta e Cereali':  ['pasta','spaghetti','fusilli','penne','riso','farro','orzo','cous','quinoa','avena','gallette','pane','fette biscottate'],
    'Legumi':           ['ceci','fagioli','lenticchie','piselli','soia','fave','edamame','tofu'],
    'Dispensa':         ['olio','sale','pepe','curry','curcuma','cannella','zenzero','rosmarino','basilico','timo','origano','prezzemolo','paprika','cumino','miele','confettura','aceto','capperi','olive'],
    'Frutta secca':     ['mandorle','noci','nocciole','pistacchi','anacardi','pinoli','semi'],
  };
  const categorized = {};
  for (const item of Object.values(raw)) {
    let cat = 'Altro';
    const nl = item.name.toLowerCase();
    for (const [c, kws] of Object.entries(CATS)) {
      if (kws.some(k => nl.includes(k))) { cat = c; break; }
    }
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(item);
  }
  for (const cat of Object.keys(categorized))
    categorized[cat].sort((a, b) => a.name.localeCompare(b.name, 'it'));
  return categorized;
}

// ── Utility ───────────────────────────────────────────
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long'
  });
}
function formatDateShort(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('it-IT', {
    weekday: 'short', day: 'numeric', month: 'short'
  });
}

export {
  calcBMR, calcTDEE, calcTargetCalories, calcBMI, bmiStatus,
  caloriesBySlot, activeSlots,
  filterRecipes, scaleRecipeToTarget, feasibleCandidates, recipeScore,
  generateWeeklyPlan, replaceRecipe, buildShoppingList,
  shuffleArray, formatDate, formatDateShort
};
