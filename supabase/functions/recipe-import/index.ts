// ── Nutrì — recipe-import Edge Function ──────────────────
// Importa una ricetta da URL estraendo i dati Schema.org Recipe (JSON-LD)
// Supporta: GialloZafferano, Cucchiaio d'Argento, Ricette.it e qualsiasi
// sito con markup Schema.org Recipe (https://schema.org/Recipe)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { url } = await req.json();
    if (!url || !url.startsWith('http')) {
      return json({ error: 'URL non valido' }, 400);
    }

    // 1. Scarica la pagina
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Nutri-bot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-IT,it;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!pageRes.ok) return json({ error: `Impossibile raggiungere la pagina (${pageRes.status})` }, 400);

    const html = await pageRes.text();

    // 2. Estrai JSON-LD Schema.org Recipe
    const recipe = extractSchemaRecipe(html, url);
    if (!recipe) return json({ error: 'Nessuna ricetta trovata in questa pagina. Assicurati che il sito usi i dati strutturati Schema.org.' }, 400);

    // 3. Abbina ingredienti al DB INRAN
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const enrichedIngredients = await matchIngredients(supabase, recipe.ingredients);

    // 4. Calcola totali nutrizionali dagli ingredienti matchati
    const nutrition = calcNutrition(enrichedIngredients);

    return json({
      name:         recipe.name,
      description:  recipe.description,
      image_url:    recipe.image,
      source_url:   url,
      prep_time:    recipe.prepTime,
      servings:     recipe.servings,
      ingredients:  enrichedIngredients,
      instructions: recipe.instructions,
      calories:     nutrition.kcal,
      macros: {
        proteine:    nutrition.proteine,
        carboidrati: nutrition.carboidrati,
        grassi:      nutrition.grassi,
      },
      meal_type:    guessMealType(recipe.name, recipe.keywords),
      matched:      enrichedIngredients.filter(i => i.food_item_id).length,
      total:        enrichedIngredients.length,
    });

  } catch (e) {
    console.error('[recipe-import]', e);
    return json({ error: e.message || 'Errore interno' }, 500);
  }
});

// ── Helpers ───────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function extractSchemaRecipe(html: string, url: string) {
  // Cerca tutti i blocchi JSON-LD nella pagina
  const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  for (const match of ldMatches) {
    try {
      let data = JSON.parse(match[1].trim());
      // Può essere un array o un oggetto @graph
      if (Array.isArray(data)) data = data.find(d => d['@type'] === 'Recipe') || data[0];
      if (data['@graph']) data = data['@graph'].find((d: any) => d['@type'] === 'Recipe');
      if (!data || data['@type'] !== 'Recipe') continue;

      return parseSchemaRecipe(data);
    } catch { continue; }
  }

  // Fallback: parsing HTML specifico per GialloZafferano
  return parseGialloZafferano(html);
}

function parseSchemaRecipe(data: any) {
  const name        = data.name || '';
  const description = stripHtml(data.description || '');
  const image       = Array.isArray(data.image) ? data.image[0]?.url || data.image[0] : data.image?.url || data.image || '';
  const prepTime    = parseDuration(data.prepTime || data.cookTime || data.totalTime || '');
  const servings    = parseInt(data.recipeYield) || 1;

  // Ingredienti
  const rawIngs = Array.isArray(data.recipeIngredient) ? data.recipeIngredient : [];
  const ingredients = rawIngs.map((s: string) => parseIngredientString(String(s)));

  // Istruzioni
  let instructions: string[] = [];
  if (Array.isArray(data.recipeInstructions)) {
    instructions = data.recipeInstructions.map((step: any) =>
      typeof step === 'string' ? stripHtml(step) : stripHtml(step.text || step.name || '')
    ).filter(Boolean);
  } else if (typeof data.recipeInstructions === 'string') {
    instructions = data.recipeInstructions.split(/\n|<br>/).map(stripHtml).filter(Boolean);
  }

  const keywords = typeof data.keywords === 'string' ? data.keywords : '';

  return { name, description, image, prepTime, servings, ingredients, instructions, keywords };
}

