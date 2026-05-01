const mysql = require("mysql2/promise");

function createSendyDb(config) {
  const pool = mysql.createPool({
    host: config.sendyMysqlHost,
    port: config.sendyMysqlPort,
    user: config.sendyMysqlUser,
    password: config.sendyMysqlPassword,
    database: config.sendyMysqlDatabase,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  async function query(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
  }

  async function close() {
    await pool.end();
  }

  return { query, close };
}

module.exports = { createSendyDb };
