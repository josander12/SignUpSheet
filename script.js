const schedule = {
  monday: { label: "Monday", start: "11:45", end: "17:45" },
  wednesday: { label: "Wednesday", start: "11:45", end: "17:45" },
  saturday: { label: "Saturday", start: "08:30", end: "14:00" },
};

const storageKey = "house-help-signups-v2";
const childcareStorageKey = "house-help-childcare-needs-v1";
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
const calendarPage = document.getElementById("calendar-page");
const signupPage = document.getElementById("signup-page");
const schedulePanel = document.querySelector(".schedule-panel");
const dateInput = document.getElementById("date");
const startSelect = document.getElementById("start-time");
const endSelect = document.getElementById("end-time");
const monthLabel = document.getElementById("month-label");
const calendarGrid = document.getElementById("calendar-grid");
const dateDetail = document.getElementById("date-detail");
const adminPanel = document.getElementById("admin-panel");
const adminLoginBox = document.getElementById("admin-login-box");
const adminContent = document.getElementById("admin-content");
const adminEntries = document.getElementById("admin-entries");
const adminPasswordInput = document.getElementById("admin-password");
const adminChildcareForm = document.getElementById("admin-childcare-form");
const childcareDateInput = document.getElementById("childcare-date");
const childcareStartInput = document.getElementById("childcare-start");
const childcareEndInput = document.getElementById("childcare-end");
const childcareNotesInput = document.getElementById("childcare-notes");
const childcareNeedsList = document.getElementById("childcare-needs-list");
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
  const date = new Date(`${dateString}T12:00:00`);
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

  const date = new Date(`${dateValue}T12:00:00`);
  const weekday = date.getDay();

  if (weekday === 1 || weekday === 3) {
    return { label: "Monday/Wednesday", start: "11:45", end: "17:45" };
  }

  if (weekday === 6) {
    return { label: "Saturday", start: "08:30", end: "14:00" };
  }

  return null;
}

function getWeekdayName(dateValue) {
  const date = new Date(`${dateValue}T12:00:00`);
  return date.toLocaleDateString("en-US", { weekday: "long" });
}

function isPastDate(dateValue) {
  if (!dateValue) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const date = new Date(`${dateValue}T12:00:00`);
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
  try {
    const response = await fetch("/api/childcare-needs");
    if (!response.ok) {
      return state.childCareNeedsCache;
    }

    const needs = await response.json();
    state.childCareNeedsCache = needs.map((need, index) => ({
      ...need,
      id:
        need.id ||
        `childcare-${need.date || "unknown"}-${need.start || "00:00"}-${need.end || "00:00"}-${index}`,
    }));
    return state.childCareNeedsCache;
  } catch (error) {
    return state.childCareNeedsCache;
  }
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
  return getDateEntries(dateValue).filter((entry) => entry.type !== "childcare").length;
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
  try {
    const response = await fetch("/api/entries");
    if (!response.ok) {
      return state.entriesCache;
    }

    const entries = await response.json();
    state.entriesCache = entries.map((entry, index) => ({
      ...entry,
      id:
        entry.id ||
        `${entry.name || "volunteer"}-${entry.date || "unknown"}-${entry.start || "00:00"}-${entry.end || "00:00"}-${index}`,
    }));
    return state.entriesCache;
  } catch (error) {
    return state.entriesCache;
  }
}

async function saveEntries(entries) {
  const response = await fetch("/api/entries", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entries),
  });

  if (!response.ok) {
    throw new Error("Unable to save entries.");
  }

  const savedEntries = await response.json();
  state.entriesCache = savedEntries;
  return state.entriesCache;
}

