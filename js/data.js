import { state } from "./state.js";
import { toMinutes, getAllowedWindow } from "./date-time.js";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function requestJson(url, errorMessage, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...options.headers, "X-CSRF-Token": state.csrfToken },
  });
  if (!response.ok) {
    if (response.status === 409) {
      const result = await response.json();
      if (typeof result.error === "string" && result.error) {
        errorMessage = result.error;
      }
    }
    throw new ApiError(errorMessage, response.status);
  }
  return response.json();
}

function sendJson(url, method, body, errorMessage) {
  return requestJson(url, errorMessage, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getDateEntries(dateValue) {
  return state.entriesCache.filter((entry) => entry.date === dateValue);
}

export async function loadChildCareNeeds() {
  const needs = await requestJson(
    "/api/childcare-needs",
    "Unable to load child care needs.",
  );
  state.childCareNeedsCache = needs.map((need, index) => ({
    ...need,
    id:
      need.id ||
      `childcare-${need.date || "unknown"}-${need.start || "00:00"}-${need.end || "00:00"}-${index}`,
  }));
  return state.childCareNeedsCache;
}

export async function saveChildCareNeeds(needs) {
  const savedNeeds = await sendJson(
    "/api/childcare-needs", "PUT", needs, "Unable to save child care needs.",
  );
  state.childCareNeedsCache = savedNeeds;
  return state.childCareNeedsCache;
}

export function getChildCareNeedsForDate(dateValue) {
  return state.childCareNeedsCache.filter((need) => need.date === dateValue);
}

export function isChildCareNeedFilled(need) {
  const needStart = toMinutes(need.start);
  const needEnd = toMinutes(need.end);
  const requiredMinutes = needEnd - needStart;

  if (requiredMinutes <= 0) {
    return false;
  }

  const coveredIntervals = state.entriesCache
    .filter((entry) => {
      if (entry.date !== need.date || entry.type !== "childcare") {
        return false;
      }

      return !entry.needId || entry.needId === need.id;
    })
    .map((entry) => {
      const entryStart = toMinutes(entry.start);
      const entryEnd = toMinutes(entry.end);
      return {
        start: Math.max(needStart, entryStart),
        end: Math.min(needEnd, entryEnd),
      };
    })
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  if (coveredIntervals.length === 0) {
    return false;
  }

  let coveredMinutes = 0;
  let currentStart = coveredIntervals[0].start;
  let currentEnd = coveredIntervals[0].end;

  for (let index = 1; index < coveredIntervals.length; index += 1) {
    const next = coveredIntervals[index];

    if (next.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, next.end);
      continue;
    }

    coveredMinutes += currentEnd - currentStart;
    currentStart = next.start;
    currentEnd = next.end;
  }

  coveredMinutes += currentEnd - currentStart;

  return coveredMinutes >= requiredMinutes;
}

export function getActiveChildCareNeedsForDate(dateValue) {
  return getChildCareNeedsForDate(dateValue).filter(
    (need) => !isChildCareNeedFilled(need),
  );
}

export function getGeneralVolunteerCount(dateValue) {
  return getDateEntries(dateValue).filter((entry) => entry.type !== "childcare")
    .length;
}

export function summarizeSlotsForDate(dateValue) {
  const entries = getDateEntries(dateValue);
  const generalEntries = entries.filter(
    (entry) => entry.type !== "childcare",
  );
  const childcareEntries = entries.filter(
    (entry) => entry.type === "childcare",
  );

  const summarizeByTime = (entries) => {
    const summaries = new Map();
    entries.forEach((entry) => {
      const key = `${entry.start}-${entry.end}`;
      summaries.set(key, (summaries.get(key) || 0) + 1);
    });

    return Array.from(summaries.entries())
      .map(([key, count]) => {
        const [start, end] = key.split("-");
        return { start, end, count };
      })
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  };

  return {
    general: summarizeByTime(generalEntries),
    childcare: summarizeByTime(childcareEntries),
  };
}

export function getSelectedChildCareNeed(dateValue) {
  const needs = getActiveChildCareNeedsForDate(dateValue);
  if (!needs.length) return null;

  if (state.selectedNeedId) {
    return needs.find((need) => need.id === state.selectedNeedId) || needs[0];
  }

  return needs[0];
}

export function getCurrentTimeWindow(dateValue) {
  if (state.signupType === "childcare") {
    const need = getSelectedChildCareNeed(dateValue);
    if (!need) {
      return null;
    }

    return {
      label: "Child care support",
      start: need.start,
      end: need.end,
    };
  }

  return getAllowedWindow(dateValue);
}

export function generateEntryId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function loadEntries() {
  const entries = await requestJson(
    "/api/entries", "Unable to load volunteer sign-ups.",
  );
  state.entriesCache = entries.map((entry, index) => ({
    ...entry,
    id:
      entry.id ||
      `${entry.name || "volunteer"}-${entry.date || "unknown"}-${entry.start || "00:00"}-${entry.end || "00:00"}-${index}`,
  }));
  return state.entriesCache;
}

export async function addEntry(entry) {
  const result = await sendJson(
    "/api/entries", "POST", entry, "Unable to save signup.",
  );
  const savedEntry = result.entry;
  if (!savedEntry || typeof savedEntry.id !== "string" || !savedEntry.id) {
    throw new Error("Server returned an invalid signup.");
  }
  state.entriesCache = [...state.entriesCache, savedEntry];
  return savedEntry;
}

export async function deleteEntry(entryId) {
  await requestJson(`/api/entries/${encodeURIComponent(entryId)}`, "Unable to delete signup.", {
    method: "DELETE",
  });
  state.entriesCache = state.entriesCache.filter(
    (entry) => entry.id !== entryId,
  );
}
