// ── Nutrì — nutrition.js ─────────────────────────────
// Formule: Mifflin-St Jeor + fattori attività/obiettivo

const ACTIVITY = {
  sedentario:  1.2,
  leggero:     1.375,
  moderato:    1.55,
  attivo:      1.725,
  atleta:      1.9
};

const GOAL_MULTIPLIER = {
  dimagrire:  -500,   // kcal deficit
  mantenere:     0,
  aumentare:  +300    // kcal surplus
};

/**
 * Calcola BMR con Mifflin-St Jeor
 * @param {number} weight kg
 * @param {number} height cm
 * @param {number} age anni
 * @param {string} sex 'M' | 'F'
 */
function calcBMR(weight, height, age, sex) {
  const base = 10 * weight + 6.25 * height - 5 * age;
  return sex === 'M' ? base + 5 : base - 161;
}

/**
 * Calcola TDEE (Total Daily Energy Expenditure)
 */
function calcTDEE(bmr, activityLevel) {
  return bmr * (ACTIVITY[activityLevel] || 1.2);
}

/**
 * Calcola calorie target in base all'obiettivo
 */
function calcTargetCalories(tdee, goal) {
  return Math.max(1200, tdee + (GOAL_MULTIPLIER[goal] || 0));
}

/**
 * Calcola BMI
 */
function calcBMI(weight, height) {
  const hm = height / 100;
  return weight / (hm * hm);
}

/**
 * Classifica BMI
 */
function bmiStatus(bmi) {
  if (bmi < 18.5) return { label: 'Sottopeso',    cls: 'bmi-under'  };
  if (bmi < 25)   return { label: 'Normopeso',    cls: 'bmi-normal' };
  if (bmi < 30)   return { label: 'Sovrappeso',   cls: 'bmi-over'   };
  return              { label: 'Obesità',          cls: 'bmi-obese'  };
}

/**
 * Distribuisce le calorie target per slot pasto in base alla schedule
 * Standard: col 20%, spuntino 10%, pranzo 35%, cena 35%
 * IF colazione: col 35%, spuntino 30%, pranzo 35%
 * IF pranzo:    pranzo 50%, cena 50%
 */
function caloriesBySlot(targetCal, schedule) {
  const t = Math.round(targetCal);
  if (schedule === 'intermittente_colazione') {
    return { colazione: Math.round(t * 0.35), spuntino: Math.round(t * 0.30), pranzo: Math.round(t * 0.35) };
  }
  if (schedule === 'intermittente_pranzo') {
    return { pranzo: Math.round(t * 0.50), cena: Math.round(t * 0.50) };
  }
  // standard
  return {
    colazione: Math.round(t * 0.20),
    spuntino:  Math.round(t * 0.10),
    pranzo:    Math.round(t * 0.35),
    cena:      Math.round(t * 0.35)
  };
}

/**
 * Slot attivi per schedule
 */
function activeSlots(schedule) {
  if (schedule === 'intermittente_colazione') return ['colazione', 'spuntino', 'pranzo'];
  if (schedule === 'intermittente_pranzo')    return ['pranzo', 'cena'];
  return ['colazione', 'spuntino', 'pranzo', 'cena'];
}

/**
 * Filtra le ricette compatibili con il profilo utente
 * @param {Array}  recipes  tutte le ricette
 * @param {Object} profile  profilo utente
 * @param {string} slot     'colazione' | 'pranzo' | 'cena' | 'spuntino'
 * @param {Array}  excluded ids da escludere (già eliminati)
 */