function parseGialloZafferano(html: string) {
  // Estrae il titolo
  const titleMatch = html.match(/<h1[^>]*class="[^"]*gz-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const name = titleMatch ? stripHtml(titleMatch[1]).trim() : '';
  if (!name) return null;

  // Ingredienti da lista
  const ingMatches = [...html.matchAll(/<dd[^>]*class="[^"]*gz-ingredient[^"]*"[^>]*>([\s\S]*?)<\/dd>/gi)];
  const ingredients = ingMatches.map(m => parseIngredientString(stripHtml(m[1]).trim())).filter(i => i.raw);

  // Istruzioni
  const stepMatches = [...html.matchAll(/<div[^>]*class="[^"]*gz-content-recipe-step[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
  const instructions = stepMatches.map(m => stripHtml(m[1]).trim()).filter(Boolean);

  // Immagine
  const imgMatch = html.match(/property="og:image"\s+content="([^"]+)"/i);
  const image    = imgMatch?.[1] || '';

  return { name, description: '', image, prepTime: null, servings: 1, ingredients, instructions, keywords: '' };
}

// ── Parser ingredienti ────────────────────────────────────
function parseIngredientString(raw: string): { raw: string; name: string; amount_g: number; unit: string } {
  raw = raw.trim().replace(/\s+/g, ' ');

  // Pattern: numero [unità] nome   (es. "200 g petto di pollo", "2 uova", "q.b. sale")
  const patterns = [
    // "200 g pollo"  "100ml latte"
    /^(\d+[\.,]?\d*)\s*(g|gr|grammi|kg|ml|cl|dl|l|litri|cucchiai?|cucchiaini?|tazze?|spicchi?|foglie?|rametti?|pizzichi?|mazzetti?)\.?\s+(.+)$/i,
    // "2 uova"  "3 pomodori"
    /^(\d+[\.,]?\d*)\s+(.+)$/i,
    // "q.b. sale"  "sale q.b."
    /^(q\.?b\.?)\s+(.+)$|^(.+)\s+(q\.?b\.?)$/i,
  ];

  for (const pat of patterns) {
    const m = raw.match(pat);
    if (m) {
      if (pat.source.includes('q.b')) {
        const name = (m[2] || m[3] || '').trim();
        return { raw, name, amount_g: 5, unit: 'q.b.' };
      }
      const amt  = parseFloat((m[1] || '0').replace(',', '.'));
      const unit = (m[2] || 'pz').toLowerCase().trim();
      const name = (m[3] || m[2] || '').trim();
      const grams = convertToGrams(amt, unit, name);
      return { raw, name, amount_g: grams, unit };
    }
  }

  return { raw, name: raw, amount_g: 100, unit: 'g' };
}

function convertToGrams(amt: number, unit: string, ingredient: string): number {
  const WEIGHTS: Record<string, number> = {
    g: 1, gr: 1, grammi: 1,
    kg: 1000,
    ml: 1, cl: 10, dl: 100, l: 1000, litri: 1000,
    cucchiaio: 15, cucchiai: 15, cucchiaino: 5, cucchiaini: 5,
    tazza: 240, tazze: 240,
    spicchio: 5, spicchi: 5,
    foglia: 2, foglie: 2,
    rametto: 3, rametti: 3,
    pizzico: 1, pizzichi: 1,
    mazzetto: 30, mazzetti: 30,
  };
  // Per unità peso/volume usa il fattore diretto
  const factor = WEIGHTS[unit.replace(/\.$/, '')] || 0;
  if (factor) return Math.round(amt * factor);

  // Per pz (pezzi), stima in base all'ingrediente
  const PZ: Record<string, number> = {
    uovo: 55, uova: 55, 'limone': 80, 'arancia': 150, 'mela': 150,
    'banana': 120, 'carota': 80, 'cipolla': 100, 'pomodoro': 150,
    'zucchina': 150, 'peperone': 180, 'patata': 150, 'melanzana': 250,
  };
  const ingLow = ingredient.toLowerCase();
  for (const [key, w] of Object.entries(PZ)) {
    if (ingLow.includes(key)) return Math.round(amt * w);
  }
  return Math.round(amt * 80); // default pezzo ~80g
}

function parseDuration(iso: string): number | null {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  return (parseInt(m[1] || '0') * 60) + parseInt(m[2] || '0');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

function guessMealType(name: string, keywords: string): string[] {
  const text = (name + ' ' + keywords).toLowerCase();
  const types: string[] = [];
  if (/colazion|cereali|yogurt|muesli|porridge|pancake|crepe|toast|brioche|cornetto/.test(text)) types.push('colazione');
  if (/spuntino|merenda|snack|gallette|barretta/.test(text)) types.push('spuntino');
  if (/pranzo|pasta|risotto|zuppa|minestra|insalata|primo|piatto unico/.test(text)) types.push('pranzo');
  if (/cena|secondo|pesce|carne|arrosto|pollo|salmone|bistecca/.test(text)) types.push('cena');
  if (!types.length) return ['pranzo', 'cena'];
  return types;
}

// ── Match ingredienti con DB INRAN ────────────────────────
async function matchIngredients(supabase: any, ingredients: any[]) {
  const enriched = [];
  for (const ing of ingredients) {
    // Cerca nel DB INRAN con query parziale sul nome
    const words = ing.name.toLowerCase()
      .replace(/di\s+/g, '').replace(/con\s+/g, '').replace(/e\s+/g, ' ')
      .split(' ').filter((w: string) => w.length > 3).slice(0, 2);

    let match = null;
    for (const word of words) {
      const { data } = await supabase
        .from('food_items')
        .select('id, name, kcal, proteine, carboidrati, grassi')
        .ilike('name', `%${word}%`)
        .limit(1)
        .single();
      if (data) { match = data; break; }
    }

    enriched.push({
      raw:          ing.raw,
      name:         ing.name,
      amount_g:     ing.amount_g,
      unit:         ing.unit,
      food_item_id: match?.id || null,
      kcal:         match?.kcal        || estimateKcal(ing.name),
      proteine:     match?.proteine    || 0,
      carboidrati:  match?.carboidrati || 0,
      grassi:       match?.grassi      || 0,
      matched:      !!match,
      inran_name:   match?.name || null,
    });
  }
  return enriched;
}

function estimateKcal(name: string): number {
  const n = name.toLowerCase();
  if (/olio|burro/.test(n)) return 900;
  if (/carne|pollo|pesce|tacchino|manzo/.test(n)) return 150;
  if (/pasta|riso|farro|pane|farina/.test(n)) return 350;
  if (/latte|yogurt/.test(n)) return 60;
  if (/formaggio|parmigiano/.test(n)) return 380;
  if (/uov/.test(n)) return 130;
  if (/legum|ceci|fagioli|lenticchie/.test(n)) return 120;
  if (/verdur|zucch|carota|spinac/.test(n)) return 25;
  if (/frutta|mela|banana|arancia/.test(n)) return 55;
  return 50;
}

function calcNutrition(ingredients: any[]) {
  return ingredients.reduce((t, i) => {
    const f = i.amount_g / 100;
    return {
      kcal:        Math.round(t.kcal        + (i.kcal        || 0) * f),
      proteine:    Math.round((t.proteine    + (i.proteine    || 0) * f) * 10) / 10,
      carboidrati: Math.round((t.carboidrati + (i.carboidrati || 0) * f) * 10) / 10,
      grassi:      Math.round((t.grassi      + (i.grassi      || 0) * f) * 10) / 10,
    };
  }, { kcal: 0, proteine: 0, carboidrati: 0, grassi: 0 });
}
