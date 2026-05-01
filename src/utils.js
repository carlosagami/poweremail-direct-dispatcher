function chunkError(err) {
  return {
    name: err?.name || "Error",
    message: err?.message || String(err),
    stack: err?.stack || "",
  };
}

function parseCsvIds(raw) {
  if (!raw || raw === "0") return [];
  return String(raw)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
}

function buildBatchKey(dispatchCampaignId, batchNo) {
  return `${dispatchCampaignId}:batch:${String(batchNo).padStart(6, "0")}`;
}

module.exports = { chunkError, parseCsvIds, buildBatchKey };
