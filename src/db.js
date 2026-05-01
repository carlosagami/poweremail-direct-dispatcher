const { Pool } = require("pg");

function createControlPlaneDb(config) {
  const pool = new Pool({
    connectionString: config.controlPlaneDbUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  async function query(text, params = []) {
    return pool.query(text, params);
  }

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function close() {
    await pool.end();
  }

  return { pool, query, tx, close };
}

module.exports = { createControlPlaneDb };
