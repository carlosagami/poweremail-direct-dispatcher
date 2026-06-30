#!/usr/bin/env bash
set -euo pipefail

export TEST_ORCHESTRATOR_MODE="${TEST_ORCHESTRATOR_MODE:-handoff}"

# Production cron must stay deterministic. Railway-level TEST_ORCHESTRATOR_COPY_MODE
# overrides previously allowed AI/SDR copy to leak back into scheduled sends.
if [[ "${TEST_ORCHESTRATOR_ALLOW_AI_COPY:-false}" == "true" ]]; then
  export TEST_ORCHESTRATOR_COPY_MODE="${TEST_ORCHESTRATOR_COPY_MODE:-local}"
else
  export TEST_ORCHESTRATOR_COPY_MODE="local"
fi

export TEST_ORCHESTRATOR_LIMIT="${TEST_ORCHESTRATOR_LIMIT:-999}"
export TEST_ORCHESTRATOR_FORCE_NOW="${TEST_ORCHESTRATOR_FORCE_NOW:-false}"
export TEST_ORCHESTRATOR_DUE_LOOKBACK_MINUTES="${TEST_ORCHESTRATOR_DUE_LOOKBACK_MINUTES:-45}"
export TEST_ORCHESTRATOR_OPENAI_MODEL="${TEST_ORCHESTRATOR_OPENAI_MODEL:-gpt-4.1-mini}"
export TEST_ORCHESTRATOR_DISPATCHER_URL="${TEST_ORCHESTRATOR_DISPATCHER_URL:-https://poweremail-direct-dispatcher-production.up.railway.app}"

# Keep the salt stable per Mexico City calendar day to prevent accidental duplicate campaigns.
export TEST_ORCHESTRATOR_ID_SALT="${TEST_ORCHESTRATOR_ID_SALT:-daily-$(TZ=America/Mexico_City date +%Y%m%d)}"

exec node -r ./src/test-mail-copy-ai-guard.js src/test-mail-orchestrator.js
