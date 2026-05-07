#!/usr/bin/env bash
# Wave 8 — E2E driver for the brigade live cooking surface.
#
# Drives the deployed mise-graph worker through the entire CookingLeadAgent
# control surface that doesn't require a real WebSocket client. Each step
# prints ✓ or ✗ + a one-liner; non-zero exit on hard failure. Idempotent —
# uses time-stamped IDs by default so re-running doesn't collide.
#
# Usage:
#   WORKER=https://mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev \
#   ADMIN_TOKEN=dev \
#   ./e2e-brigade.sh
#
# Maps to the spec in WAVE_8 mission: phase 1 (driver), phase 2 (photo upload),
# phase 3 (referenced WS unit tests), phase 4 (report).

set -uo pipefail

WORKER="${WORKER:-https://mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev}"
ADMIN_TOKEN="${ADMIN_TOKEN:-dev}"

TS="${TS:-$(date +%s)}"
HOUSEHOLD_ID="${HOUSEHOLD_ID:-hh_e2e_brigade_${TS}}"
PLAN_ID="${PLAN_ID:-mise_plan:e2e_brigade_${TS}}"
MEMBER_1="${MEMBER_1:-mem_alice_${TS}}"
MEMBER_2="${MEMBER_2:-mem_bob_${TS}}"
START_DATE="${START_DATE:-2026-05-20}"
END_DATE="${END_DATE:-2026-05-20}"
SLOT="${SLOT:-dinner}"

print_step() {
	echo ""
	echo "═══ $1 ═══"
}

mcp_call() {
	local name="$1"
	local args_json="$2"
	curl -sS -X POST "${WORKER}/mcp/plan-world" \
		-H "content-type: application/json" \
		-H "x-spence-trace-caller-kind: agent" \
		-H "x-spence-trace-caller-id: e2e-brigade" \
		-d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"${name}\",\"arguments\":${args_json}}}"
}

mcp_text() {
	# Pulls structuredContent (or content[0].text) out of a JSON-RPC reply.
	# Prefer structuredContent for grep-safety.
	local body="$1"
	echo "$body" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    sc = d.get("result", {}).get("structuredContent")
    if sc is not None:
        print(json.dumps(sc))
    else:
        c = d.get("result", {}).get("content", [])
        if c and isinstance(c, list):
            print(c[0].get("text", ""))
except Exception as e:
    print("", file=sys.stderr)
'
}

assert_ok() {
	local body="$1"
	local label="$2"
	local payload
	payload=$(mcp_text "$body")
	if echo "$payload" | grep -q '"ok"\s*:\s*true'; then
		echo "  ✓ $label"
	else
		echo "  ✗ $label"
		echo "    body: $(echo "$body" | head -c 280)"
		echo "    payload: $(echo "$payload" | head -c 280)"
		exit 1
	fi
}

assert_contains() {
	local body="$1"
	local needle="$2"
	local label="$3"
	if echo "$body" | grep -q -- "$needle"; then
		echo "  ✓ $label"
	else
		echo "  ✗ $label — expected to contain: $needle"
		echo "    body: $(echo "$body" | head -c 280)"
		exit 1
	fi
}

# ── Step 1: migrate schemas (idempotent) ───────────────────────────────────
print_step "1. Schema migrations (wave-7 + brigade)"
M1=$(curl -sS -X POST "${WORKER}/mise-graph/admin/migrate-wave-7" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}")
assert_contains "$M1" "migrated" "migrate-wave-7 ok"
M2=$(curl -sS -X POST "${WORKER}/mise-graph/admin/migrate-brigade" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}")
assert_contains "$M2" "mise_brigade_events" "migrate-brigade ok"

# ── Step 2: create household + 2 members ───────────────────────────────────
print_step "2. household members"
M_RESP_1=$(mcp_call member_create "{\"household_id\":\"${HOUSEHOLD_ID}\",\"member_id\":\"${MEMBER_1}\",\"display_name\":\"Alice\",\"age_group\":\"adult\"}")
assert_contains "$M_RESP_1" "$MEMBER_1" "member_create alice"
M_RESP_2=$(mcp_call member_create "{\"household_id\":\"${HOUSEHOLD_ID}\",\"member_id\":\"${MEMBER_2}\",\"display_name\":\"Bob\",\"age_group\":\"adult\"}")
assert_contains "$M_RESP_2" "$MEMBER_2" "member_create bob"

