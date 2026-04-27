# Nutrì — Setup Guide

## 1. Supabase — Schema DB
Apri il progetto Supabase → SQL Editor → incolla ed esegui il contenuto di `schema.sql`.

## 2. Supabase — Anon Key
Nel dashboard Supabase → Settings → API, copia la **anon public key**.
Sostituisci `PLACEHOLDER_ANON_KEY` in questi file:
- `js/supabase.js` (riga SUPABASE_ANON_KEY)
- `admin.html` (riga SUPABASE_ANON_KEY)

## 3. Carica le ricette
Apri `admin.html`, accedi con il tuo account admin, poi clicca **"⬆ Carica ricette iniziali"**.
Per impostare il flag admin sul tuo account:
```sql
UPDATE profiles SET is_admin = true WHERE id = 'TUO-USER-ID';
```

## 4. GitHub Pages
Nel repository GitHub → Settings → Pages → Source: **Deploy from branch** → `main` → `/ (root)`.
Il sito sarà disponibile su: `https://fabiom277.github.io/nutri/`

## 5. Stack tecnico
- **Frontend**: HTML/CSS/JS puro, ES Modules
- **Backend/DB**: Supabase (PostgreSQL + Auth + RLS)
- **Hosting**: GitHub Pages
- **Ricette**: 71 ricette italiane da GialloZafferano e fonti similari
