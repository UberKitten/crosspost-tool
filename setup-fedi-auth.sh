#!/bin/bash
set -euo pipefail

ENV_FILE="${1:-.env}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_PATH="$SCRIPT_DIR/$ENV_FILE"

# Load existing .env if present
if [[ -f "$ENV_PATH" ]]; then
  source <(grep -E '^(FEDI_INSTANCE_URL|FEDI_CLIENT_ID|FEDI_CLIENT_SECRET|FEDI_ACCESS_TOKEN)=' "$ENV_PATH" | sed 's/^/export /')
fi

# Step 1: Get instance URL
if [[ -n "${FEDI_INSTANCE_URL:-}" ]]; then
  echo "Instance: $FEDI_INSTANCE_URL"
else
  read -rp "Fedi instance URL (e.g. https://social.example.com): " FEDI_INSTANCE_URL
fi
FEDI_INSTANCE_URL="${FEDI_INSTANCE_URL%/}"

# Step 2: Register app (or reuse existing)
if [[ -n "${FEDI_CLIENT_ID:-}" && -n "${FEDI_CLIENT_SECRET:-}" ]]; then
  echo "Reusing existing app (client_id: ${FEDI_CLIENT_ID:0:8}...)"
else
  echo "Registering app..."
  RESPONSE=$(curl -sf -X POST "$FEDI_INSTANCE_URL/api/v1/apps" \
    -d "client_name=Crosspost" \
    -d "redirect_uris=urn:ietf:wg:oauth:2.0:oob" \
    -d "scopes=write:statuses write:media read:statuses")

  FEDI_CLIENT_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_id'])")
  FEDI_CLIENT_SECRET=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_secret'])")
  echo "App registered (client_id: ${FEDI_CLIENT_ID:0:8}...)"
fi

# Step 3: Authorize
AUTH_URL="$FEDI_INSTANCE_URL/oauth/authorize?client_id=$FEDI_CLIENT_ID&response_type=code&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=write:statuses%20write:media%20read:statuses"

echo ""
echo "Opening authorization page..."
echo "$AUTH_URL"
echo ""

# Try to open in browser
if command -v open &>/dev/null; then
  open "$AUTH_URL"
elif command -v xdg-open &>/dev/null; then
  xdg-open "$AUTH_URL"
fi

read -rp "Paste the authorization code here: " AUTH_CODE

# Step 4: Exchange code for token
echo "Exchanging code for token..."
TOKEN_RESPONSE=$(curl -sf -X POST "$FEDI_INSTANCE_URL/oauth/token" \
  -d "client_id=$FEDI_CLIENT_ID" \
  -d "client_secret=$FEDI_CLIENT_SECRET" \
  -d "grant_type=authorization_code" \
  -d "code=$AUTH_CODE" \
  -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob")

FEDI_ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

if [[ -z "$FEDI_ACCESS_TOKEN" ]]; then
  echo "ERROR: Failed to get access token"
  echo "$TOKEN_RESPONSE"
  exit 1
fi

echo "Got access token: ${FEDI_ACCESS_TOKEN:0:8}..."

# Step 5: Write to .env
# Update or append each key
update_env() {
  local key="$1" val="$2"
  if [[ -f "$ENV_PATH" ]] && grep -q "^${key}=" "$ENV_PATH"; then
    # Use a temp file for atomic replace
    sed "s|^${key}=.*|${key}=${val}|" "$ENV_PATH" > "$ENV_PATH.tmp"
    mv "$ENV_PATH.tmp" "$ENV_PATH"
  else
    echo "${key}=${val}" >> "$ENV_PATH"
  fi
}

update_env "FEDI_INSTANCE_URL" "$FEDI_INSTANCE_URL"
update_env "FEDI_CLIENT_ID" "$FEDI_CLIENT_ID"
update_env "FEDI_CLIENT_SECRET" "$FEDI_CLIENT_SECRET"
update_env "FEDI_ACCESS_TOKEN" "$FEDI_ACCESS_TOKEN"

echo ""
echo "Done! Updated $ENV_PATH"

# Step 6: Verify
echo "Verifying token..."
VERIFY=$(curl -sf -H "Authorization: Bearer $FEDI_ACCESS_TOKEN" "$FEDI_INSTANCE_URL/api/v1/apps/verify_credentials" 2>&1) || true
if echo "$VERIFY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name',''))" 2>/dev/null | grep -q "Crosspost"; then
  echo "Verified! App: Crosspost"
else
  echo "Warning: Could not verify token (may still work)"
fi