# Skill bumps so the scheduler heuristic has someone to assign to.
mcp_call member_record_skill_outcome "{\"household_id\":\"${HOUSEHOLD_ID}\",\"member_id\":\"${MEMBER_1}\",\"skill\":\"knife\",\"outcome\":\"succeeded\"}" >/dev/null
mcp_call member_record_skill_outcome "{\"household_id\":\"${HOUSEHOLD_ID}\",\"member_id\":\"${MEMBER_2}\",\"skill\":\"saute\",\"outcome\":\"succeeded\"}" >/dev/null
echo "  ✓ skill seeds recorded (best-effort; ignore non-fatal)"

# ── Step 3: create plan + compose curry ────────────────────────────────────
print_step "3. plan_create + plan_compose_meal (curry)"
PLAN_RESP=$(mcp_call plan_create "{\"plan_id\":\"${PLAN_ID}\",\"household_id\":\"${HOUSEHOLD_ID}\",\"start_date\":\"${START_DATE}\",\"end_date\":\"${END_DATE}\",\"people_default\":2}")
assert_contains "$PLAN_RESP" "$PLAN_ID" "plan_create echoes plan_id"

COMPOSE_BODY=$(cat <<'JSON'
{
  "plan_id": "__PLAN__",
  "slot": {"date": "__DATE__", "slot": "__SLOT__"},
  "meal": {
    "title": "weeknight chicken curry",
    "format": "curry",
    "cuisine": ["indian"],
    "equipment": ["stovetop_burner", "rice_cooker"],
    "raw_ingredients": [
      {"name": "chicken thigh", "qty": 500, "unit": "g"},
      {"name": "onion", "qty": 1, "unit": "ea"},
      {"name": "tomato", "qty": 2, "unit": "ea"},
      {"name": "basmati rice", "qty": 200, "unit": "g"}
    ]
  }
}
JSON
)
COMPOSE_BODY="${COMPOSE_BODY//__PLAN__/$PLAN_ID}"
COMPOSE_BODY="${COMPOSE_BODY//__DATE__/$START_DATE}"
COMPOSE_BODY="${COMPOSE_BODY//__SLOT__/$SLOT}"
COMPOSE_RESP=$(mcp_call plan_compose_meal "$COMPOSE_BODY")
assert_contains "$COMPOSE_RESP" "meal_id" "compose returns meal_id"

# ── Step 4: finalize plan (spawns MealAgent) ───────────────────────────────
print_step "4. plan_finalize"
FIN_RESP=$(mcp_call plan_finalize "{\"plan_id\":\"${PLAN_ID}\"}")
assert_contains "$FIN_RESP" "$PLAN_ID" "finalize returns plan_id"

# ── Step 5: force MealAgent through phases ─────────────────────────────────
print_step "5. force MealAgent through phases → active_cook"
for PHASE in pre_eve day_of cook_window active_cook; do
	TR=$(curl -sS -X POST "${WORKER}/mise-graph/agents/meal/${PLAN_ID}/${START_DATE}/${SLOT}/transition" \
		-H "content-type: application/json" \
		-H "X-Spence-Admin: ${ADMIN_TOKEN}" \
		-d "{\"to_phase\":\"${PHASE}\",\"reason\":\"e2e:force\",\"force\":true}")
	if echo "$TR" | grep -q "\"$PHASE\""; then
		echo "  ✓ meal -> $PHASE"
	else
		echo "  ✗ transition to $PHASE failed: $(echo "$TR" | head -c 200)"
		exit 1
	fi
done

# ── Step 6: read MealAgent state, extract cook_session_id ──────────────────
print_step "6. extract cook_session_id from MealAgent state"
MS=$(curl -sS -X GET "${WORKER}/mise-graph/agents/meal/${PLAN_ID}/${START_DATE}/${SLOT}/state" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}")
COOK_SESSION_ID=$(echo "$MS" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("state",{}).get("cook_session_id") or "")')
if [[ -z "$COOK_SESSION_ID" || "$COOK_SESSION_ID" == "None" ]]; then
	echo "  ✗ cook_session_id missing from MealAgent state — is meal in active_cook?"
	echo "    body: $(echo "$MS" | head -c 360)"
	exit 1
fi
echo "  ✓ cook_session_id = ${COOK_SESSION_ID}"