function filterRecipes(recipes, profile, slot, excluded = []) {
  const { diet_type, allergies = [], dislikes = [] } = profile;

  // Categorie di ingredienti da escludere (dislikes categoriali)
  const CATEGORIES = {
    pesce:      ['salmone','trota','orata','branzino','tonno','merluzzo','sgombro','alici','sardine','acciughe','dentice','spigola','rombo','sogliola','polpo','calamari','seppie'],
    crostacei:  ['gamberi','gamberetti','scampi','aragoste','granchi','mazzancolle','astici','edamame'],
    molluschi:  ['cozze','vongole','calamari','seppie','polpo','ostriche'],
    funghi:     ['funghi','porcini','champignon','shitake','pleurotus'],
    formaggi:   ['parmigiano','grana','pecorino','ricotta','feta','mozzarella','scamorza','gorgonzola','brie','formaggio'],
    uova:       ['uova','uovo','albume','tuorlo'],
    carne:      ['pollo','manzo','vitello','maiale','tacchino','agnello','coniglio','prosciutto','salame','bresaola','speck'],
    legumi:     ['ceci','fagioli','lenticchie','piselli','soia','fave'],
    fruttasecca:['mandorle','noci','nocciole','pistacchi','anacardi','pinoli','arachidi'],
  };

  // Risolvi dislikes in set di parole da escludere
  const bannedWords = new Set();
  for (const d of dislikes) {
    const dl = d.toLowerCase().trim();
    bannedWords.add(dl);
    for (const [cat, words] of Object.entries(CATEGORIES)) {
      if (dl === cat || dl.includes(cat) || cat.includes(dl)) {
        words.forEach(w => bannedWords.add(w));
      }
    }
  }
  for (const a of allergies) {
    const al = a.toLowerCase().trim();
    bannedWords.add(al);
    for (const [cat, words] of Object.entries(CATEGORIES)) {
      if (al === cat || al.includes(cat) || cat.includes(al)) {
        words.forEach(w => bannedWords.add(w));
      }
    }
  }

  return recipes.filter(r => {
    // Slot
    if (!r.meal_type.includes(slot)) return false;
    // Esclusi dall'utente
    if (excluded.includes(r.id)) return false;
    // Dieta
    if (diet_type === 'vegana'       && !r.diet_type.includes('vegana'))       return false;
    if (diet_type === 'vegetariana'  && !r.diet_type.includes('vegetariana') && !r.diet_type.includes('vegana')) return false;
    // Allergeni
    for (const a of allergies) {
      if (r.allergens && r.allergens.some(al => al.toLowerCase().includes(a.toLowerCase()))) return false;
    }
    // Dislikes: controlla ingredienti e tag
    for (const bw of bannedWords) {
      const inIngredients = r.ingredients && r.ingredients.some(i => i.name.toLowerCase().includes(bw));
      const inTags = r.tags && r.tags.some(t => t.toLowerCase().includes(bw));
      const inName = r.name.toLowerCase().includes(bw);
      if (inIngredients || inTags || inName) return false;
    }
    return true;
  });
}

/**
 * Genera un piano settimanale di 7 giorni
 * Restituisce { days: [ { date, slots: { colazione, pranzo, cena, spuntino } } ] }
 */
function generateWeeklyPlan(recipes, profile, excludedIds = []) {
  const slots = activeSlots(profile.meal_schedule);
  const calSlots = caloriesBySlot(profile.target_calories, profile.meal_schedule);
  const today = new Date();

  // Per ogni slot, prepara pool ordinato casualmente
  const pools = {};
  for (const slot of slots) {
    const candidates = filterRecipes(recipes, profile, slot, excludedIds);
    pools[slot] = shuffleArray([...candidates]);
  }

  const days = [];
  for (let d = 0; d < 7; d++) {
    const date = new Date(today);
    date.setDate(today.getDate() + d);
    const dateStr = date.toISOString().split('T')[0];

    const daySlots = {};
    for (const slot of slots) {
      const pool = pools[slot];
      if (!pool.length) { daySlots[slot] = null; continue; }
      // Scegli la ricetta con calorie più vicine al target dello slot
      const target = calSlots[slot];
      pool.sort((a, b) => Math.abs(a.calories - target) - Math.abs(b.calories - target));
      // Prendi dalla top 3 in modo casuale per varietà
      const topN = pool.slice(0, Math.min(3, pool.length));
      const chosen = topN[Math.floor(Math.random() * topN.length)];
      daySlots[slot] = chosen;
      // Rimuovi dal pool per non ripetere nella stessa settimana (se possibile)
      const idx = pool.findIndex(r => r.id === chosen.id);
      if (idx > -1) pool.splice(idx, 1);
    }
    days.push({ date: dateStr, slots: daySlots });
  }

  return { days, generatedAt: new Date().toISOString() };
}

