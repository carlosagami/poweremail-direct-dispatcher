#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const orchestratorConfig = require("../config/test-orchestrator");

function hashInt(input) {
  const digest = crypto.createHash("sha256").update(String(input)).digest();
  return digest.readUInt32BE(0);
}

function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function optionalPositiveIntEnv(name) {
  const value = process.env[name];
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}=${value}; expected a positive integer or 0`);
  }
  return parsed;
}

function intEnvOrConfig(envName, configValue, fallback) {
  const envValue = optionalPositiveIntEnv(envName);
  if (envValue != null) return envValue;
  if (Number.isInteger(configValue)) return configValue;
  return fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function localDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: orchestratorConfig.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function slotToDateTime(slot, dateText) {
  return `${dateText}T${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}:00`;
}

function isWeekendDateText(dateText) {
  const [year, month, day] = String(dateText).split("-").map((part) => Number.parseInt(part, 10));
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

function dayTypeForDate(dateText) {
  return isWeekendDateText(dateText) ? "weekend" : "weekday";
}

function sendVolumeForDate(dateText) {
  const dailySends = orchestratorConfig.dailySends || {};
  const selected = isWeekendDateText(dateText) ? dailySends.weekends : dailySends.weekdays;
  const fallback = {
    minPerBrand: dailySends.minPerBrand,
    maxPerBrand: dailySends.maxPerBrand,
  };
  const volume = selected || fallback;

  if (!Number.isInteger(volume.minPerBrand) || !Number.isInteger(volume.maxPerBrand)) {
    throw new Error(`Invalid dailySends config for ${dayTypeForDate(dateText)}`);
  }
  if (volume.minPerBrand < 1 || volume.maxPerBrand < volume.minPerBrand) {
    throw new Error(`Invalid dailySends range for ${dayTypeForDate(dateText)}`);
  }
  return volume;
}

function recipientCohortConfig() {
  const config = orchestratorConfig.recipientCohorts || {};
  const minRecipientsPerSlot = intEnvOrConfig(
    "TEST_ORCHESTRATOR_RECIPIENTS_PER_SLOT_MIN",
    config.minRecipientsPerSlot,
    3
  );
  const maxRecipientsPerSlot = intEnvOrConfig(
    "TEST_ORCHESTRATOR_RECIPIENTS_PER_SLOT_MAX",
    config.maxRecipientsPerSlot,
    5
  );

  if (minRecipientsPerSlot < 1 || maxRecipientsPerSlot < minRecipientsPerSlot) {
    throw new Error("Invalid recipient cohort size config");
  }

  return {
    enabled: boolEnv("TEST_ORCHESTRATOR_RECIPIENT_COHORTS_ENABLED", config.enabled !== false),
    minRecipientsPerSlot,
    maxRecipientsPerSlot,
  };
}

function buildDailySlots(brand, dateText = localDateString()) {
  const seed = hashInt(`${dateText}:${brand.tenantKey}`);
  const random = mulberry32(seed);
  const volume = sendVolumeForDate(dateText);
  const countRange = volume.maxPerBrand - volume.minPerBrand + 1;
  const count = volume.minPerBrand + Math.floor(random() * countRange);

  const start = orchestratorConfig.sendWindow.startHour * 60;
  const end = orchestratorConfig.sendWindow.endHour * 60;
  const usable = end - start;
  const baseGap = usable / count;
  const slots = [];

  for (let i = 0; i < count; i += 1) {
    const jitter = Math.floor((random() - 0.5) * Math.min(baseGap * 0.7, 55));
    const minuteOfDay = Math.max(start, Math.min(end - 1, Math.floor(start + baseGap * i + baseGap / 2 + jitter)));
    slots.push({
      slotIndex: i + 1,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      slotId: `${dateText}:${brand.tenantKey}:${i + 1}`,
    });
  }

  return slots.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

function selectedBrands() {
  const only = (process.env.TEST_ORCHESTRATOR_TENANT || "").trim();
  if (!only) return orchestratorConfig.brands;
  const wanted = new Set(only.split(",").map((item) => item.trim()).filter(Boolean));
  return orchestratorConfig.brands.filter((brand) => wanted.has(brand.tenantKey));
}

function main() {
  const dateText = process.env.TEST_ORCHESTRATOR_DATE || localDateString();
  const brands = selectedBrands();
  const slots = brands.flatMap((brand) =>
    buildDailySlots(brand, dateText).map((slot) => ({
      tenantKey: brand.tenantKey,
      brandName: brand.brandName,
      scheduledLocal: slotToDateTime(slot, dateText),
      slotId: slot.slotId,
    }))
  );

  slots.sort((a, b) => a.scheduledLocal.localeCompare(b.scheduledLocal) || a.tenantKey.localeCompare(b.tenantKey));

  const cohortConfig = recipientCohortConfig();
  const summary = {
    mode: "config-plan",
    requiresDatabase: false,
    canHandoff: false,
    date: dateText,
    dayType: dayTypeForDate(dateText),
    timezone: orchestratorConfig.timezone,
    sendWindow: orchestratorConfig.sendWindow,
    sendVolume: sendVolumeForDate(dateText),
    recipientCohorts: cohortConfig,
    brands: brands.map((brand) => brand.tenantKey),
    plannedSlots: slots.length,
    estimatedRecipientExposure: {
      min: slots.length * (cohortConfig.enabled ? cohortConfig.minRecipientsPerSlot : 1),
      max: slots.length * (cohortConfig.enabled ? cohortConfig.maxRecipientsPerSlot : 1),
    },
    slots,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
