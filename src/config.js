const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function intEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer env ${name}=${value}`);
  }
  return parsed;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env ${name}`);
  }
  return value;
}

function loadConfig() {
  loadDotEnv();
  return {
    controlPlaneDbUrl: requireEnv("CONTROL_PLANE_DATABASE_URL"),
    sendyMysqlHost: requireEnv("SENDY_MYSQL_HOST"),
    sendyMysqlPort: intEnv("SENDY_MYSQL_PORT", 3306),
    sendyMysqlDatabase: requireEnv("SENDY_MYSQL_DATABASE"),
    sendyMysqlUser: requireEnv("SENDY_MYSQL_USER"),
    sendyMysqlPassword: requireEnv("SENDY_MYSQL_PASSWORD"),
    sendyAppPath: process.env.SENDY_APP_PATH || "",
    tenantKey: requireEnv("DIRECT_DISPATCHER_TENANT_KEY"),
    sendyCampaignId: intEnv("DIRECT_DISPATCHER_SENDY_CAMPAIGN_ID", 0),
    batchSize: intEnv("DIRECT_DISPATCHER_BATCH_SIZE", 250),
    executionMode: process.env.DIRECT_DISPATCHER_EXECUTION_MODE || "dry-run",
    relaySmtpHost: process.env.RELAY_SMTP_HOST || "",
    relaySmtpPort: intEnv("RELAY_SMTP_PORT", 587),
    relaySmtpSecure: boolEnv("RELAY_SMTP_SECURE", false),
    relaySmtpUser: process.env.RELAY_SMTP_USER || "",
    relaySmtpPassword: process.env.RELAY_SMTP_PASSWORD || "",
    relayFromEmail: process.env.RELAY_FROM_EMAIL || "",
  };
}

module.exports = { loadConfig };
