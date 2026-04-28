-- Nutrì – Schema Supabase
-- Esegui questo file nel SQL Editor del dashboard Supabase

-- Estensione UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────
-- PROFILES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  full_name TEXT,
  age INTEGER CHECK (age BETWEEN 10 AND 120),
  sex TEXT CHECK (sex IN ('M', 'F')),
  weight DECIMAL(5,1) CHECK (weight BETWEEN 20 AND 500),
  height INTEGER CHECK (height BETWEEN 50 AND 280),
  activity_level TEXT CHECK (activity_level IN ('sedentario','leggero','moderato','attivo','atleta')),
  goal TEXT CHECK (goal IN ('dimagrire','mantenere','aumentare')),
  diet_type TEXT CHECK (diet_type IN ('standard','vegetariana','vegana')),
  meal_schedule TEXT CHECK (meal_schedule IN ('standard','intermittente_colazione','intermittente_pranzo')),
  allergies JSONB DEFAULT '[]',
  dislikes JSONB DEFAULT '[]',
  bmr DECIMAL(8,2),
  tdee DECIMAL(8,2),
  target_calories DECIMAL(8,2),
  bmi DECIMAL(5,2),
  current_plan JSONB,
  plan_generated_at TIMESTAMPTZ,
  onboarding_complete BOOLEAN DEFAULT FALSE,
  is_admin BOOLEAN DEFAULT FALSE
);

-- ─────────────────────────────────────────
-- RECIPES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recipes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  name TEXT NOT NULL,
  description TEXT,
  meal_type TEXT[] NOT NULL,
  diet_type TEXT[] NOT NULL,
  calories INTEGER NOT NULL CHECK (calories > 0),
  macros JSONB NOT NULL,
  prep_time INTEGER,
  servings INTEGER DEFAULT 1,
  ingredients JSONB NOT NULL,
  instructions JSONB NOT NULL,
  tags TEXT[] DEFAULT '{}',
  allergens TEXT[] DEFAULT '{}',
  image_url TEXT,
  source_url TEXT,
  is_active BOOLEAN DEFAULT TRUE
);

-- ─────────────────────────────────────────
-- WEIGHT LOGS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weight_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  weight DECIMAL(5,1) NOT NULL CHECK (weight BETWEEN 20 AND 500),
  logged_at DATE DEFAULT CURRENT_DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- EXCLUDED RECIPES (per utente)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS excluded_recipes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  recipe_id UUID REFERENCES recipes ON DELETE CASCADE NOT NULL,
  excluded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, recipe_id)
);

-- ─────────────────────────────────────────
-- CONFIRMED MEALS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS confirmed_meals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  plan_date DATE NOT NULL,
  meal_slot TEXT NOT NULL CHECK (meal_slot IN ('colazione','pranzo','cena','spuntino')),
  recipe_id UUID REFERENCES recipes ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, plan_date, meal_slot)
);

-- ─────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_recipes_meal_type ON recipes USING GIN (meal_type);
CREATE INDEX IF NOT EXISTS idx_recipes_diet_type ON recipes USING GIN (diet_type);
CREATE INDEX IF NOT EXISTS idx_recipes_active ON recipes (is_active);
CREATE INDEX IF NOT EXISTS idx_weight_logs_user ON weight_logs (user_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_confirmed_meals_user ON confirmed_meals (user_id, plan_date);
CREATE INDEX IF NOT EXISTS idx_excluded_user ON excluded_recipes (user_id);

-- ─────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE excluded_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmed_meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;

-- Profiles
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Weight logs
CREATE POLICY "weight_all" ON weight_logs FOR ALL USING (auth.uid() = user_id);

-- Excluded recipes
CREATE POLICY "excluded_all" ON excluded_recipes FOR ALL USING (auth.uid() = user_id);

-- Confirmed meals
CREATE POLICY "confirmed_all" ON confirmed_meals FOR ALL USING (auth.uid() = user_id);

-- Recipes: tutti leggono; solo admin scrivono
CREATE POLICY "recipes_select" ON recipes FOR SELECT USING (is_active = TRUE);
CREATE POLICY "recipes_admin_all" ON recipes FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ─────────────────────────────────────────
-- TRIGGER: crea profilo al signup
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO profiles (id) VALUES (NEW.id) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- TRIGGER: aggiorna updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER recipes_updated_at BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────
-- MIGRATION v2: scaling dinamico
-- Esegui nel SQL Editor di Supabase
-- ─────────────────────────────────────────

-- Colonne per potenziale calorico pre-calcolato
ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS kcal_min_scaled INTEGER,
  ADD COLUMN IF NOT EXISTS kcal_max_scaled INTEGER;

-- Unique constraint su name per permettere upsert dal seed
ALTER TABLE recipes
  DROP CONSTRAINT IF EXISTS recipes_name_key;
ALTER TABLE recipes
  ADD CONSTRAINT recipes_name_key UNIQUE (name);
