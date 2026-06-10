#!/usr/bin/env bash
#
# QA an Elastic Agent Builder agent through LAP, end to end:
#   1. register the Elastic credential on the elastic_agent_builder runtime
#   2. create a LAP agent bound to your existing Elastic agent
#   3. create a session + send a first prompt (runs + streams synchronously)
#   4. print the transcript and the captured Elastic conversation_id
#   5. send a second prompt and confirm the same conversation_id is reused
#
# Requirements: bash, curl, jq. LAP must be running with the
# elastic_agent_builder branch built.
#
# Fill these in (env vars override the defaults):
#   KIBANA_URL         Kibana endpoint, e.g. https://<id>.kb.us-east-1.aws.elastic.cloud
#   ELASTIC_API_KEY    Kibana API key (the encoded value)
#   ELASTIC_AGENT_ID   id of your existing Elastic Agent Builder agent
#   ELASTIC_SPACE      Kibana space (default: "default")
#   LAP_URL            LAP gateway base (default: http://localhost:4096)
#   LAP_MASTER_KEY     LAP master key (Bearer)
#
# Usage:
#   KIBANA_URL=... ELASTIC_API_KEY=... ELASTIC_AGENT_ID=... LAP_MASTER_KEY=... ./scripts/qa_elastic.sh

set -euo pipefail

# ---- config ----------------------------------------------------------------
KIBANA_URL="${KIBANA_URL:?set KIBANA_URL (Kibana endpoint, e.g. https://<id>.kb.<region>.<csp>.elastic.cloud)}"
ELASTIC_API_KEY="${ELASTIC_API_KEY:?set ELASTIC_API_KEY (encoded Kibana API key)}"
ELASTIC_AGENT_ID="${ELASTIC_AGENT_ID:?set ELASTIC_AGENT_ID (your existing Elastic agent id)}"
ELASTIC_SPACE="${ELASTIC_SPACE:-default}"
LAP_URL="${LAP_URL:-http://localhost:4096}"
LAP_MASTER_KEY="${LAP_MASTER_KEY:?set LAP_MASTER_KEY (LAP gateway master key)}"

PROMPT1="${PROMPT1:-What can you help me with? List any indices or tools you can see.}"
PROMPT2="${PROMPT2:-Summarize what you just told me in one sentence.}"

KIBANA_URL="${KIBANA_URL%/}"   # strip trailing slash
LAP_URL="${LAP_URL%/}"

lap()  { curl -fsS -H "Authorization: Bearer $LAP_MASTER_KEY" "$@"; }
hr()   { printf '\n=== %s ===\n' "$1"; }

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

# ---- 0. sanity: hit Kibana directly so we fail fast on bad creds/agent -------
hr "0. verify Elastic agent is reachable directly"
if curl -fsS "$KIBANA_URL/api/agent_builder/agents" \
      -H "Authorization: ApiKey $ELASTIC_API_KEY" -H "kbn-xsrf: true" \
      | jq -e --arg id "$ELASTIC_AGENT_ID" \
        '(.results // .agents // .) | (if type=="array" then . else [] end) | any(.id == $id)' \
      >/dev/null 2>&1; then
  echo "OK: agent '$ELASTIC_AGENT_ID' visible in Kibana"
else
  echo "WARN: could not confirm agent '$ELASTIC_AGENT_ID' via /api/agent_builder/agents."
  echo "      (Continuing anyway — your Kibana version's list shape may differ.)"
fi

# ---- 1. register the Elastic credential on the runtime -----------------------
hr "1. register elastic_agent_builder credential"
lap -X PUT "$LAP_URL/api/agent-runtimes/elastic_agent_builder/credentials" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg k "$ELASTIC_API_KEY" --arg b "$KIBANA_URL" \
        '{api_key:$k, api_base:$b}')" \
  | jq '.runtimes[] | select(.id=="elastic_agent_builder") | {id,connected,api_base,masked_api_key}'

# ---- 2. create a LAP agent bound to the Elastic agent ------------------------
hr "2. create LAP agent bound to Elastic agent"
AGENT_ID="$(lap -X POST "$LAP_URL/api/agents" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg name "Elastic QA $(date +%s)" \
        --arg agent "$ELASTIC_AGENT_ID" \
        --arg space "$ELASTIC_SPACE" \
        '{
           name: $name,
           owner_id: "qa",
           runtime: "elastic_agent_builder",
           config: {
             runtime: "elastic_agent_builder",
             elastic_agent_id: $agent,
             elastic_space_id: $space
           }
         }')" \
  | jq -r '.id')"
echo "LAP agent id: $AGENT_ID"

# ---- 3. create a session + first prompt (runs synchronously) -----------------
hr "3. create session + first prompt"
SESSION_ID="$(lap -X POST "$LAP_URL/session" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg a "$AGENT_ID" --arg p "$PROMPT1" \
        '{runtime:"elastic_agent_builder", agent_id:$a, prompt:$p}')" \
  | tee /tmp/lap_session.json | jq -r '.id // .session.id // empty')"
jq '{id, status, provider_run_id}' /tmp/lap_session.json 2>/dev/null || cat /tmp/lap_session.json
echo "session id: $SESSION_ID"
[ -n "$SESSION_ID" ] || { echo "no session id returned"; exit 1; }

# ---- 4. transcript + captured conversation_id --------------------------------
hr "4a. assistant transcript (turn 1)"
lap "$LAP_URL/session/$SESSION_ID/messages" \
  | jq -r '.[] | "\(.role): \((.content // .text // "") | tostring[0:400])"' 2>/dev/null \
  || lap "$LAP_URL/session/$SESSION_ID/messages" | jq .

hr "4b. captured Elastic conversation_id"
CONV1="$(lap "$LAP_URL/session/$SESSION_ID" | jq -r '.provider_run_id // empty')"
echo "provider_run_id after turn 1: '${CONV1:-<none>}'"
if [ -z "$CONV1" ] || [ "$CONV1" = "elastic_pending" ]; then
  echo "WARN: no real conversation_id captured. The SSE event names from your"
  echo "      Kibana version probably differ from the normalizer's expectations."
  echo "      Run the direct converse call (step 0 area) and share the 'type:' fields."
fi

# ---- 5. second turn -> continuity --------------------------------------------
hr "5. second prompt (should continue the same Elastic conversation)"
lap -X POST "$LAP_URL/session/$SESSION_ID/prompt_async" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$PROMPT2" '{prompt:$p}')" >/dev/null || true
sleep 3

hr "5a. transcript (after turn 2)"
lap "$LAP_URL/session/$SESSION_ID/messages" \
  | jq -r '.[] | "\(.role): \((.content // .text // "") | tostring[0:400])"' 2>/dev/null \
  || lap "$LAP_URL/session/$SESSION_ID/messages" | jq .

CONV2="$(lap "$LAP_URL/session/$SESSION_ID" | jq -r '.provider_run_id // empty')"
hr "result"
echo "conversation_id turn1: '${CONV1:-<none>}'"
echo "conversation_id turn2: '${CONV2:-<none>}'"
if [ -n "$CONV1" ] && [ "$CONV1" = "$CONV2" ]; then
  echo "PASS: same conversation_id reused across turns."
else
  echo "CHECK: conversation_id changed or empty — inspect events above."
fi

hr "raw events (last 40)"
lap "$LAP_URL/v1/sessions/$SESSION_ID/events" | jq '.[-40:] // .' 2>/dev/null || true
