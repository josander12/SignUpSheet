const state = {
  currentMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDate: null,
  adminAuthenticated: false,
  adminDetailPage: 1,
  signupType: "general",
  selectedNeedId: null,
  entriesCache: [],
  childCareNeedsCache: [],
};

const form = document.getElementById("signup-form");
const appToast = document.getElementById("app-toast");
const appToastMessage = document.getElementById("app-toast-message");
const serverLoadError = document.getElementById("server-load-error");
const retryServerLoadButton = document.getElementById("retry-server-load");
const calendarPage = document.getElementById("calendar-page");
const signupPage = document.getElementById("signup-page");
const schedulePanel = document.querySelector(".schedule-panel");
const dateInput = document.getElementById("date");
const startSelect = document.getElementById("start-time");
const endSelect = document.getElementById("end-time");
const monthLabel = document.getElementById("month-label");
const calendarGrid = document.getElementById("calendar-grid");
const dateDetail = document.getElementById("date-detail");
const dayDetailsDialog = document.getElementById("day-details-dialog");
const adminPanel = document.getElementById("admin-panel");
const adminLoginBox = document.getElementById("admin-login-box");
const adminContent = document.getElementById("admin-content");
const adminEntries = document.getElementById("admin-entries");
const adminPasswordInput = document.getElementById("admin-password");
const signupTypeSelect = document.getElementById("signup-type");
const showAdminButton = document.getElementById("show-admin");
const logoutAdminButton = document.getElementById("logout-admin");
function padTime(value) {
  return value.toString().padStart(2, "0");
}

function toMinutes(timeString) {
  const [hours, minutes] = timeString.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatTime(timeString) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDate(dateString) {
  const date = parseDateValue(dateString);
  if (!date) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateValue(dateValue) {
  if (!dateValue) {
    return null;
  }

  const [year, month, day] = dateValue.split("-").map(Number);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }

  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function getNextAvailableDate(date = new Date()) {
  const candidate = new Date(date);
  candidate.setHours(12, 0, 0, 0);

  while (![1, 3, 6].includes(candidate.getDay())) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return toDateInputValue(candidate);
}

function getAllowedWindow(dateValue) {
  if (!dateValue) {
    return null;
  }

  const date = parseDateValue(dateValue);
  if (!date) {
    return null;
  }

  const weekday = date.getDay();

  if (weekday === 1 || weekday === 3) {
    return { label: "Monday/Wednesday", start: "11:45", end: "17:45" };
  }

  if (weekday === 6) {
    return { label: "Saturday", start: "08:30", end: "14:00" };
  }

  return null;
}

function isPastDate(dateValue) {
  if (!dateValue) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const date = parseDateValue(dateValue);
  if (!date) {
    return false;
  }

  date.setHours(0, 0, 0, 0);

  return date < today;
}

function buildTimeOptions(start, end) {
  const options = [];
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);

  for (let minutes = startMinutes; minutes <= endMinutes; minutes += 15) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const formatted = `${padTime(hours)}:${padTime(mins)}`;
    options.push(formatted);
  }

  return options;
}

function getDateEntries(dateValue) {
  return state.entriesCache.filter((entry) => entry.date === dateValue);
}

async function loadChildCareNeeds() {
  const response = await fetch("/api/childcare-needs");
  if (!response.ok) {
    throw new Error("Unable to load child care needs.");
  }

  const needs = await response.json();
  state.childCareNeedsCache = needs.map((need, index) => ({
    ...need,
    id:
      need.id ||
      `childcare-${need.date || "unknown"}-${need.start || "00:00"}-${need.end || "00:00"}-${index}`,
  }));
  return state.childCareNeedsCache;
}

async function saveChildCareNeeds(needs) {
  const response = await fetch("/api/childcare-needs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(needs),
  });

  if (!response.ok) {
    throw new Error("Unable to save child care needs.");
  }

  const savedNeeds = await response.json();
  state.childCareNeedsCache = savedNeeds;
  return state.childCareNeedsCache;
}

function getChildCareNeedsForDate(dateValue) {
  return state.childCareNeedsCache.filter((need) => need.date === dateValue);
}

