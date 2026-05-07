#!/usr/bin/env bash
# Wave 7B Phase 2 — E2E driver against deployed worker.
#
# Usage:
#   WORKER=https://mise-graph.... ADMIN_TOKEN=... ./e2e-wave-7.sh
#
# Idempotent — running twice doesn't blow up. Each step prints a one-line
# status; non-zero exit on hard failure.

set -uo pipefail

WORKER="${WORKER:-https://mise-graph.experialstudio.com}"
ADMIN_TOKEN="${ADMIN_TOKEN:-dev}"
HOUSEHOLD_ID="${HOUSEHOLD_ID:-hh_e2e_w7}"
PLAN_ID="${PLAN_ID:-mise_plan:e2e_w7}"
MEMBER_ID="${MEMBER_ID:-mem_e2e_corey}"
START_DATE="${START_DATE:-2026-05-20}"
END_DATE="${END_DATE:-2026-05-22}"

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
		-H "x-spence-trace-caller-id: e2e-script" \
		-d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"${name}\",\"arguments\":${args_json}}}"
}

assert_contains() {
	local body="$1"
	local needle="$2"
	local label="$3"
	if echo "$body" | grep -q -- "$needle"; then
		echo "  ✓ $label"
	else
		echo "  ✗ $label — expected to contain: $needle"
		echo "    body: $(echo "$body" | head -c 240)"
		exit 1
	fi
}

# ── Step 1: migrate Wave 7 schemas ─────────────────────────────────────────
print_step "1. Schema migrations"
MIGRATE_RESP=$(curl -sS -X POST "${WORKER}/mise-graph/admin/migrate-wave-7" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}")
echo "$MIGRATE_RESP" | head -c 400
echo ""
assert_contains "$MIGRATE_RESP" "migrated" "migrate-wave-7 returns migrated array"

# ── Step 2: create household member ─────────────────────────────────────────
print_step "2. member_create"
MEM_RESP=$(mcp_call member_create "{\"household_id\":\"${HOUSEHOLD_ID}\",\"member_id\":\"${MEMBER_ID}\",\"display_name\":\"Corey\",\"age_group\":\"adult\"}")
echo "$MEM_RESP" | head -c 240; echo ""
assert_contains "$MEM_RESP" "$MEMBER_ID" "member_create echoes member_id"

# ── Step 3: create plan ────────────────────────────────────────────────────
print_step "3. plan_create"
PLAN_RESP=$(mcp_call plan_create "{\"plan_id\":\"${PLAN_ID}\",\"household_id\":\"${HOUSEHOLD_ID}\",\"start_date\":\"${START_DATE}\",\"end_date\":\"${END_DATE}\",\"people_default\":2}")
echo "$PLAN_RESP" | head -c 240; echo ""
assert_contains "$PLAN_RESP" "$PLAN_ID" "plan_create echoes plan_id"

# ── Step 4: compose meal ───────────────────────────────────────────────────
print_step "4. plan_compose_meal"
COMPOSE_RESP=$(mcp_call plan_compose_meal "{\"plan_id\":\"${PLAN_ID}\",\"slot\":{\"date\":\"${START_DATE}\",\"slot\":\"dinner\"},\"meal\":{\"title\":\"miso salmon bowl\",\"format\":\"bowl\",\"cuisine\":[\"japanese\"],\"raw_ingredients\":[{\"name\":\"salmon\",\"qty\":200,\"unit\":\"g\"}]}}")
echo "$COMPOSE_RESP" | head -c 400; echo ""
assert_contains "$COMPOSE_RESP" "meal_id" "compose returns meal_id"

# ── Step 5: finalize plan ──────────────────────────────────────────────────
print_step "5. plan_finalize"
FINALIZE_RESP=$(mcp_call plan_finalize "{\"plan_id\":\"${PLAN_ID}\"}")
echo "$FINALIZE_RESP" | head -c 400; echo ""
assert_contains "$FINALIZE_RESP" "$PLAN_ID" "finalize returns plan_id"

# ── Step 6: probe DO state ─────────────────────────────────────────────────
print_step "6. plan agent state via bridge"
PLAN_STATE=$(curl -sS -X GET "${WORKER}/mise-graph/agents/plan/${PLAN_ID}/state" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}")
echo "$PLAN_STATE" | head -c 240; echo ""
# Must contain plan_id or status — DO may have ephemeral state on a fresh
# instance, but the bridge should at least respond with valid JSON.
assert_contains "$PLAN_STATE" "plan_id" "plan agent state echoes plan_id"

print_step "7. household agent state via bridge"
HH_STATE=$(curl -sS -X GET "${WORKER}/mise-graph/agents/household/${HOUSEHOLD_ID}/state" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}")
echo "$HH_STATE" | head -c 240; echo ""
assert_contains "$HH_STATE" "household_id" "household agent state echoes household_id"

print_step "8. meal agent state via bridge"
MEAL_STATE=$(curl -sS -X GET "${WORKER}/mise-graph/agents/meal/${PLAN_ID}/${START_DATE}/dinner/state" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}")
echo "$MEAL_STATE" | head -c 240; echo ""
assert_contains "$MEAL_STATE" "phase" "meal agent state has phase"

print_step "9. force meal phase transition (cook_window)"
TRANS_RESP=$(curl -sS -X POST "${WORKER}/mise-graph/agents/meal/${PLAN_ID}/${START_DATE}/dinner/transition" \
	-H "content-type: application/json" \
	-H "X-Spence-Admin: ${ADMIN_TOKEN}" \
	-d '{"to_phase":"cook_window","reason":"e2e:force_advance","force":true}')
echo "$TRANS_RESP" | head -c 240; echo ""
assert_contains "$TRANS_RESP" "cook_window" "meal transitioned to cook_window"

# ── Step 10: trace chain ───────────────────────────────────────────────────
print_step "10. agent_list_plan_traces"
TRACES_RESP=$(mcp_call agent_list_plan_traces "{\"plan_id\":\"${PLAN_ID}\",\"limit\":20}")
echo "$TRACES_RESP" | head -c 600; echo ""
assert_contains "$TRACES_RESP" "trace_id" "trace list returns trace_ids"

print_step "11. archive plan"
ARC_RESP=$(mcp_call plan_archive "{\"plan_id\":\"${PLAN_ID}\"}")
echo "$ARC_RESP" | head -c 240; echo ""
assert_contains "$ARC_RESP" "archived" "archive returns archived=true"

echo ""
echo "═══ E2E PASS — Wave 7B Phase 2 verified end-to-end ═══"
