'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertTenantPauseInfrastructure,
  isTenantPaused,
  pausedTenantQueuePredicate,
  tenantPauseSchemaReady,
} = require('../src/tenant-pause');

function fakeDb(handler) {
  return {
    calls: [],
    async query(text, params = []) {
      this.calls.push({ text, params });
      return handler(text, params);
    },
  };
}

async function main() {
  {
    const db = fakeDb(() => {
      throw new Error('query should not be called while feature is disabled');
    });

    assert.deepEqual(
      await assertTenantPauseInfrastructure(db, false),
      { enabled: false, schemaReady: null },
    );
    assert.equal(await isTenantPaused(db, 1, false), false);
    assert.equal(db.calls.length, 0);
    assert.equal(pausedTenantQueuePredicate(false, 'q'), '');
  }

  {
    const db = fakeDb((text) => {
      if (text.includes('to_regclass')) {
        return { rows: [{ present: true }] };
      }
      return { rows: [] };
    });

    assert.equal(await tenantPauseSchemaReady(db), true);
    assert.deepEqual(
      await assertTenantPauseInfrastructure(db, true),
      { enabled: true, schemaReady: true },
    );
  }

  {
    const db = fakeDb((text) => {
      if (text.includes('tenant_dispatch_settings')) {
        return { rows: [{ paused: true }] };
      }
      return { rows: [] };
    });

    assert.equal(await isTenantPaused(db, 42, true), true);
    assert.deepEqual(db.calls[0].params, [42]);
  }

  {
    const db = fakeDb(() => ({ rows: [] }));
    assert.equal(await isTenantPaused(db, 42, true), false);
  }

  {
    const predicate = pausedTenantQueuePredicate(true, 'q');
    assert.match(predicate, /tenant_dispatch_settings/);
    assert.match(predicate, /tds\.tenant_id = q\.tenant_id/);
    assert.match(predicate, /tds\.paused = true/);
    assert.throws(
      () => pausedTenantQueuePredicate(true, 'q; DROP TABLE x'),
      /Invalid SQL alias/,
    );
  }

  {
    const db = fakeDb((text) => {
      if (text.includes('to_regclass')) {
        return { rows: [{ present: false }] };
      }
      return { rows: [] };
    });

    await assert.rejects(
      assertTenantPauseInfrastructure(db, true),
      /tenant_dispatch_settings is missing/,
    );
  }

  {
    const executor = fs.readFileSync(
      path.join(process.cwd(), 'src/relay-executor.js'),
      'utf8',
    );
    const config = fs.readFileSync(
      path.join(process.cwd(), 'src/config.js'),
      'utf8',
    );
    const envExample = fs.readFileSync(
      path.join(process.cwd(), '.env.example'),
      'utf8',
    );

    for (const marker of [
      'assertTenantPauseInfrastructure',
      'pausedTenantQueuePredicate',
      'relay_executor.batch_skipped_tenant_paused',
      'relay_executor.batch_paused_by_tenant_control',
      'TENANT_PAUSED',
      'isTenantPaused(',
    ]) {
      assert.ok(
        executor.includes(marker),
        `relay-executor tenant pause marker missing: ${marker}`,
      );
    }

    assert.ok(
      config.includes('DIRECT_DISPATCHER_TENANT_PAUSE_ENABLED'),
      'config feature flag missing',
    );
    assert.ok(
      envExample.includes('DIRECT_DISPATCHER_TENANT_PAUSE_ENABLED=false'),
      'tenant pause feature must default false',
    );
  }

  console.log('tenant-pause-guard: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