function isChildCareNeedFilled(need) {
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

function getActiveChildCareNeedsForDate(dateValue) {
  return getChildCareNeedsForDate(dateValue).filter(
    (need) => !isChildCareNeedFilled(need),
  );
}

function getGeneralVolunteerCount(dateValue) {
  return getDateEntries(dateValue).filter((entry) => entry.type !== "childcare")
    .length;
}

function summarizeSlotsForDate(dateValue) {
  const generalEntries = getDateEntries(dateValue).filter(
    (entry) => entry.type !== "childcare",
  );
  const childcareEntries = getDateEntries(dateValue).filter(
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

function getSelectedChildCareNeed(dateValue) {
  const needs = getActiveChildCareNeedsForDate(dateValue);
  if (!needs.length) return null;

  if (state.selectedNeedId) {
    return needs.find((need) => need.id === state.selectedNeedId) || needs[0];
  }

  return needs[0];
}

function getCurrentTimeWindow(dateValue) {
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

function populateTimeSelects(dateValue) {
  const window = getCurrentTimeWindow(dateValue);

  if (!window) {
    startSelect.innerHTML = '<option value="">No available time</option>';
    endSelect.innerHTML = '<option value="">No available time</option>';
    startSelect.disabled = true;
    endSelect.disabled = true;
    return;
  }

  const times = buildTimeOptions(window.start, window.end);
  startSelect.innerHTML = times
    .map((time) => `<option value="${time}">${formatTime(time)}</option>`)
    .join("");

  endSelect.innerHTML = times
    .map((time) => `<option value="${time}">${formatTime(time)}</option>`)
    .join("");

  startSelect.disabled = false;
  endSelect.disabled = false;
  startSelect.value = times[0];
  updateEndOptions();
}

function updateEndOptions() {
  const startTime = startSelect.value;
  const window = getCurrentTimeWindow(dateInput.value);

  if (!window) {
    return;
  }

  const allTimes = buildTimeOptions(window.start, window.end);
  const validEndTimes = allTimes.filter(
    (time) => toMinutes(time) > toMinutes(startTime),
  );

  if (validEndTimes.length === 0) {
    endSelect.innerHTML = '<option value="">Choose a later time</option>';
    endSelect.disabled = true;
    return;
  }

  endSelect.innerHTML = validEndTimes
    .map((time) => `<option value="${time}">${formatTime(time)}</option>`)
    .join("");

  endSelect.disabled = false;
  endSelect.value = validEndTimes[validEndTimes.length - 1];
}

function generateEntryId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function loadEntries() {
  const response = await fetch("/api/entries");
  if (!response.ok) {
    throw new Error("Unable to load volunteer sign-ups.");
  }

  const entries = await response.json();
  state.entriesCache = entries.map((entry, index) => ({
    ...entry,
    id:
      entry.id ||
      `${entry.name || "volunteer"}-${entry.date || "unknown"}-${entry.start || "00:00"}-${entry.end || "00:00"}-${index}`,
  }));
  return state.entriesCache;
}

async function addEntry(entry) {
  const response = await fetch("/api/entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });

  if (!response.ok) {
    throw new Error("Unable to save signup.");
  }

  const result = await response.json();
  const savedEntry = result.entry || entry;
  state.entriesCache = [...state.entriesCache, savedEntry];
  return savedEntry;
}

async function submitVolunteerEntry(entry) {
  try {
    await addEntry(entry);
    showToast("Your volunteer signup was submitted successfully.");
    return true;
  } catch (error) {
    showToast("We couldn't submit your signup. Please try again.", "error");
    return false;
  }
}

let toastTimeoutId;

function showToast(message, type = "success") {
  window.clearTimeout(toastTimeoutId);
  appToastMessage.textContent = message;
  appToast.className = `app-toast ${type}`;
  appToast.setAttribute("role", type === "error" ? "alert" : "status");
  appToast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  appToast.hidden = false;
  toastTimeoutId = window.setTimeout(() => {
    appToast.hidden = true;
  }, 5000);
}

async function runAdminMutation(action, successMessage) {
  try {
    await action();
    if (successMessage) {
      showToast(successMessage);
    }
  } catch (error) {
    showToast("We couldn't save that change. Please try again.", "error");
  }
}

async function retryLoadingServerData() {
  retryServerLoadButton.disabled = true;
  retryServerLoadButton.textContent = "Retrying...";

  try {
    await refreshServerData();
    serverLoadError.hidden = true;
    renderCalendar();
    renderSelectedDateDetail();
    renderAdminEntries();
  } catch (error) {
    serverLoadError.hidden = false;
  } finally {
    retryServerLoadButton.disabled = false;
    retryServerLoadButton.textContent = "Retry";
  }
}

retryServerLoadButton.addEventListener("click", retryLoadingServerData);

document.getElementById("dismiss-toast").addEventListener("click", () => {
  window.clearTimeout(toastTimeoutId);
  appToast.hidden = true;
});

async function deleteEntry(entryId) {
  const response = await fetch(`/api/entries/${entryId}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error("Unable to delete signup.");
  }

  state.entriesCache = state.entriesCache.filter(
    (entry) => entry.id !== entryId,
  );
  renderCalendar();
  renderSelectedDateDetail();
  renderAdminEntries();
}

function renderAdminEntries() {
  const entries = [...state.entriesCache].sort((a, b) => {
    if (a.date === b.date) {
      return toMinutes(a.start) - toMinutes(b.start);
    }
    return (parseDateValue(a.date) || 0) - (parseDateValue(b.date) || 0);
  });

  if (entries.length === 0) {
    adminEntries.innerHTML = `
      <div class="empty-state">
        No volunteer sign-ups yet.
      </div>
    `;
    return;
  }

  adminEntries.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Date</th>
          <th>Time</th>
          <th>Contact</th>
          <th>Notes</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${entries
          .map(
            (entry) => `
              <tr>
                <td>${entry.name}</td>
                <td>${formatDate(entry.date)}</td>
                <td>${formatTime(entry.start)} – ${formatTime(entry.end)}</td>
                <td>${entry.contact || "Not provided"}</td>
                <td>${entry.notes || "—"}</td>
                <td>
                  <button
                    type="button"
                    class="delete-entry"
                    data-entry-id="${entry.id}"
                    aria-label="Delete volunteer signup"
                    title="Delete signup"
                  >
                    🗑
                  </button>
                </td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderSelectedDateDetail() {
  const targetDate = state.selectedDate || dateInput.value;
  if (!targetDate) {
    dateDetail.innerHTML = "";
    return;
  }

  const childcareNeeds = getChildCareNeedsForDate(targetDate).sort(
    (a, b) => toMinutes(a.start) - toMinutes(b.start),
  );

  if (state.adminAuthenticated) {
    if (isPastDate(targetDate)) {
      dateDetail.innerHTML = "";
      return;
    }

    const entries = getDateEntries(targetDate).sort(
      (a, b) => toMinutes(a.start) - toMinutes(b.start),
    );

    const details = [];

    if (entries.length > 0) {
      const pageSize = 8;
      const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
      if (state.adminDetailPage > totalPages) {
        state.adminDetailPage = totalPages;
      }

      const startIndex = (state.adminDetailPage - 1) * pageSize;
      const paginatedEntries = entries.slice(startIndex, startIndex + pageSize);
      const pageButtons = Array.from({ length: totalPages }, (_, index) => {
        const pageNumber = index + 1;
        return `
          <button
            type="button"
            class="secondary admin-page-button ${pageNumber === state.adminDetailPage ? "active" : ""}"
            data-page="${pageNumber}"
          >
            ${pageNumber}
          </button>
        `;
      }).join("");

      details.push(`
        <div class="care-detail-block">
          <h4>Volunteer sign-ups</h4>
          <div class="admin-detail-list">
            ${paginatedEntries
              .map(
                (entry) => `
                  <div class="admin-detail-row">
                    <div>
                      <strong>${entry.name}</strong>
                      <div>${formatTime(entry.start)} – ${formatTime(entry.end)}</div>
                      <div>${entry.contact || "No contact provided"}</div>
                      ${entry.notes ? `<div>${entry.notes}</div>` : ""}
                    </div>
                    <button
                      type="button"
                      class="delete-entry admin-delete-entry"
                      data-entry-id="${entry.id}"
                      aria-label="Delete volunteer signup"
                      title="Delete signup"
                    >
                      🗑
                    </button>
                  </div>
                `,
              )
              .join("")}
          </div>
          ${totalPages > 1 ? `<div class="admin-pagination">${pageButtons}</div>` : ""}
        </div>
      `);
    }

    const childcareRows = childcareNeeds
      .map(
        (need) => `
          <div class="admin-detail-row">
            <div>
              <strong>${formatTime(need.start)} – ${formatTime(need.end)}</strong>
              ${need.notes ? `<div>${need.notes}</div>` : ""}
            </div>
            <button
              type="button"
              class="delete-entry admin-delete-entry"
              data-childcare-id="${need.id}"
              aria-label="Delete child care need"
              title="Delete child care need"
            >
              🗑
            </button>
          </div>
        `,
      )
      .join("");

    if (entries.length === 0) {
      details.unshift(
        `<p class="detail-text admin-no-volunteers">No volunteers for this day.</p>`,
      );
    }

    dateDetail.innerHTML = `
      <h3>${formatDate(targetDate)}</h3>
      ${details.join("")}
      <section class="care-detail-block admin-day-care">
        <h4>Child care needs</h4>
        ${
          childcareRows
            ? `<div class="admin-detail-list">${childcareRows}</div>`
            : '<p class="detail-text">No child care needs scheduled.</p>'
        }
        <form class="admin-childcare-form" data-date="${targetDate}">
          <div class="field-row two-up">
            <label>
              Start time
              <input name="start" type="time" required />
            </label>
            <label>
              End time
              <input name="end" type="time" required />
            </label>
          </div>
          <label class="admin-care-notes">
            Notes
            <input name="notes" type="text" placeholder="Optional details" />
          </label>
          <button type="submit">Add child care need</button>
        </form>
      </section>
    `;
    return;
  }

  const window = getAllowedWindow(targetDate);
  const summaries = summarizeSlotsForDate(targetDate);
  const generalSummaries = summaries.general;
  const childcareSummaries = summaries.childcare;
  const generalHelpMarkup = window
    ? `
      <div class="care-detail-block">
        <h4>House building help needed</h4>
        <div class="care-need-row">
          <div>
            <strong>${formatTime(window.start)} – ${formatTime(window.end)}</strong>
          </div>
          <button
            type="button"
            class="secondary volunteer-day-button"
            data-date="${targetDate}"
          >
            Volunteer
          </button>
        </div>
      </div>
    `
    : "";

  const activeChildCareNeeds = childcareNeeds.filter(
    (need) => !isChildCareNeedFilled(need),
  );
  const childCareMarkup = activeChildCareNeeds.length
    ? `
      <div class="care-detail-block">
        <h4>Child care help needed</h4>
        ${activeChildCareNeeds
          .map(
            (need) => `
              <div class="care-need-row">
                <div>
                  <strong>${formatTime(need.start)} – ${formatTime(need.end)}</strong>
                  ${need.notes ? `<div>${need.notes}</div>` : ""}
                </div>
                <button
                  type="button"
                  class="secondary childcare-volunteer-button"
                  data-date="${targetDate}"
                  data-need-id="${need.id}"
                >
                  Volunteer
                </button>
              </div>
            `,
          )
          .join("")}
      </div>
    `
    : "";

  if (!window) {
    dateDetail.innerHTML = `
      <h3>${formatDate(targetDate)}</h3>
      ${
        childCareMarkup ||
        `
        <p class="detail-text">
          No help is needed on this day.
        </p>
      `
      }
    `;
    return;
  }

  if (
    generalSummaries.length === 0 &&
    childcareSummaries.length === 0 &&
    activeChildCareNeeds.length === 0
  ) {
    dateDetail.innerHTML = `
      <h3>${formatDate(targetDate)}</h3>
      ${generalHelpMarkup}
    `;
    return;
  }

  const summaryRows = [];
  if (generalSummaries.length > 0) {
    summaryRows.push(
      ...generalSummaries.map(
        (slot) => `
          <li class="volunteer-summary-row">
            <div class="volunteer-shift">
              <strong>House-building help</strong>
              <span>${formatTime(slot.start)} – ${formatTime(slot.end)}</span>
            </div>
            <div class="volunteer-total">
              <strong>${slot.count}</strong>
              <span>volunteer${slot.count > 1 ? "s" : ""}</span>
            </div>
          </li>
        `,
      ),
    );
  }

  if (childcareSummaries.length > 0) {
    summaryRows.push(
      ...childcareSummaries.map(
        (slot) => `
          <li class="volunteer-summary-row">
            <div class="volunteer-shift">
              <strong>Child care help</strong>
              <span>${formatTime(slot.start)} – ${formatTime(slot.end)}</span>
            </div>
            <div class="volunteer-total">
              <strong>${slot.count}</strong>
              <span>volunteer${slot.count > 1 ? "s" : ""}</span>
            </div>
          </li>
        `,
      ),
    );
  }

  const currentVolunteersMarkup = summaryRows.length
    ? `
      <section class="current-volunteers" aria-label="Current volunteers">
        <h4>Current volunteers</h4>
        <ul class="volunteer-summary-list">
          ${summaryRows.join("")}
        </ul>
      </section>
    `
    : "";

  dateDetail.innerHTML = `
    <h3>${formatDate(targetDate)}</h3>
    ${generalHelpMarkup}
    ${childCareMarkup}
    ${currentVolunteersMarkup}
  `;
}

function renderCalendar() {
  const monthStart = new Date(
    state.currentMonth.getFullYear(),
    state.currentMonth.getMonth(),
    1,
  );
  monthLabel.textContent = monthStart.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayRow = document.querySelector(".calendar-weekdays");
  if (weekdayRow) {
    weekdayRow.innerHTML = weekdayNames
      .map((name) => `<span class="calendar-weekday">${name}</span>`)
      .join("");
  }

  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - ((monthStart.getDay() + 6) % 7));

  const cells = [];
  const visibleDates = [];
  const cursor = new Date(gridStart);

  while (visibleDates.length < 42) {
    if (cursor.getDay() !== 0) {
      visibleDates.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const cellDate of visibleDates) {
    const value = toDateInputValue(cellDate);
    const allowedWindow = getAllowedWindow(value);
    const generalCount = getGeneralVolunteerCount(value);
    const activeChildcareNeeds = getActiveChildCareNeedsForDate(value);
    const isCurrentMonth = cellDate.getMonth() === monthStart.getMonth();
    const isSelected = value === (state.selectedDate || dateInput.value);
    const isVolunteerDay = Boolean(allowedWindow);
    const isPast = isPastDate(value);
    const isDisabled = isPast;
    const badges = [];

    if (!isPast && activeChildcareNeeds.length > 0) {
      badges.push({
        text: "Care",
        className: "day-count childcare",
      });
    }

    if (!isPast && generalCount > 0) {
      badges.push({
        text: `${generalCount} help`,
        className: "day-count volunteer",
      });
    }

    if (!isPast && isVolunteerDay) {
      badges.push({
        text: "Open",
        className: "day-count open",
      });
    }

    cells.push(`
      <button
        type="button"
        class="calendar-day ${isCurrentMonth ? "" : "muted"} ${isSelected ? "selected" : ""} ${isDisabled ? "disabled" : ""}"
        data-date="${value}"
        ${isDisabled ? "disabled" : ""}
      >
        <span class="day-number">${cellDate.getDate()}</span>
        ${badges.length ? `<span class="day-badges">${badges.map((badge) => `<span class="${badge.className}">${badge.text}</span>`).join("")}</span>` : ""}
      </button>
    `);
  }

  calendarGrid.innerHTML = cells.join("");
}

function updateAdminView() {
  if (!state.adminAuthenticated) {
    adminLoginBox.classList.remove("hidden");
    adminContent.classList.add("hidden");
    adminPanel.classList.remove("hidden");
    adminPasswordInput.value = "";
    showAdminButton.classList.remove("hidden");
    logoutAdminButton.classList.add("hidden");
    if (schedulePanel) {
      schedulePanel.classList.remove("hidden");
    }
    return;
  }

  adminLoginBox.classList.add("hidden");
  adminContent.classList.remove("hidden");
  adminPanel.classList.add("hidden");
  showAdminButton.classList.add("hidden");
  logoutAdminButton.classList.remove("hidden");
  if (schedulePanel) {
    schedulePanel.classList.add("hidden");
  }
  renderAdminEntries();
  renderCalendar();
  renderSelectedDateDetail();
}

function validateRange(startTime, endTime, dateValue) {
  if (!startTime || !endTime) {
    return "Please select a valid start and end time.";
  }

  if (isPastDate(dateValue)) {
    return "Please choose a future volunteer date.";
  }

  const startMinutes = toMinutes(startTime);
  const endMinutes = toMinutes(endTime);

  if (startMinutes >= endMinutes) {
    return "End time must be later than the start time.";
  }

  if (state.signupType === "childcare") {
    const need = getSelectedChildCareNeed(dateValue);
    if (!need) {
      return "No child care need is available for this date.";
    }

    const allowedStart = toMinutes(need.start);
    const allowedEnd = toMinutes(need.end);

    if (startMinutes < allowedStart || endMinutes > allowedEnd) {
      return `Choose a time range within the posted child care need: ${formatTime(need.start)} – ${formatTime(need.end)}.`;
    }

    return "";
  }

  const window = getAllowedWindow(dateValue);
  if (!window) {
    return "Please choose a Monday, Wednesday, or Saturday volunteer date.";
  }

  const allowedStart = toMinutes(window.start);
  const allowedEnd = toMinutes(window.end);

  if (startMinutes < allowedStart || endMinutes > allowedEnd) {
    return `Choose a time range within ${window.label}'s available hours: ${formatTime(window.start)} – ${formatTime(window.end)}.`;
  }

  return "";
}

function showCalendarPage() {
  calendarPage.classList.remove("hidden");
  signupPage.classList.add("hidden");
}

function showSignupPage() {
  dayDetailsDialog.close();
  calendarPage.classList.add("hidden");
  signupPage.classList.remove("hidden");
  signupPage.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setSelectedDate(dateValue, { openForm = true } = {}) {
  state.adminDetailPage = 1;

  if (isPastDate(dateValue)) {
    if (state.adminAuthenticated) {
      state.selectedDate = dateValue;
      renderCalendar();
      renderSelectedDateDetail();
    }
    return;
  }

  state.selectedDate = dateValue;
  dateInput.value = dateValue;

  if (!state.adminAuthenticated) {
    const needs = getChildCareNeedsForDate(dateValue);
    if (!needs.length) {
      state.signupType = "general";
      state.selectedNeedId = null;
    } else if (state.signupType === "childcare" && !state.selectedNeedId) {
      state.selectedNeedId = needs[0].id;
    }

    if (state.signupType === "childcare" && !needs.length) {
      state.signupType = "general";
    }

    updateSignupTypeOptions(dateValue);
    populateTimeSelects(dateValue);
  }

  if (openForm && !state.adminAuthenticated) {
    showSignupPage();
  }

  renderCalendar();
  renderSelectedDateDetail();
}

function updateSignupTypeOptions(dateValue) {
  const childcareNeeds = getActiveChildCareNeedsForDate(dateValue);
  const hasChildcare = childcareNeeds.length > 0;

  signupTypeSelect.innerHTML = `
    <option value="general">General volunteer shift</option>
    ${hasChildcare ? '<option value="childcare">Child care support</option>' : ""}
  `;

  if (!hasChildcare) {
    state.signupType = "general";
    state.selectedNeedId = null;
  } else if (state.signupType === "childcare") {
    state.selectedNeedId = state.selectedNeedId || childcareNeeds[0].id;
  } else {
    state.selectedNeedId = null;
  }

  signupTypeSelect.value = state.signupType;
}

function initCalendarSelection() {
  state.selectedDate = null;
  dateInput.value = "";
  showCalendarPage();
  populateTimeSelects(getNextAvailableDate(new Date()));
  renderCalendar();
  renderSelectedDateDetail();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = document.getElementById("name").value.trim();
  const dateValue = dateInput.value;
  const contact = document.getElementById("contact").value.trim();
  const notes = document.getElementById("notes").value.trim();
  const start = startSelect.value;
  const end = endSelect.value;

  if (!name) {
    window.alert("Please provide a name.");
    return;
  }

  if (!contact) {
    window.alert("Please provide a phone number or email.");
    return;
  }

  if (!dateValue) {
    window.alert("Please select a date.");
    return;
  }

  if (state.signupType === "childcare") {
    const need = state.selectedNeedId
      ? [...state.childCareNeedsCache].find(
          (item) => item.id === state.selectedNeedId,
        )
      : getChildCareNeedsForDate(dateValue)[0];

    if (!need) {
      window.alert("Please select a child care need before volunteering.");
      return;
    }

    const childcareStart = need.start;
    const childcareEnd = need.end;

    if (!childcareStart || !childcareEnd) {
      window.alert("That child care need does not have a valid time range.");
      return;
    }

    const validationMessage = validateRange(
      childcareStart,
      childcareEnd,
      dateValue,
    );
    if (validationMessage) {
      window.alert(validationMessage);
      return;
    }

    const entry = {
      id: generateEntryId(),
      name,
      date: dateValue,
      contact,
      notes: notes || `Child care support for ${formatDate(dateValue)}`,
      start: childcareStart,
      end: childcareEnd,
      type: "childcare",
      needId: need.id,
    };

    if (!(await submitVolunteerEntry(entry))) return;
    state.selectedDate = dateValue;
    state.signupType = "general";
    state.selectedNeedId = null;
    signupTypeSelect.value = "general";
    form.reset();
    dateInput.value = dateValue;
    renderCalendar();
    renderSelectedDateDetail();
    renderAdminEntries();
    showCalendarPage();
    return;
  }

  const validationMessage = validateRange(start, end, dateValue);
  if (validationMessage) {
    window.alert(validationMessage);
    return;
  }

  const entry = {
    id: generateEntryId(),
    name,
    date: dateValue,
    contact,
    notes,
    start,
    end,
    type: "general",
  };

  if (!(await submitVolunteerEntry(entry))) return;
  state.selectedDate = dateValue;
  state.signupType = "general";
  state.selectedNeedId = null;
  signupTypeSelect.value = "general";
  form.reset();
  dateInput.value = dateValue;
  renderCalendar();
  renderSelectedDateDetail();
  renderAdminEntries();
  showCalendarPage();
});

document.getElementById("back-to-calendar").addEventListener("click", () => {
  showCalendarPage();
});

startSelect.addEventListener("change", () => {
  updateEndOptions();
});

showAdminButton.addEventListener("click", () => {
  adminPanel.classList.remove("hidden");
  updateAdminView();
});

logoutAdminButton.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/admin-logout", { method: "POST" });
    if (!response.ok) {
      throw new Error("Unable to log out.");
    }
  } catch (error) {
    showToast("We couldn't log you out. Please try again.", "error");
    return;
  }

  state.adminAuthenticated = false;
  adminPanel.classList.remove("hidden");
  showAdminButton.classList.add("hidden");
  logoutAdminButton.classList.add("hidden");
  adminLoginBox.classList.remove("hidden");
  adminContent.classList.add("hidden");
  adminPasswordInput.value = "";
});

document.getElementById("admin-login").addEventListener("click", async () => {
  const passwordAttempt = adminPasswordInput.value.trim();

  try {
    const response = await fetch("/api/admin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordAttempt }),
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      window.alert(result.error || "Incorrect password. Try again.");
      return;
    }

    state.adminAuthenticated = true;
    try {
      await refreshServerData();
      serverLoadError.hidden = true;
    } catch (error) {
      serverLoadError.hidden = false;
    }
    updateAdminView();
  } catch (error) {
    window.alert("Unable to reach the admin server. Please try again.");
  }
});

document.getElementById("previous-month").addEventListener("click", () => {
  state.currentMonth = new Date(
    state.currentMonth.getFullYear(),
    state.currentMonth.getMonth() - 1,
    1,
  );
  renderCalendar();
});

document.getElementById("next-month").addEventListener("click", () => {
  state.currentMonth = new Date(
    state.currentMonth.getFullYear(),
    state.currentMonth.getMonth() + 1,
    1,
  );
  renderCalendar();
});

dayDetailsDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    dayDetailsDialog.close();
  }
});

calendarGrid.addEventListener("click", (event) => {
  const dayButton = event.target.closest(".calendar-day");
  if (!dayButton || dayButton.disabled) return;

  const pickedDate = dayButton.dataset.date;
  setSelectedDate(pickedDate, { openForm: false });
  dayDetailsDialog.showModal();
});

dateDetail.addEventListener("click", async (event) => {
  const childcareDeleteButton = event.target.closest("[data-childcare-id]");
  if (childcareDeleteButton) {
    const childcareId = childcareDeleteButton.dataset.childcareId;
    if (!childcareId) return;

    const confirmed = window.confirm("Remove this child care need?");
    if (!confirmed) return;

    const updatedNeeds = [...state.childCareNeedsCache].filter(
      (need) => need.id !== childcareId,
    );
    await runAdminMutation(async () => {
      await saveChildCareNeeds(updatedNeeds);
      renderCalendar();
      renderSelectedDateDetail();
    }, "Child care need removed.");
    return;
  }

  const deleteButton = event.target.closest(".delete-entry");
  if (deleteButton) {
    const entryId = deleteButton.dataset.entryId;
    if (!entryId) return;

    const confirmed = window.confirm("Remove this volunteer signup?");
    if (!confirmed) return;

    await runAdminMutation(
      () => deleteEntry(entryId),
      "Volunteer signup removed.",
    );
    return;
  }

  const pageButton = event.target.closest(".admin-page-button");
  if (pageButton) {
    state.adminDetailPage = Number(pageButton.dataset.page || 1);
    renderSelectedDateDetail();
    return;
  }

  const childcareVolunteerButton = event.target.closest(
    ".childcare-volunteer-button",
  );
  if (childcareVolunteerButton) {
    const pickedDate = childcareVolunteerButton.dataset.date;
    const needId = childcareVolunteerButton.dataset.needId;
    state.signupType = "childcare";
    state.selectedNeedId = needId || null;
    setSelectedDate(pickedDate, { openForm: true });
    return;
  }

  const signUpButton = event.target.closest(".volunteer-day-button");
  if (!signUpButton) return;

  const pickedDate = signUpButton.dataset.date;
  state.signupType = "general";
  state.selectedNeedId = null;
  setSelectedDate(pickedDate, { openForm: true });
});

adminEntries.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest(".delete-entry");
  if (!deleteButton) return;

  const entryId = deleteButton.dataset.entryId;
  if (!entryId) return;

  const confirmed = window.confirm("Remove this volunteer signup?");
  if (!confirmed) return;

  await runAdminMutation(
    () => deleteEntry(entryId),
    "Volunteer signup removed.",
  );
});

