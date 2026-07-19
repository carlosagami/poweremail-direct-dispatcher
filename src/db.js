const { Pool } = require("pg");

const logger = require("./logger");
const { chunkError } = require("./utils");

const RETRYABLE_CONTROL_PLANE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableControlPlaneError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();

  if (RETRYABLE_CONTROL_PLANE_CODES.has(code)) {
    return true;
  }

  return (
    message.includes("connection terminated unexpectedly") ||
    message.includes("connection refused") ||
    message.includes("server closed the connection unexpectedly") ||
    message.includes("terminating connection due to administrator command") ||
    message.includes("client has encountered a connection error") ||
    message.includes("read econnreset")
  );
}

function createControlPlaneDb(config) {
  const maxQueryRetries = Math.max(
    Number(config?.controlPlaneDbMaxQueryRetries ?? 2),
    0
  );
  const retryDelayMs = Math.max(
    Number(config?.controlPlaneDbRetryDelayMs ?? 250),
    0
  );

  const pool = new Pool({
    connectionString: config.controlPlaneDbUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  pool.on("error", (err) => {
    logger.error("control_plane.pool_error", {
      error: chunkError(err),
    });
  });

  async function withRetry(operation, fn) {
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (err) {
        if (!isRetryableControlPlaneError(err) || attempt >= maxQueryRetries) {
          throw err;
        }

        attempt += 1;
        logger.warn("control_plane.retry", {
          operation,
          attempt,
          max_retries: maxQueryRetries,
          retry_delay_ms: retryDelayMs,
          error: chunkError(err),
        });

        if (retryDelayMs > 0) {
          await sleep(retryDelayMs * attempt);
        }
      }
    }
  }

  async function query(text, params = []) {
    return withRetry("query", () => pool.query(text, params));
  }

  async function tx(fn) {
    return withRetry("tx", async () => {
      const client = await pool.connect();
      let destroyClient = false;

      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        destroyClient = isRetryableControlPlaneError(err);
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
        throw err;
      } finally {
        client.release(destroyClient);
      }
    });
  }

  async function close() {
    await pool.end();
  }

  return { pool, query, tx, close };
}

module.exports = { createControlPlaneDb };
