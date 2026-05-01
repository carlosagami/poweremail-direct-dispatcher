function ts() {
  return new Date().toISOString();
}

function line(level, message, meta = {}) {
  const payload = { ts: ts(), level, message, ...meta };
  const output = JSON.stringify(payload);
  if (level === "error") {
    console.error(output);
  } else {
    console.log(output);
  }
}

module.exports = {
  info(message, meta) {
    line("info", message, meta);
  },
  warn(message, meta) {
    line("warn", message, meta);
  },
  error(message, meta) {
    line("error", message, meta);
  },
};