/**
 * Sostituisci una singola ricetta in un giorno/slot
 * Evita le già usate nella settimana e le recentemente rifiutate
 */
function replaceRecipe(recipes, profile, slot, currentPlan, dayIndex, rejectedForSlot = [], excludedIds = []) {
  const usedIds = new Set();
  currentPlan.days.forEach(d => {
    if (d.slots[slot]) usedIds.add(d.slots[slot].id);
  });

  const candidates = filterRecipes(recipes, profile, slot, excludedIds)
    .filter(r => !rejectedForSlot.includes(r.id));

  // Preferisci non usate questa settimana
  const fresh = candidates.filter(r => !usedIds.has(r.id));
  const pool = fresh.length > 0 ? fresh : candidates;

  if (!pool.length) return null;

  const target = caloriesBySlot(profile.target_calories, profile.meal_schedule)[slot];
  pool.sort((a, b) => Math.abs(a.calories - target) - Math.abs(b.calories - target));
  const topN = pool.slice(0, Math.min(4, pool.length));
  return topN[Math.floor(Math.random() * topN.length)];
}

/**
 * Aggrega gli ingredienti per la lista della spesa
 */
function buildShoppingList(plan, selectedDayIndices) {
  const raw = {}; // key: "nome||unità" -> { name, unit, amount }

  for (const idx of selectedDayIndices) {
    const day = plan.days[idx];
    if (!day) continue;
    for (const recipe of Object.values(day.slots)) {
      if (!recipe || !recipe.ingredients) continue;
      for (const ing of recipe.ingredients) {
        const key = `${ing.name.toLowerCase()}||${ing.unit || ''}`;
        if (raw[key]) {
          raw[key].amount += ing.amount || 0;
        } else {
          raw[key] = { name: ing.name, unit: ing.unit || '', amount: ing.amount || 0 };
        }
      }
    }
  }

  // Categorizza
  const CATS = {
    'Carne e Pesce':    ['pollo','manzo','vitello','tacchino','macinato','coniglio','salmone','tonno','orata','branzino','merluzzo','sgombro','gamberetti','trancio'],
    'Verdure e Ortaggi':['zucchine','carote','spinaci','broccoli','pomodori','peperoni','cipolla','aglio','sedano','melanzane','asparagi','lattuga','rucola','cetriolo','patate','zucca'],
    'Frutta':           ['mela','banana','fragole','mirtilli','limone','lime','avocado','arancia','pera','kiwi'],
    'Latticini e Uova': ['yogurt','ricotta','parmigiano','feta','grana','latte','uova','albume','formaggio','kefir','mozzarella'],
    'Pasta e Cereali':  ['pasta','spaghetti','fusilli','penne','riso','farro','orzo','cous','quinoa','avena','gallette','pane','fette biscottate'],
    'Legumi':           ['ceci','fagioli','lenticchie','piselli','soia','fave','edamame','tofu'],
    'Dispensa':         ['olio','sale','pepe','curry','curcuma','cannella','zenzero','rosmarino','basilico','timo','origano','prezzemolo','paprika','cumino','miele','confettura','aceto','capperi','olive'],
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

  return categorized;
}

// ── Utilità
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatDateShort(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
}

export {
  calcBMR, calcTDEE, calcTargetCalories, calcBMI, bmiStatus,
  caloriesBySlot, activeSlots, filterRecipes,
  generateWeeklyPlan, replaceRecipe, buildShoppingList,
  shuffleArray, formatDate, formatDateShort
};
