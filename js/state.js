export const state = {
  initialized: false,
  csrfToken: "",
  currentMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDate: null,
  adminAuthenticated: false,
  adminDetailPage: 1,
  signupType: "general",
  selectedNeedId: null,
  entriesCache: [],
  childCareNeedsCache: [],
};

export const form = document.getElementById("signup-form");
export const appToast = document.getElementById("app-toast");
export const appToastMessage = document.getElementById("app-toast-message");
export const serverLoadError = document.getElementById("server-load-error");
export const retryServerLoadButton = document.getElementById("retry-server-load");
export const calendarPage = document.getElementById("calendar-page");
export const signupPage = document.getElementById("signup-page");
export const schedulePanel = document.querySelector(".schedule-panel");
export const dateInput = document.getElementById("date");
export const startSelect = document.getElementById("start-time");
export const endSelect = document.getElementById("end-time");
export const monthLabel = document.getElementById("month-label");
export const calendarGrid = document.getElementById("calendar-grid");
export const dateDetail = document.getElementById("date-detail");
export const dayDetailsDialog = document.getElementById("day-details-dialog");
export const adminPanel = document.getElementById("admin-panel");
export const adminLoginBox = document.getElementById("admin-login-box");
export const adminContent = document.getElementById("admin-content");
export const adminEntries = document.getElementById("admin-entries");
export const adminPasswordInput = document.getElementById("admin-password");
export const signupTypeSelect = document.getElementById("signup-type");
export const showAdminButton = document.getElementById("show-admin");
export const logoutAdminButton = document.getElementById("logout-admin");