async function deleteEntry(entryId) {
  const response = await fetch(`/api/entries/${entryId}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error("Unable to delete signup.");
  }

  state.entriesCache = state.entriesCache.filter((entry) => entry.id !== entryId);
  renderCalendar();
  renderSelectedDateDetail();
  renderAdminEntries();
}

function renderAdminEntries() {
  const entries = [...state.entriesCache].sort((a, b) => {
    if (a.date === b.date) {
      return toMinutes(a.start) - toMinutes(b.start);
    }
    return new Date(`${a.date}T12:00:00`) - new Date(`${b.date}T12:00:00`);
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

    const entries = getDateEntries(targetDate).sort((a, b) =>
      toMinutes(a.start) - toMinutes(b.start),
    );

    const details = [];

    if (childcareNeeds.length > 0) {
      details.push(`
        <div class="care-detail-block">
          <h4>Child care need</h4>
          <div class="admin-detail-list">
            ${childcareNeeds
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
              .join("")}
          </div>
        </div>
      `);
    }

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

    if (details.length === 0) {
      dateDetail.innerHTML = `
        <h3>${formatDate(targetDate)}</h3>
        <p class="detail-text">
          No volunteers or child care needs are scheduled for ${getWeekdayName(targetDate)}.
        </p>
      `;
      return;
    }

    dateDetail.innerHTML = `
      <h3>${formatDate(targetDate)}</h3>
      ${details.join("")}
    `;
    return;
  }

  const window = getAllowedWindow(targetDate);
  const summaries = summarizeSlotsForDate(targetDate);
  const generalSummaries = summaries.general;
  const childcareSummaries = summaries.childcare;
  const actionButton = `
    <button
      type="button"
      class="secondary volunteer-day-button"
      data-date="${targetDate}"
    >
      Sign up
    </button>
  `;

  const activeChildCareNeeds = childcareNeeds.filter((need) => !isChildCareNeedFilled(need));
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
      ${childCareMarkup || `
        <p class="detail-text">
          That date is not available for volunteering. Please choose a Monday,
          Wednesday, or Saturday.
        </p>
      `}
    `;
    return;
  }

  if (generalSummaries.length === 0 && childcareSummaries.length === 0 && activeChildCareNeeds.length === 0) {
    dateDetail.innerHTML = `
      <h3>${formatDate(targetDate)}</h3>
      <p class="detail-text">
        No volunteers are signed up yet for ${getWeekdayName(targetDate)}. Be the first to help.
      </p>
      ${actionButton}
    `;
    return;
  }

  const summaryRows = [];
  if (generalSummaries.length > 0) {
    summaryRows.push(
      ...generalSummaries.map(
        (slot) => `
          <div class="slot-row">
            <span>${formatTime(slot.start)} – ${formatTime(slot.end)}</span>
            <strong>House-building help: ${slot.count} volunteer${slot.count > 1 ? "s" : ""}</strong>
          </div>
        `,
      ),
    );
  }

  if (childcareSummaries.length > 0) {
    summaryRows.push(
      ...childcareSummaries.map(
        (slot) => `
          <div class="slot-row">
            <span>${formatTime(slot.start)} – ${formatTime(slot.end)}</span>
            <strong>Child care help: ${slot.count} volunteer${slot.count > 1 ? "s" : ""}</strong>
          </div>
        `,
      ),
    );
  }

  dateDetail.innerHTML = `
    <h3>${formatDate(targetDate)}</h3>
    <div class="slot-summary">
      ${summaryRows.join("")}
    </div>
    ${childCareMarkup}
    ${actionButton}
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

  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());

  const cells = [];

  for (let index = 0; index < 42; index += 1) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + index);

    const value = toDateInputValue(cellDate);
    const allowedWindow = getAllowedWindow(value);
    const generalCount = getGeneralVolunteerCount(value);
    const activeChildcareNeeds = getActiveChildCareNeedsForDate(value);
    const isCurrentMonth = cellDate.getMonth() === monthStart.getMonth();
    const isSelected = value === (state.selectedDate || dateInput.value);
    const isVolunteerDay = Boolean(allowedWindow);
    const isPast = isPastDate(value);
    const isDisabled = isPast || !isVolunteerDay;
    const badges = [];

    if (!isPast && activeChildcareNeeds.length > 0) {
      badges.push({
        text: `${activeChildcareNeeds.length} child care`,
        className: "day-count childcare",
      });
    }

    if (!isPast && generalCount > 0) {
      badges.push({
        text: `${generalCount} house help${generalCount > 1 ? "s" : ""}`,
        className: "day-count volunteer",
      });
    }

    if (!isPast && badges.length === 0 && isVolunteerDay) {
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
  adminPanel.classList.remove("hidden");
  showAdminButton.classList.add("hidden");
  logoutAdminButton.classList.remove("hidden");
  if (schedulePanel) {
    schedulePanel.classList.add("hidden");
  }
  renderAdminEntries();
  renderChildCareNeeds();
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

function renderChildCareNeeds() {
  const needs = [...state.childCareNeedsCache].sort((a, b) => {
    if (a.date === b.date) {
      return toMinutes(a.start) - toMinutes(b.start);
    }
    return new Date(`${a.date}T12:00:00`) - new Date(`${b.date}T12:00:00`);
  });

  if (!childcareNeedsList) {
    return;
  }

  if (needs.length === 0) {
    childcareNeedsList.innerHTML = `
      <div class="empty-state">
        No child care needs added yet.
      </div>
    `;
    return;
  }

  childcareNeedsList.innerHTML = needs
    .map(
      (need) => `
        <div class="care-row">
          <div>
            <strong>${formatDate(need.date)}</strong>
            <div>${formatTime(need.start)} – ${formatTime(need.end)}</div>
            ${need.notes ? `<div>${need.notes}</div>` : ""}
          </div>
          <button
            type="button"
            class="delete-entry"
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
}

