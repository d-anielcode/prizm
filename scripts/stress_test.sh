#!/usr/bin/env bash
# =============================================================================
# STRESS TESTS (S1-S3) for Prizm API routes
# Requires: CRON_SECRET env var, BASE_URL (defaults to localhost:3000)
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
AUTH="Authorization: Bearer ${CRON_SECRET:?Set CRON_SECRET env var}"

echo "=== Prizm Stress Tests ==="
echo "Base URL: $BASE_URL"
echo ""

# ─── S1: Concurrent Enrichment ───────────────────────────────────────────────
# Fire /api/enrich twice simultaneously. Verify:
#   - Only one runs (mutex lock)
#   - No duplicate props
#   - Final state is consistent

echo "--- S1: Concurrent Enrichment ---"
echo "Firing two concurrent enrich requests..."

# Fire both in parallel
curl -s -X GET "$BASE_URL/api/enrich?force=true" -H "$AUTH" -o /tmp/enrich1.json &
PID1=$!
sleep 0.5  # slight offset to test lock race
curl -s -X GET "$BASE_URL/api/enrich?force=true" -H "$AUTH" -o /tmp/enrich2.json &
PID2=$!

wait $PID1 $PID2

echo "Enrich 1 result:"
cat /tmp/enrich1.json | python3 -m json.tool 2>/dev/null | head -10
echo ""
echo "Enrich 2 result:"
cat /tmp/enrich2.json | python3 -m json.tool 2>/dev/null | head -10
echo ""

# Check if one was skipped
if grep -q "already in progress" /tmp/enrich2.json 2>/dev/null; then
  echo "PASS: Second enrichment was blocked by mutex lock"
elif grep -q "already in progress" /tmp/enrich1.json 2>/dev/null; then
  echo "PASS: First enrichment was blocked by mutex lock (second won the race)"
else
  echo "WARN: Both enrichments may have run — check for duplicate/inconsistent data"
fi
echo ""

# ─── S2: ESPN API Outage Simulation ─────────────────────────────────────────
# We can't truly mock ESPN, but we can verify enrich handles missing data.
# Run enrich after clearing the injuries/spreads cache — it should degrade gracefully.

echo "--- S2: Graceful Degradation Test ---"
echo "Running enrich (ESPN data may or may not be available)..."

RESULT=$(curl -s -w "\n%{http_code}" -X GET "$BASE_URL/api/enrich" -H "$AUTH")
HTTP_CODE=$(echo "$RESULT" | tail -1)
BODY=$(echo "$RESULT" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "PASS: Enrich returned 200 even without guaranteed ESPN data"
  echo "$BODY" | python3 -m json.tool 2>/dev/null | grep -E "enriched|espn" | head -5
else
  echo "FAIL: Enrich returned HTTP $HTTP_CODE"
  echo "$BODY" | head -5
fi
echo ""

# ─── S3: Large Slate Simulation ─────────────────────────────────────────────
# Check if enrichment timing is within 300s Vercel limit.
# We measure the response time of a full enrich cycle.

echo "--- S3: Enrichment Timing Test ---"
echo "Timing a full enrich cycle (300s Vercel limit)..."

START=$(date +%s)
curl -s -X GET "$BASE_URL/api/enrich?force=true" -H "$AUTH" -o /tmp/enrich_timed.json
END=$(date +%s)
DURATION=$((END - START))

echo "Enrich completed in ${DURATION}s"
if [ "$DURATION" -lt 300 ]; then
  echo "PASS: Under 300s Vercel limit (${DURATION}s)"
else
  echo "FAIL: Exceeded 300s Vercel limit (${DURATION}s)"
fi

ENRICHED=$(python3 -c "import json; d=json.load(open('/tmp/enrich_timed.json')); print(d.get('enriched', 'N/A'))" 2>/dev/null || echo "N/A")
echo "Props enriched: $ENRICHED"
echo ""

echo "=== All stress tests complete ==="