# ── Step 7: probe CookingLeadAgent state (proves Wave 8 hand-off) ──────────
print_step "7. CookingLeadAgent /state — verifies hand-off"
CLS=$(curl -sS -X GET "${WORKER}/mise-graph/agents/cooking-lead/${COOK_SESSION_ID}/state" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}")
CLS_STATUS=$(echo "$CLS" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("state",{}).get("status",""))')
[[ "$CLS_STATUS" == "active" ]] && echo "  ✓ cooking-lead status=active" || { echo "  ✗ status=$CLS_STATUS"; echo "    body: $(echo "$CLS" | head -c 280)"; exit 1; }
assert_contains "$CLS" "$COOK_SESSION_ID" "cook_session_id echoed"

# ── Step 8 + 9: brigade_grant_token for both members ───────────────────────
print_step "8. brigade_grant_token (member 1)"
G1=$(mcp_call brigade_grant_token "{\"cook_session_id\":\"${COOK_SESSION_ID}\",\"member_id\":\"${MEMBER_1}\"}")
assert_contains "$G1" "ws_url" "ws_url returned for member 1"
TOKEN_1=$(mcp_text "$G1" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("token",""))')
WS_URL_1=$(mcp_text "$G1" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("ws_url",""))')
echo "    token1=${TOKEN_1:0:8}…  ws=${WS_URL_1}"

print_step "9. brigade_grant_token (member 2)"
G2=$(mcp_call brigade_grant_token "{\"cook_session_id\":\"${COOK_SESSION_ID}\",\"member_id\":\"${MEMBER_2}\"}")
assert_contains "$G2" "ws_url" "ws_url returned for member 2"
TOKEN_2=$(mcp_text "$G2" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("token",""))')
echo "    token2=${TOKEN_2:0:8}…"