function initCalendarSelection() {
  state.selectedDate = null;
  dateInput.value = "";
  showCalendarPage();
  populateTimeSelects(getNextAvailableDate(new Date()));
  renderCalendar();
  renderSelectedDateDetail();
  renderChildCareNeeds();
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
      ? [...state.childCareNeedsCache].find((item) => item.id === state.selectedNeedId)
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

    const validationMessage = validateRange(childcareStart, childcareEnd, dateValue);
    if (validationMessage) {
      window.alert(validationMessage);
      return;
    }

    const entries = [...state.entriesCache];
    entries.push({
      id: generateEntryId(),
      name,
      date: dateValue,
      contact,
      notes: notes || `Child care support for ${formatDate(dateValue)}`,
      start: childcareStart,
      end: childcareEnd,
      type: "childcare",
      needId: need.id,
    });

    await saveEntries(entries);
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

  const entries = [...state.entriesCache];
  entries.push({
    id: generateEntryId(),
    name,
    date: dateValue,
    contact,
    notes,
    start,
    end,
    type: "general",
  });

  await saveEntries(entries);
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

dateInput.addEventListener("change", () => {
  const nextValue = dateInput.value;
  if (!nextValue) return;
  setSelectedDate(nextValue);
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
    await fetch("/api/admin-logout", { method: "POST" });
  } catch (error) {
    // Ignore request failures here; the UI should still clear locally.
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

calendarGrid.addEventListener("click", (event) => {
  const dayButton = event.target.closest(".calendar-day");
  if (!dayButton || dayButton.disabled) return;

  const pickedDate = dayButton.dataset.date;
  setSelectedDate(pickedDate, { openForm: false });
});

dateDetail.addEventListener("click", async (event) => {
  const childcareDeleteButton = event.target.closest("[data-childcare-id]");
  if (childcareDeleteButton) {
    const childcareId = childcareDeleteButton.dataset.childcareId;
    if (!childcareId) return;

    const confirmed = window.confirm("Remove this child care need?");
    if (!confirmed) return;

    const updatedNeeds = [...state.childCareNeedsCache].filter((need) => need.id !== childcareId);
    await saveChildCareNeeds(updatedNeeds);
    renderChildCareNeeds();
    renderCalendar();
    renderSelectedDateDetail();
    return;
  }

  const deleteButton = event.target.closest(".delete-entry");
  if (deleteButton) {
    const entryId = deleteButton.dataset.entryId;
    if (!entryId) return;

    const confirmed = window.confirm("Remove this volunteer signup?");
    if (!confirmed) return;

    await deleteEntry(entryId);
    return;
  }

  const pageButton = event.target.closest(".admin-page-button");
  if (pageButton) {
    state.adminDetailPage = Number(pageButton.dataset.page || 1);
    renderSelectedDateDetail();
    return;
  }

  const childcareVolunteerButton = event.target.closest(".childcare-volunteer-button");
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

  await deleteEntry(entryId);
});

childcareNeedsList.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("[data-childcare-id]");
  if (!deleteButton) return;

  const childcareId = deleteButton.dataset.childcareId;
  if (!childcareId) return;

  const confirmed = window.confirm("Remove this child care need?");
  if (!confirmed) return;

  const updatedNeeds = [...state.childCareNeedsCache].filter((need) => need.id !== childcareId);
  await saveChildCareNeeds(updatedNeeds);
  renderChildCareNeeds();
  renderCalendar();
  renderSelectedDateDetail();
});

adminChildcareForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const dateValue = childcareDateInput.value;
  const start = childcareStartInput.value;
  const end = childcareEndInput.value;
  const notes = childcareNotesInput.value.trim();

  if (!dateValue || !start || !end) {
    window.alert("Please select a date and time range for the child care need.");
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

  await saveChildCareNeeds(needs);
  adminChildcareForm.reset();
  renderChildCareNeeds();
  renderCalendar();
  renderSelectedDateDetail();
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
  await loadEntries();
  await loadChildCareNeeds();
}

async function initializeApp() {
  await refreshServerData();
  initCalendarSelection();
  adminPanel.classList.add("hidden");
  adminLoginBox.classList.add("hidden");
  adminContent.classList.add("hidden");
  showAdminButton.classList.remove("hidden");
  logoutAdminButton.classList.add("hidden");
}

initializeApp();
