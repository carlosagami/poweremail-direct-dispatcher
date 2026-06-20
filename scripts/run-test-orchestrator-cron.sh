#!/usr/bin/env bash
set -euo pipefail

export TEST_ORCHESTRATOR_MODE="${TEST_ORCHESTRATOR_MODE:-handoff}"
export TEST_ORCHESTRATOR_COPY_MODE="${TEST_ORCHESTRATOR_COPY_MODE:-ai}"
export TEST_ORCHESTRATOR_LIMIT="${TEST_ORCHESTRATOR_LIMIT:-999}"
export TEST_ORCHESTRATOR_FORCE_NOW="${TEST_ORCHESTRATOR_FORCE_NOW:-true}"
export TEST_ORCHESTRATOR_OPENAI_MODEL="${TEST_ORCHESTRATOR_OPENAI_MODEL:-gpt-4.1-mini}"
export TEST_ORCHESTRATOR_DISPATCHER_URL="${TEST_ORCHESTRATOR_DISPATCHER_URL:-https://poweremail-direct-dispatcher-production.up.railway.app}"

# Keep the salt stable per Mexico City calendar day to prevent accidental duplicate campaigns.
export TEST_ORCHESTRATOR_ID_SALT="${TEST_ORCHESTRATOR_ID_SALT:-daily-$(TZ=America/Mexico_City date +%Y%m%d)}"

exec node src/test-mail-orchestrator.js
