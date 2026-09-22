'use strict';

const TABLE_NAME = 'control_plane.tenant_dispatch_settings';

async function tenantPauseSchemaReady(cpDb) {
  const { rows } = await cpDb.query(
    `
    SELECT to_regclass($1) IS NOT NULL AS present
    `,
    [TABLE_NAME]
  );
  return rows[0]?.present === true;
}

async function assertTenantPauseInfrastructure(cpDb, enabled) {
  if (!enabled) return { enabled: false, schemaReady: null };

  const schemaReady = await tenantPauseSchemaReady(cpDb);
  if (!schemaReady) {
    throw new Error(
      'DIRECT_DISPATCHER_TENANT_PAUSE_ENABLED=true but control_plane.tenant_dispatch_settings is missing'
    );
  }

  return { enabled: true, schemaReady: true };
}

async function isTenantPaused(cpDb, tenantId, enabled) {
  if (!enabled) return false;
  if (!tenantId) {
    throw new Error('Tenant pause check requires tenant_id');
  }

  const { rows } = await cpDb.query(
    `
    SELECT COALESCE(paused, false) AS paused
    FROM control_plane.tenant_dispatch_settings
    WHERE tenant_id = $1::bigint
    LIMIT 1
    `,
    [tenantId]
  );

  return rows[0]?.paused === true;
}

function pausedTenantQueuePredicate(enabled, queueAlias = 'q') {
  if (!enabled) return '';

  const safeAlias = String(queueAlias || '').trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(safeAlias)) {
    throw new Error('Invalid SQL alias for tenant pause predicate');
  }

  return `
        AND NOT EXISTS (
          SELECT 1
          FROM control_plane.tenant_dispatch_settings tds
          WHERE tds.tenant_id = ${safeAlias}.tenant_id
            AND tds.paused = true
        )`;
}

module.exports = {
  assertTenantPauseInfrastructure,
  isTenantPaused,
  pausedTenantQueuePredicate,
  tenantPauseSchemaReady,
};