dateDetail.addEventListener("submit", async (event) => {
  const childcareForm = event.target.closest(".admin-childcare-form");
  if (!childcareForm) return;

  event.preventDefault();

  const dateValue = childcareForm.dataset.date;
  const start = childcareForm.elements.start.value;
  const end = childcareForm.elements.end.value;
  const notes = childcareForm.elements.notes.value.trim();

  if (!dateValue || !start || !end) {
    window.alert(
      "Please select a date and time range for the child care need.",
    );
    return;
  }

  if (toMinutes(start) >= toMinutes(end)) {
    window.alert("End time must be later than the start time.");
    return;
  }

  const needs = [...state.childCareNeedsCache];
  needs.push({
    id: generateEntryId(),
    date: dateValue,
    start,
    end,
    notes,
  });

  await runAdminMutation(async () => {
    await saveChildCareNeeds(needs);
    childcareForm.reset();
    renderCalendar();
    renderSelectedDateDetail();
  }, "Child care need added.");
});

signupTypeSelect.addEventListener("change", (event) => {
  state.signupType = event.target.value;

  if (state.signupType === "childcare") {
    const needs = getChildCareNeedsForDate(dateInput.value);
    if (!needs.length) {
      state.signupType = "general";
      signupTypeSelect.value = "general";
      populateTimeSelects(dateInput.value);
      return;
    }

    state.selectedNeedId = state.selectedNeedId || needs[0].id;
    populateTimeSelects(dateInput.value);
    return;
  }

  state.selectedNeedId = null;
  populateTimeSelects(dateInput.value);
});

async function refreshServerData() {
  const results = await Promise.allSettled([
    loadEntries(),
    loadChildCareNeeds(),
  ]);
  const failedRequest = results.find((result) => result.status === "rejected");
  if (failedRequest) {
    throw failedRequest.reason;
  }
}

async function initializeApp() {
  try {
    const response = await fetch("/api/admin-status", { cache: "no-store" });
    if (response.ok) {
      const result = await response.json();
      state.adminAuthenticated = result.isAdmin === true;
    }
  } catch (error) {
    state.adminAuthenticated = false;
  }

  try {
    await refreshServerData();
    serverLoadError.hidden = true;
  } catch (error) {
    serverLoadError.hidden = false;
  }
  initCalendarSelection();
  adminPanel.classList.add("hidden");
  adminLoginBox.classList.add("hidden");
  adminContent.classList.add("hidden");
  showAdminButton.classList.remove("hidden");
  logoutAdminButton.classList.add("hidden");

  if (state.adminAuthenticated) {
    updateAdminView();
  }
}

initializeApp();
