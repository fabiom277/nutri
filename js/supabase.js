// ── Nutrì — supabase.js ──────────────────────────────
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://ynaaksvbfrlraqdwnvea.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluYWFrc3ZiZnJscmFxZHdudmVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyMjgxMTQsImV4cCI6MjA5MjgwNDExNH0.-QGrwtUS0O9Wu8vtUuSMiKiZQH2p-aH8gVFoDgoTFQg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Auth ──────────────────────────────────────────────

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

// ── Profile ───────────────────────────────────────────

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function upsertProfile(userId, updates) {
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: userId, ...updates, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Recipes ───────────────────────────────────────────

export async function getAllRecipes() {
  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function upsertRecipe(recipe) {
  const { data, error } = await supabase
    .from('recipes')
    .upsert(recipe)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteRecipe(id) {
  const { error } = await supabase
    .from('recipes')
    .update({ is_active: false })
    .eq('id', id);
  if (error) throw error;
}

// ── Excluded recipes ──────────────────────────────────

export async function getExcludedIds(userId) {
  const { data, error } = await supabase
    .from('excluded_recipes')
    .select('recipe_id')
    .eq('user_id', userId);
  if (error) throw error;
  return (data || []).map(r => r.recipe_id);
}

export async function excludeRecipe(userId, recipeId) {
  const { error } = await supabase
    .from('excluded_recipes')
    .upsert({ user_id: userId, recipe_id: recipeId });
  if (error) throw error;
}

// ── Confirmed meals ───────────────────────────────────

export async function getConfirmedMeals(userId, fromDate, toDate) {
  const { data, error } = await supabase
    .from('confirmed_meals')
    .select('*, recipes(*)')
    .eq('user_id', userId)
    .gte('plan_date', fromDate)
    .lte('plan_date', toDate);
  if (error) throw error;
  return data || [];
}

export async function confirmMeal(userId, planDate, mealSlot, recipeId, scaledCalories = null) {
  const { data, error } = await supabase
    .from('confirmed_meals')
    .upsert({
      user_id: userId,
      plan_date: planDate,
      meal_slot: mealSlot,
      recipe_id: recipeId,
      ...(scaledCalories !== null ? { scaled_calories: scaledCalories } : {})
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function unconfirmMeal(userId, planDate, mealSlot) {
  const { error } = await supabase
    .from('confirmed_meals')
    .delete()
    .eq('user_id', userId)
    .eq('plan_date', planDate)
    .eq('meal_slot', mealSlot);
  if (error) throw error;
}

// ── Weight logs ───────────────────────────────────────

export async function getWeightLogs(userId) {
  const { data, error } = await supabase
    .from('weight_logs')
    .select('*')
    .eq('user_id', userId)
    .order('logged_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addWeightLog(userId, weight, notes = '') {
  const { data, error } = await supabase
    .from('weight_logs')
    .insert({ user_id: userId, weight, notes })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteWeightLog(id) {
  const { error } = await supabase.from('weight_logs').delete().eq('id', id);
  if (error) throw error;
}

// ── Recipe ratings ────────────────────────────────────

export async function getRatings(userId) {
  const { data, error } = await supabase
    .from('recipe_ratings')
    .select('recipe_id, rating')
    .eq('user_id', userId);
  if (error) throw error;
  // { recipeId: 1 | -1 }
  return Object.fromEntries((data || []).map(r => [r.recipe_id, r.rating]));
}

export async function setRating(userId, recipeId, rating) {
  if (rating === 0) {
    await supabase.from('recipe_ratings').delete()
      .eq('user_id', userId).eq('recipe_id', recipeId);
    return;
  }
  const { error } = await supabase.from('recipe_ratings')
    .upsert({ user_id: userId, recipe_id: recipeId, rating });
  if (error) throw error;
}

// ── Push subscriptions ────────────────────────────────

export async function savePushSubscription(userId, subscription) {
  const sub = subscription.toJSON();
  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: userId,
    endpoint: sub.endpoint,
    keys: sub.keys,
  });
  if (error) throw error;
}

// ── INRAN Food Items ──────────────────────────────────

export async function searchFoodItems(query, limit = 20) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('food_items')
    .select('*')
    .ilike('name', `%${q}%`)
    .eq('is_active', true)
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function getFoodItemsByCategory(category) {
  const { data, error } = await supabase
    .from('food_items')
    .select('*')
    .eq('category', category)
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data || [];
}

// ── User Recipes ──────────────────────────────────────

export async function getUserRecipes(userId) {
  const { data, error } = await supabase
    .from('user_recipes')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveUserRecipe(userId, recipe) {
  const { data, error } = await supabase
    .from('user_recipes')
    .upsert({ ...recipe, user_id: userId, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteUserRecipe(id) {
  const { error } = await supabase
    .from('user_recipes')
    .delete()
    .eq('id', id);
  if (error) throw error;
}