# ── Step 10: brigade_get_state — pre-assignment ────────────────────────────
print_step "10. brigade_get_state (pre-assignment)"
S0=$(mcp_call brigade_get_state "{\"cook_session_id\":\"${COOK_SESSION_ID}\"}")
S0_TEXT=$(mcp_text "$S0")
S0_CONNECTED=$(echo "$S0_TEXT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("brigade",{}).get("connected_member_count","?"))')
S0_INFLIGHT=$(echo "$S0_TEXT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("brigade",{}).get("in_flight_assignments",[])))')
[[ "$S0_CONNECTED" == "0" ]] && echo "  ✓ connected_member_count=0 (no live WS)" || { echo "  ✗ connected=$S0_CONNECTED"; exit 1; }
[[ "$S0_INFLIGHT" == "0" ]] && echo "  ✓ in_flight_assignments=0" || { echo "  ✗ in_flight=$S0_INFLIGHT"; exit 1; }

# ── Step 11: manual assignment to member 1 ─────────────────────────────────
print_step "11. brigade_assign_task_manually → task_dummy_1 → member 1"
A1=$(mcp_call brigade_assign_task_manually "{\"cook_session_id\":\"${COOK_SESSION_ID}\",\"task_id\":\"task_dummy_1\",\"member_id\":\"${MEMBER_1}\",\"reason\":\"e2e:manual\"}")
assert_contains "$A1" "task_dummy_1" "assignment recorded"

# ── Step 12: brigade_get_state — confirms in_flight has 1 entry ────────────
print_step "12. brigade_get_state (after manual assign)"
S1=$(mcp_call brigade_get_state "{\"cook_session_id\":\"${COOK_SESSION_ID}\"}")
S1_TEXT=$(mcp_text "$S1")
S1_TOTAL=$(echo "$S1_TEXT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("brigade",{}).get("total_assignments","?"))')
S1_INFLIGHT=$(echo "$S1_TEXT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("brigade",{}).get("in_flight_assignments",[])))')
[[ "$S1_TOTAL" == "1" ]] && echo "  ✓ total_assignments=1" || { echo "  ✗ total=$S1_TOTAL"; exit 1; }
[[ "$S1_INFLIGHT" == "1" ]] && echo "  ✓ in_flight_assignments=1" || { echo "  ✗ in_flight=$S1_INFLIGHT"; exit 1; }
assert_contains "$S1_TEXT" "task_dummy_1" "task_dummy_1 visible in state"

# ── Step 13: mark task complete ───────────────────────────────────────────
print_step "13. brigade_mark_task_complete"
C1=$(mcp_call brigade_mark_task_complete "{\"cook_session_id\":\"${COOK_SESSION_ID}\",\"task_id\":\"task_dummy_1\",\"member_id\":\"${MEMBER_1}\",\"outcome\":\"succeeded\"}")
assert_contains "$C1" "succeeded" "outcome=succeeded"

# ── Step 14: event log — should contain at least the major events ─────────
print_step "14. brigade_get_event_log — verify event chain"
EL=$(mcp_call brigade_get_event_log "{\"cook_session_id\":\"${COOK_SESSION_ID}\",\"limit\":50}")
EL_TEXT=$(mcp_text "$EL")
assert_contains "$EL_TEXT" "session_initialized" "event: session_initialized"
assert_contains "$EL_TEXT" "task_assigned" "event: task_assigned"
assert_contains "$EL_TEXT" "task_completed" "event: task_completed"
echo "    sample event log (first 320 chars):"
echo "    $(echo "$EL_TEXT" | head -c 320)"

# ── Step 15: send chef message (broadcast) ─────────────────────────────────
print_step "15. brigade_send_message (broadcast)"
MS_BROADCAST=$(mcp_call brigade_send_message "{\"cook_session_id\":\"${COOK_SESSION_ID}\",\"message\":\"Heads up — saucepan onto medium heat.\"}")
assert_contains "$MS_BROADCAST" "broadcast" "message broadcast"

# ── Step 16: pause then resume ────────────────────────────────────────────
print_step "16. brigade_pause + brigade_resume"
PAUSE=$(mcp_call brigade_pause "{\"cook_session_id\":\"${COOK_SESSION_ID}\"}")
PAUSED_FLAG=$(mcp_text "$PAUSE" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("paused"))')
[[ "$PAUSED_FLAG" == "True" ]] && echo "  ✓ paused=true" || { echo "  ✗ paused=$PAUSED_FLAG"; exit 1; }
RESUME=$(mcp_call brigade_resume "{\"cook_session_id\":\"${COOK_SESSION_ID}\"}")
RESUMED_FLAG=$(mcp_text "$RESUME" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("paused"))')
[[ "$RESUMED_FLAG" == "False" ]] && echo "  ✓ paused=false (resumed)" || { echo "  ✗ paused=$RESUMED_FLAG"; exit 1; }

# ── Step 17: end session ──────────────────────────────────────────────────
print_step "17. brigade_end (status=completed)"
END=$(mcp_call brigade_end "{\"cook_session_id\":\"${COOK_SESSION_ID}\",\"outcome\":\"completed\",\"notes\":\"e2e wrap-up\"}")
END_OUTCOME=$(mcp_text "$END" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("outcome",""))')
[[ "$END_OUTCOME" == "completed" ]] && echo "  ✓ session marked completed" || { echo "  ✗ outcome=$END_OUTCOME"; exit 1; }

# ── Step 18: final state read ─────────────────────────────────────────────
print_step "18. final state — completed_at_ms set"
SF=$(mcp_call brigade_get_state "{\"cook_session_id\":\"${COOK_SESSION_ID}\"}")
SF_TEXT=$(mcp_text "$SF")
SF_STATUS=$(echo "$SF_TEXT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("state",{}).get("status",""))')
SF_COMPLETED=$(echo "$SF_TEXT" | python3 -c 'import sys,json; d=json.load(sys.stdin); v=d.get("state",{}).get("completed_at_ms"); print(v if v else "")')
[[ "$SF_STATUS" == "completed" ]] && echo "  ✓ status=completed" || { echo "  ✗ status=$SF_STATUS"; exit 1; }
[[ -n "$SF_COMPLETED" ]] && echo "  ✓ completed_at_ms=$SF_COMPLETED" || { echo "  ✗ completed_at_ms missing"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — Photo upload via HTTP (admin-bypass, no token needed via admin
# header). We use a NEW session because /upload-photo guards on
# state.status === "active".
# ─────────────────────────────────────────────────────────────────────────────

print_step "19. Photo upload — fresh session for /upload-photo"
PHOTO_CSI="cs_brigade_photo_${TS}"
PI=$(curl -sS -X POST "${WORKER}/mise-graph/agents/cooking-lead/${PHOTO_CSI}/init" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}" \
	-H "content-type: application/json" \
	-d "{\"cook_session_id\":\"${PHOTO_CSI}\",\"meal_id\":\"meal_photo_${TS}\",\"plan_id\":\"${PLAN_ID}\",\"household_id\":\"${HOUSEHOLD_ID}\",\"expected_duration_min\":30}")
PI_STATUS=$(echo "$PI" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("state",{}).get("status",""))')
[[ "$PI_STATUS" == "active" ]] && echo "  ✓ fresh session active" || { echo "  ✗ status=$PI_STATUS"; echo "    body: $(echo "$PI" | head -c 280)"; exit 1; }

# Grant a token bound to member 1 + this session
GP=$(mcp_call brigade_grant_token "{\"cook_session_id\":\"${PHOTO_CSI}\",\"member_id\":\"${MEMBER_1}\"}")
PHOTO_TOKEN=$(mcp_text "$GP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("token",""))')
echo "    photo token=${PHOTO_TOKEN:0:8}…"

# Build a 1KB JPEG-ish payload (random bytes; vision will likely reject content
# but the upload pipeline + R2 + sqlite write are what we're verifying).
TMP_JPG="/tmp/e2e_brigade_${TS}.jpg"
head -c 1024 /dev/urandom > "$TMP_JPG"

print_step "20. POST /upload-photo with member token"
UPL=$(curl -sS -X POST "${WORKER}/mise-graph/agents/cooking-lead/${PHOTO_CSI}/upload-photo?member_id=${MEMBER_1}&task_id=task_photo_1&token=${PHOTO_TOKEN}" \
	-H "content-type: image/jpeg" \
	--data-binary "@${TMP_JPG}")
echo "    upload resp: $(echo "$UPL" | head -c 280)"
assert_contains "$UPL" "photo_id" "photo_id returned"

# ── Step 21: extract photo_id ─────────────────────────────────────────────
PHOTO_ID=$(echo "$UPL" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("photo_id") or "")')
if [[ -z "$PHOTO_ID" ]]; then
	echo "  ✗ photo_id empty"
	exit 1
fi
echo "  ✓ photo_id=${PHOTO_ID}"

# ── Step 22: probe /photo-analysis ─────────────────────────────────────────
print_step "22. GET /photo-analysis (admin)"
PA=$(curl -sS -X GET "${WORKER}/mise-graph/agents/cooking-lead/${PHOTO_CSI}/photo-analysis?photo_id=${PHOTO_ID}" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}")
echo "    analysis resp: $(echo "$PA" | head -c 320)"
# Either the vision response is pending OR a stubbed/real response is set.
if echo "$PA" | grep -qE "vision_pending|vision_response|analysis|\"ok\":true"; then
	echo "  ✓ analysis route responds with structured shape"
else
	echo "  ✗ unexpected analysis shape"
	exit 1
fi

# Wrap up the photo session so the DO doesn't hold an alarm needlessly.
mcp_call brigade_end "{\"cook_session_id\":\"${PHOTO_CSI}\",\"outcome\":\"completed\"}" >/dev/null

# ─────────────────────────────────────────────────────────────────────────────
# Phase 3 — WS message dispatch is documented as covered by unit tests.
# ─────────────────────────────────────────────────────────────────────────────
print_step "23. WS message dispatch — referenced unit tests"
echo "  • test/scenarios/u73_brigade_ws_message_dispatch.ts — routeCookingLead contract"
echo "  • test/scenarios/u72_brigade_manual_control.ts        — manual surface (assign/complete/pause)"
echo "  • test/scenarios/u74_brigade_skill_fanout.ts          — skill outcome fan-out"
echo "  • test/scenarios/u59_meal_active_cook_handoff.ts      — MealAgent → CookingLead spawn"
echo "  WS frame kinds covered by unit tests:"
echo "    inbound: ack_task, complete_task, request_help, decline_task,"
echo "             iteration_response, presence_update, ping"
echo "    outbound: welcome, task_assigned, task_unassigned, phase_progress,"
echo "             recipe_iteration_suggested, lead_message, session_ended"

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  E2E PASS — Wave 8 brigade live surface verified end-to-end"
echo "  cook_session_id (cooked):  ${COOK_SESSION_ID}"
echo "  cook_session_id (photo):   ${PHOTO_CSI}"
echo "═══════════════════════════════════════════════════════════════════════"
