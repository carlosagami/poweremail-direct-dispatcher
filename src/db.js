const { Pool } = require("pg");
const logger = require("./logger");

function serializeDbError(error) {
  return {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    stack: error?.stack,
  };
}

function createControlPlaneDb(config) {
  const pool = new Pool({
    connectionString: config.controlPlaneDbUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on("error", (error) => {
    logger.error("control_plane_db.pool_error", {
      error: serializeDbError(error),
    });
  });

  async function query(text, params = []) {
    return pool.query(text, params);
  }

  async function tx(fn) {
    const client = await pool.connect();
    let clientErrored = false;
    let txFailed = false;

    function onClientError(error) {
      clientErrored = true;
      logger.error("control_plane_db.client_error", {
        error: serializeDbError(error),
      });
    }

    client.on("error", onClientError);

    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      txFailed = true;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.warn("control_plane_db.rollback_failed", {
          error: serializeDbError(rollbackError),
        });
      }
      throw err;
    } finally {
      client.off("error", onClientError);
      if (clientErrored) {
        client.release(new Error("Postgres client emitted an error during transaction"));
      } else if (txFailed) {
        client.release(new Error("Postgres transaction failed"));
      } else {
        client.release();
      }
    }
  }

  async function close() {
    await pool.end();
  }

  return { pool, query, tx, close };
}

module.exports = { createControlPlaneDb };
