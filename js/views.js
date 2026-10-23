import {
  state, dateInput, monthLabel, calendarGrid, dateDetail, adminEntries,
  adminLoginBox, adminContent, adminPanel, adminPasswordInput,
  showAdminButton, logoutAdminButton, schedulePanel,
} from "./state.js";
import {
  toMinutes, parseDateValue, formatDate, formatTime, toDateInputValue,
  getAllowedWindow, isPastDate,
} from "./date-time.js";
import {
  getDateEntries, getChildCareNeedsForDate, isChildCareNeedFilled,
  summarizeSlotsForDate, getActiveChildCareNeedsForDate,
  getGeneralVolunteerCount,
} from "./data.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function refreshViews() {
  renderCalendar();
  renderSelectedDateDetail();
  renderAdminEntries();
}

export function renderAdminEntries() {
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
          <th>Phone</th>
          <th>Notes</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${entries
          .map(
            (entry) => `
              <tr>
                <td>${escapeHtml(entry.name)}</td>
                <td>${formatDate(entry.date)}</td>
                <td>${formatTime(entry.start)} – ${formatTime(entry.end)}</td>
                <td>${escapeHtml(entry.contact || "Not provided")}</td>
                <td>${escapeHtml(entry.notes || "—")}</td>
                <td>
                  <button
                    type="button"
                    class="delete-entry"
                    data-entry-id="${escapeHtml(entry.id)}"
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

export function renderSelectedDateDetail() {
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
                      <strong>${escapeHtml(entry.name)}</strong>
                      <div>${formatTime(entry.start)} – ${formatTime(entry.end)}</div>
                      <div>${escapeHtml(entry.contact || "No contact provided")}</div>
                      ${entry.notes ? `<div>${escapeHtml(entry.notes)}</div>` : ""}
                    </div>
                    <button
                      type="button"
                      class="delete-entry admin-delete-entry"
                      data-entry-id="${escapeHtml(entry.id)}"
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
              ${need.notes ? `<div>${escapeHtml(need.notes)}</div>` : ""}
            </div>
            <button
              type="button"
              class="delete-entry admin-delete-entry"
              data-childcare-id="${escapeHtml(need.id)}"
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
        <form class="admin-childcare-form" data-date="${escapeHtml(targetDate)}">
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
            <input name="notes" type="text" maxlength="2000" placeholder="Optional details" />
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
            data-date="${escapeHtml(targetDate)}"
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
                  ${need.notes ? `<div>${escapeHtml(need.notes)}</div>` : ""}
                </div>
                <button
                  type="button"
                  class="secondary childcare-volunteer-button"
                  data-date="${escapeHtml(targetDate)}"
                  data-need-id="${escapeHtml(need.id)}"
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

export function renderCalendar() {
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

export function updateAdminView() {
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
  refreshViews();
}
