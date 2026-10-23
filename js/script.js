import {
  state,
  form,
  appToast,
  appToastMessage,
  serverLoadError,
  retryServerLoadButton,
  calendarPage,
  calendarGrid,
  signupPage,
  schedulePanel,
  dateInput,
  startSelect,
  endSelect,
  dateDetail,
  dayDetailsDialog,
  adminPanel,
  adminLoginBox,
  adminContent,
  adminEntries,
  adminPasswordInput,
  signupTypeSelect,
  showAdminButton,
  logoutAdminButton,
} from "./state.js";
import {
  toMinutes, formatTime, formatDate, getNextAvailableDate,
  getAllowedWindow, isPastDate, buildTimeOptions,
} from "./date-time.js";
import {
  loadChildCareNeeds, saveChildCareNeeds,
  getChildCareNeedsForDate, getActiveChildCareNeedsForDate,
  getSelectedChildCareNeed, getCurrentTimeWindow,
  generateEntryId, loadEntries, addEntry, deleteEntry, requestJson, ApiError,
} from "./data.js";
import {
  renderSelectedDateDetail, renderCalendar, refreshViews, updateAdminView,
} from "./views.js";

const phoneInput = document.getElementById("contact");
const reminderOption = document.getElementById("reminder-option");
const reminderCheckbox = document.getElementById("reminder-opt-in");

function updatePhoneField() {
  const raw = phoneInput.value.trim();
  if (/^\+?[0-9() .-]*$/.test(raw)) {
    let digits = raw.replace(/[^0-9]/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    if (digits.length <= 10) {
      phoneInput.value = digits.length > 6
        ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
        : digits.length > 3
          ? `${digits.slice(0, 3)}-${digits.slice(3)}`
          : digits;
    }
  }
  const valid = /^[2-9][0-9]{2}-[2-9][0-9]{2}-[0-9]{4}$/.test(phoneInput.value);
  reminderOption.hidden = !valid;
  reminderCheckbox.disabled = !valid;
  if (!valid) reminderCheckbox.checked = false;
  return valid;
}

phoneInput.addEventListener("input", updatePhoneField);
updatePhoneField();

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
  startSelect.innerHTML = `
    <option value="">Choose a start time</option>
    ${times.map((time) => `<option value="${time}">${formatTime(time)}</option>`).join("")}
  `;
  endSelect.innerHTML = '<option value="">Choose an end time</option>';

  startSelect.disabled = false;
  endSelect.disabled = true;
}

