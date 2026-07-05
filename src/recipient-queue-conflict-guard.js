"use strict";

const pg = require("pg");

const TARGET_INSERT = "INSERT INTO control_plane.campaign_recipient_queue";
const CONFLICT_CLAUSE = "ON CONFLICT (dispatch_campaign_id, email) DO NOTHING";

function shouldGuardRecipientQueueInsert(text) {
  const sql = String(text || "");
  return sql.includes(TARGET_INSERT) && !sql.includes(CONFLICT_CLAUSE);
}

function withRecipientQueueConflictGuard(text) {
  if (!shouldGuardRecipientQueueInsert(text)) return text;
  return `${String(text).trim()}\n${CONFLICT_CLAUSE}`;
}

function patchQuery(proto) {
  if (!proto || proto.__poweremailRecipientQueueGuardPatched) return;

  const originalQuery = proto.query;

  proto.query = function guardedQuery(config, values, callback) {
    if (typeof config === "string") {
      return originalQuery.call(this, withRecipientQueueConflictGuard(config), values, callback);
    }

    if (config && typeof config === "object" && typeof config.text === "string") {
      return originalQuery.call(
        this,
        { ...config, text: withRecipientQueueConflictGuard(config.text) },
        values,
        callback
      );
    }

    return originalQuery.call(this, config, values, callback);
  };

  Object.defineProperty(proto, "__poweremailRecipientQueueGuardPatched", {
    value: true,
    enumerable: false,
  });
}

patchQuery(pg.Client && pg.Client.prototype);
patchQuery(pg.Pool && pg.Pool.prototype);
