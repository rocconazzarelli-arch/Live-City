#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEGACY_ENV="/Users/rocconazzarelli/Desktop/SECRET PROJECT/live-city code/.env"
TEMP_SECRETS="$(mktemp)"
TEMP_VAULT_SQL="$(mktemp)"
trap 'rm -f "$TEMP_SECRETS" "$TEMP_VAULT_SQL"' EXIT
chmod 600 "$TEMP_SECRETS" "$TEMP_VAULT_SQL"

cd "$ROOT_DIR"

read -r -p "Nuovo Supabase project ref: " PROJECT_REF
read -r -p "Supabase publishable key: " PUBLISHABLE_KEY

FSQ_KEY=""
if [[ -f "$LEGACY_ENV" ]]; then
  FSQ_KEY="$(sed -n 's/^EXPO_PUBLIC_FSQ_API_KEY=//p' "$LEGACY_ENV" | head -n 1)"
fi
if [[ -z "$FSQ_KEY" ]]; then
  read -r -p "Foursquare public API key: " FSQ_KEY
else
  echo "Riutilizzo la chiave Foursquare pubblica già presente sul Mac."
fi

read -r -s -p "BestTime private API key (non sarà mostrata): " BESTTIME_KEY
echo

if [[ -z "$PROJECT_REF" || -z "$PUBLISHABLE_KEY" || -z "$FSQ_KEY" || -z "$BESTTIME_KEY" ]]; then
  echo "Configurazione incompleta: nessun campo può essere vuoto." >&2
  exit 1
fi

PIPELINE_SECRET="$(openssl rand -hex 32)"
ENGINE_SECRET="$(openssl rand -hex 32)"
LOCATION_SALT="$(openssl rand -hex 32)"
PROJECT_URL="https://${PROJECT_REF}.supabase.co"

umask 077
printf '%s\n' \
  "EXPO_PUBLIC_FSQ_API_KEY=${FSQ_KEY}" \
  "EXPO_PUBLIC_SUPABASE_URL=${PROJECT_URL}" \
  "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE_KEY}" \
  "EXPO_PUBLIC_ENABLE_DEMO_HEATMAP=false" > .env

printf '%s\n' \
  "BESTTIME_PRIVATE_API_KEY=${BESTTIME_KEY}" \
  "CROWD_PIPELINE_SECRET=${PIPELINE_SECRET}" \
  "CROWD_ENGINE_REFRESH_SECRET=${ENGINE_SECRET}" \
  "LOCATION_SESSION_HASH_SALT=${LOCATION_SALT}" > "$TEMP_SECRETS"

echo "Collegamento al progetto Supabase. Inserire la password database quando richiesta."
npx supabase link --project-ref "$PROJECT_REF"

echo "Dry-run delle migration..."
npx supabase db push --remote --dry-run
read -r -p "Applicare le migration mostrate sopra? [y/N] " APPLY_MIGRATIONS
if [[ "$APPLY_MIGRATIONS" != "y" && "$APPLY_MIGRATIONS" != "Y" ]]; then
  echo "Interrotto prima di modificare il database."
  exit 1
fi
npx supabase db push --remote

echo "Configurazione dei secret Edge Functions..."
npx supabase secrets set --env-file "$TEMP_SECRETS"

printf "select vault.create_secret('%s', 'supabase_project_url');\n" "$PROJECT_URL" > "$TEMP_VAULT_SQL"
printf "select vault.create_secret('%s', 'crowd_pipeline_secret');\n" "$PIPELINE_SECRET" >> "$TEMP_VAULT_SQL"
npx supabase db query --remote --file "$TEMP_VAULT_SQL" --yes

echo "Deploy delle Edge Functions del test..."
npx supabase functions deploy --use-api \
  besttime-register \
  crowd-refresh \
  crowd-engine-refresh \
  weather-ingest \
  crowd-pipeline-refresh \
  places-read \
  places-discover \
  events-read \
  events-create \
  location-ingest \
  area-heatmap-read \
  app-health

echo "Popolamento del catalogo OpenStreetMap (nessun credito BestTime)..."
curl --fail --silent --show-error \
  -X POST "${PROJECT_URL}/functions/v1/places-discover" \
  -H "Content-Type: application/json" \
  -H "x-refresh-secret: ${PIPELINE_SECRET}"
echo

echo "Preflight BestTime della sola chiave (nessun forecast/live)..."
curl --fail --silent --show-error \
  -X POST "${PROJECT_URL}/functions/v1/besttime-register" \
  -H "Content-Type: application/json" \
  -H "x-refresh-secret: ${PIPELINE_SECRET}" \
  --data '{"action":"validate-key"}'
echo

echo "Health check applicazione..."
curl --fail --silent --show-error \
  "${PROJECT_URL}/functions/v1/app-health" \
  -H "Authorization: Bearer ${PUBLISHABLE_KEY}" \
  -H "apikey: ${PUBLISHABLE_KEY}"
echo

echo "Bootstrap completato. I cron provider restano spenti fino al runbook del test."