function updateEndOptions() {
  const startTime = startSelect.value;
  const window = getCurrentTimeWindow(dateInput.value);

  if (!window) {
    return;
  }

  if (!startTime) {
    endSelect.innerHTML = '<option value="">Choose an end time</option>';
    endSelect.disabled = true;
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

  endSelect.innerHTML = `
    <option value="">Choose an end time</option>
    ${validEndTimes.map((time) => `<option value="${time}">${formatTime(time)}</option>`).join("")}
  `;

  endSelect.disabled = false;
  endSelect.value = "";
}

async function submitVolunteerEntry(entry) {
  try {
    await addEntry(entry);
    showToast("Your volunteer signup was submitted successfully.");
    return true;
  } catch (error) {
    showToast(
      error instanceof ApiError && error.status === 409
        ? error.message
        : "We couldn't submit your signup. Please try again.",
      "error",
    );
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
    showToast(
      error instanceof ApiError && error.status === 409
        ? error.message
        : "We couldn't save that change. Please try again.",
      "error",
    );
  }
}

async function retryLoadingServerData() {
  retryServerLoadButton.disabled = true;
  retryServerLoadButton.textContent = "Retrying...";

  try {
    await initializeApp();
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

async function confirmDeleteEntry(entryId) {
  if (!entryId || !window.confirm("Remove this volunteer signup?")) return;

  await runAdminMutation(
    async () => {
      await deleteEntry(entryId);
      refreshViews();
    },
    "Volunteer signup removed.",
  );
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
  if (!state.initialized) {
    showToast("Please wait for sign-up information to load, or use Retry.", "error");
    return;
  }

  const name = document.getElementById("name").value.trim();
  const dateValue = dateInput.value;
  const validPhone = updatePhoneField();
  const contact = phoneInput.value.trim();
  const notes = document.getElementById("notes").value.trim();
  const start = startSelect.value;
  const end = endSelect.value;

  if (!name) {
    window.alert("Please provide a name.");
    return;
  }

  if (contact && !validPhone) {
    window.alert("Please provide a valid 10-digit phone number, or leave it blank.");
    return;
  }

  if (!dateValue) {
    window.alert("Please select a date.");
    return;
  }

  let entry = {
    name,
    date: dateValue,
    contact,
    reminderOptIn: validPhone && reminderCheckbox.checked === true,
    notes,
    start,
    end,
    type: "general",
  };

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

    entry = {
      ...entry,
      notes: notes || `Child care support for ${formatDate(dateValue)}`,
      start: childcareStart,
      end: childcareEnd,
      type: "childcare",
      needId: need.id,
    };
  }

  const validationMessage = validateRange(entry.start, entry.end, dateValue);
  if (validationMessage) {
    window.alert(validationMessage);
    return;
  }

  if (!(await submitVolunteerEntry(entry))) return;
  state.selectedDate = dateValue;
  state.signupType = "general";
  state.selectedNeedId = null;
  signupTypeSelect.value = "general";
  form.reset();
  reminderCheckbox.checked = false;
  updatePhoneField();
  dateInput.value = dateValue;
  refreshViews();
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
    await requestJson("/api/admin-logout", "Unable to log out.", {
      method: "POST",
    });
  } catch (error) {
    showToast("We couldn't log you out. Please try again.", "error");
    return;
  }

  state.adminAuthenticated = false;
  adminPanel.classList.remove("hidden");
  showAdminButton.classList.add("hidden");
  logoutAdminButton.classList.add("hidden");
  if (schedulePanel) {
    schedulePanel.classList.remove("hidden");
  }
  adminLoginBox.classList.remove("hidden");
  adminContent.classList.add("hidden");
  adminPasswordInput.value = "";
  state.entriesCache = [];
  await initializeApp();
});

document.getElementById("admin-login").addEventListener("click", async () => {
  const passwordAttempt = adminPasswordInput.value.trim();

  try {
    const response = await fetch("/api/admin-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": state.csrfToken,
      },
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
  if (!state.initialized) return;
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
    await confirmDeleteEntry(deleteButton.dataset.entryId);
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

  await confirmDeleteEntry(deleteButton.dataset.entryId);
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
  state.initialized = false;
  calendarPage.inert = true;
  signupPage.inert = true;
  showAdminButton.disabled = true;
  logoutAdminButton.disabled = true;
  const loadingMessage = document.getElementById("app-loading");
  loadingMessage.hidden = false;
  try {
    const result = await requestJson("/api/admin-status", "Unable to load session.", {
      cache: "no-store",
    });
    state.csrfToken = result.csrfToken;
    state.adminAuthenticated = result.isAdmin === true;
    await refreshServerData();
    serverLoadError.hidden = true;
    initCalendarSelection();
    adminPanel.classList.add("hidden");
    adminLoginBox.classList.add("hidden");
    adminContent.classList.add("hidden");
    showAdminButton.classList.remove("hidden");
    logoutAdminButton.classList.add("hidden");
    if (state.adminAuthenticated) {
      updateAdminView();
    }
    state.initialized = true;
    calendarPage.inert = false;
    signupPage.inert = false;
    showAdminButton.disabled = false;
    logoutAdminButton.disabled = false;
  } catch (error) {
    serverLoadError.hidden = false;
  } finally {
    loadingMessage.hidden = true;
  }
}

export const appReady = initializeApp();
