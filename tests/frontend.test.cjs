const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

async function loadApp({ delayInitialLoad = false, initialFailure = false } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        value: "", innerHTML: "", textContent: "", hidden: false,
        disabled: false, handlers: {},
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name),
        },
        addEventListener(type, handler) { this.handlers[type] = handler; },
        setAttribute() {},
        close() { this.open = false; },
        showModal() { this.open = true; },
        scrollIntoView() {},
        reset() {
          for (const input of elements.values()) input.value = "";
          this.resetCount = (this.resetCount || 0) + 1;
        },
      });
    }
    return elements.get(id);
  }

  const requests = [];
  const alerts = [];
  let confirm = true;
  let fail = initialFailure;
  let conflictMessage = "";
  let releaseInitialLoad;
  const initialLoad = new Promise((resolve) => { releaseInitialLoad = resolve; });
  const context = vm.createContext({
    document: { getElementById: element, querySelector: element },
    window: {
      crypto: { randomUUID: () => "test-entry" },
      setTimeout: () => 1, clearTimeout() {},
      alert: (message) => alerts.push(message),
      confirm: () => confirm,
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      if (delayInitialLoad && url === "/api/entries" && !options.method) {
        await initialLoad;
      }
      let data = [];
      if (url === "/api/admin-status") data = { isAdmin: false, csrfToken: "test-csrf" };
      else if (url === "/api/admin-logout") data = { ok: true };
      else if (options.method === "POST") {
        data = { entry: { ...JSON.parse(options.body), id: "server-entry" } };
      } else if (options.method === "PUT") data = JSON.parse(options.body);
      else if (options.method === "DELETE") data = { ok: true };
      const conflict = conflictMessage && options.method;
      return {
        ok: !fail && !conflict,
        status: conflict ? 409 : fail ? 500 : 200,
        json: async () => conflict ? { error: conflictMessage } : data,
      };
    },
  });
  const modules = new Map();
  function load(filename) {
    if (!modules.has(filename)) {
      modules.set(filename, readFile(filename, "utf8").then((source) =>
        new vm.SourceTextModule(source, { context, identifier: filename })));
    }
    return modules.get(filename);
  }
  const entry = await load(path.join(__dirname, "..", "js", "script.js"));
  await entry.link((specifier, parent) =>
    load(path.resolve(path.dirname(parent.identifier), specifier)));
  await entry.evaluate();
  if (!delayInitialLoad) await entry.namespace.appReady;
  const namespace = async (name) =>
    (await modules.get(path.join(__dirname, "..", "js", name))).namespace;
  return {
    element, requests, alerts,
    state: (await namespace("state.js")).state,
    data: await namespace("data.js"),
    views: await namespace("views.js"),
    ready: entry.namespace.appReady,
    releaseInitialLoad,
    setFailure(value) { fail = value; },
    setConflict(message) { conflictMessage = message; },
    setConfirmation(value) { confirm = value; },
  };
}

function fillSignup(app) {
  const values = {
    name: "Test Volunteer", contact: "801-555-1234", notes: "",
    date: "2099-01-05", "start-time": "11:45", "end-time": "12:45",
  };
  for (const [id, value] of Object.entries(values)) app.element(id).value = value;
}

test("initialization and calendar clicks work without implicit globals", async () => {
  const app = await loadApp();
  assert.match(app.element("calendar-grid").innerHTML, /calendar-day/);
  assert.equal(app.element("server-load-error").hidden, true);
  app.element("calendar-grid").handlers.click({
    target: { closest: () => ({ dataset: { date: "2099-01-05" } }) },
  });
  assert.equal(app.state.selectedDate, "2099-01-05");
  assert.equal(app.element("day-details-dialog").open, true);
});

for (const type of ["general", "childcare"]) {
  test(`${type} signup uses shared completion flow`, async () => {
    const app = await loadApp();
    fillSignup(app);
    app.state.signupType = type;
    app.state.selectedNeedId = type === "childcare" ? "need-1" : null;
    app.state.childCareNeedsCache = [{
      id: "need-1", date: "2099-01-05", start: "09:00", end: "10:00",
    }];
    await app.element("signup-form").handlers.submit({ preventDefault() {} });
    assert.equal(app.alerts.length, 0);
    const request = app.requests.find((request) => request.method === "POST");
    const entry = JSON.parse(request.body);
    assert.equal(entry.type, type);
    assert.equal(entry.id, undefined);
    assert.equal(app.state.entriesCache[0].id, "server-entry");
    assert.equal(entry.start, type === "childcare" ? "09:00" : "11:45");
    assert.equal(entry.end, type === "childcare" ? "10:00" : "12:45");
    if (type === "childcare") {
      assert.equal(entry.needId, "need-1");
      assert.match(entry.notes, /Child care support/);
    }
    assert.equal(app.element("signup-form").resetCount, 1);
    assert.equal(app.element("date").value, "2099-01-05");
    assert.equal(app.state.signupType, "general");
    assert.equal(app.state.selectedNeedId, null);
    assert.equal(app.state.entriesCache.length, 1);
    assert.equal(app.element("signup-page").classList.contains("hidden"), true);
  });
}

test("signup can be submitted without contact information", async () => {
  const app = await loadApp();
  fillSignup(app);
  app.element("contact").value = "";
  await app.element("signup-form").handlers.submit({ preventDefault() {} });
  assert.equal(app.alerts.length, 0);
  const request = app.requests.find((request) => request.method === "POST");
  assert.equal(JSON.parse(request.body).contact, "");
});

test("phone formats automatically and reminder consent is optional and reset", async () => {
  const app = await loadApp();
  const phone = app.element("contact");
  const option = app.element("reminder-option");
  const checkbox = app.element("reminder-opt-in");
  assert.equal(option.hidden, true);
  assert.equal(checkbox.disabled, true);
  phone.value = "(801) 555-1234";
  phone.handlers.input();
  assert.equal(phone.value, "801-555-1234");
  assert.equal(option.hidden, false);
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  phone.value = "";
  phone.handlers.input();
  assert.equal(option.hidden, true);
  assert.equal(checkbox.checked, false);
  fillSignup(app);
  phone.handlers.input();
  checkbox.checked = true;
  await app.element("signup-form").handlers.submit({ preventDefault() {} });
  const request = app.requests.find((request) => request.method === "POST");
  const entry = JSON.parse(request.body);
  assert.equal(entry.contact, "801-555-1234");
  assert.equal(entry.reminderOptIn, true);
  assert.equal(option.hidden, true);
  assert.equal(checkbox.checked, false);
});

test("phone accepts pasted country code but rejects email and incomplete numbers", async () => {
  const app = await loadApp();
  fillSignup(app);
  const phone = app.element("contact");
  phone.value = "+1 (801) 555-1234";
  phone.handlers.input();
  assert.equal(phone.value, "801-555-1234");
  for (const value of ["person@example.invalid", "801-555", "123-456-7890"]) {
    phone.value = value;
    await app.element("signup-form").handlers.submit({ preventDefault() {} });
    assert.equal(app.element("reminder-option").hidden, true);
  }
  assert.equal(app.alerts.length, 3);
  assert.equal(app.requests.some((request) => request.method === "POST"), false);
});

test("valid phone without consent does not request a reminder", async () => {
  const app = await loadApp();
  fillSignup(app);
  await app.element("signup-form").handlers.submit({ preventDefault() {} });
  const request = app.requests.find((request) => request.method === "POST");
  assert.equal(JSON.parse(request.body).reminderOptIn, false);
});

test("failed signup preserves form and cache and shows an error", async () => {
  const app = await loadApp();
  fillSignup(app);
  app.setFailure(true);
  await app.element("signup-form").handlers.submit({ preventDefault() {} });
  assert.equal(app.element("name").value, "Test Volunteer");
  assert.equal(app.element("signup-form").resetCount, undefined);
  assert.equal(app.state.entriesCache.length, 0);
  assert.match(app.element("app-toast-message").textContent, /couldn't submit/);
});

test("childcare booking conflicts explain the rejection without clearing the form", async () => {
  const app = await loadApp();
  fillSignup(app);
  app.state.signupType = "childcare";
  app.state.selectedNeedId = "need-1";
  app.state.childCareNeedsCache = [{
    id: "need-1", date: "2099-01-05", start: "09:00", end: "10:00",
  }];
  const message = "This child care time is already covered. Reload the calendar.";
  app.setConflict(message);
  await app.element("signup-form").handlers.submit({ preventDefault() {} });
  assert.equal(app.element("app-toast-message").textContent, message);
  assert.equal(app.element("name").value, "Test Volunteer");
  assert.equal(app.state.entriesCache.length, 0);
  assert.equal(app.element("signup-form").resetCount, undefined);
});

test("blocked need deletion keeps cached needs and displays the server explanation", async () => {
  const app = await loadApp();
  app.state.childCareNeedsCache = [{
    id: "need-1", date: "2099-01-05", start: "09:00", end: "10:00",
  }];
  const message = "This need has volunteer signups. Remove those signups first.";
  app.setConflict(message);
  await app.element("date-detail").handlers.click({
    target: { closest: (selector) => selector === "[data-childcare-id]"
      ? { dataset: { childcareId: "need-1" } } : null },
  });
  assert.equal(app.element("app-toast-message").textContent, message);
  assert.equal(app.state.childCareNeedsCache.length, 1);
  assert.equal(app.state.childCareNeedsCache[0].id, "need-1");
});

test("invalid ranges do not submit", async () => {
  const app = await loadApp();
  fillSignup(app);
  app.element("end-time").value = "11:45";
  await app.element("signup-form").handlers.submit({ preventDefault() {} });
  assert.match(app.alerts[0], /later than/);
  assert.equal(app.requests.some((request) => request.method === "POST"), false);
});

for (const surface of ["date-detail", "admin-entries"]) {
  test(`${surface} uses shared delete confirmation and error handling`, async () => {
    const app = await loadApp();
    app.state.entriesCache = [{
      id: "entry-1", date: "2099-01-05", start: "11:45", end: "12:45",
    }];
    const event = { target: { closest: (selector) =>
      selector === ".delete-entry" ? { dataset: { entryId: "entry-1" } } : null,
    } };
    app.setConfirmation(false);
    await app.element(surface).handlers.click(event);
    assert.equal(app.requests.some((request) => request.method === "DELETE"), false);
    app.setConfirmation(true);
    app.setFailure(true);
    await app.element(surface).handlers.click(event);
    assert.equal(app.state.entriesCache.length, 1);
    assert.match(app.element("app-toast-message").textContent, /couldn't save/);
    app.setFailure(false);
    await app.element(surface).handlers.click(event);
    assert.equal(app.state.entriesCache.length, 0);
    assert.match(app.element("app-toast-message").textContent, /signup removed/);
  });
}

test("API helpers preserve methods, JSON bodies, and operation-specific errors", async () => {
  const app = await loadApp();
  const needs = [{ id: "need-1", date: "2099-01-05", start: "09:00", end: "10:00" }];
  await app.data.saveChildCareNeeds(needs);
  const request = app.requests.find((request) => request.method === "PUT");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers["X-CSRF-Token"], "test-csrf");
  assert.deepEqual(JSON.parse(request.body), needs);
  app.setFailure(true);
  for (const [operation, message] of [
    [() => app.data.loadEntries(), "Unable to load volunteer sign-ups."],
    [() => app.data.loadChildCareNeeds(), "Unable to load child care needs."],
    [() => app.data.saveChildCareNeeds([]), "Unable to save child care needs."],
    [() => app.data.addEntry({}), "Unable to save signup."],
    [() => app.data.deleteEntry("entry-1"), "Unable to delete signup."],
  ]) {
    await assert.rejects(operation, { message });
  }
  assert.equal(app.state.childCareNeedsCache.length, 1);
});

test("legacy entry IDs cannot change the deletion URL path", async () => {
  const app = await loadApp();
  const id = "../childcare-needs/other?value=1";
  await app.data.deleteEntry(id);
  const request = app.requests.find((request) => request.method === "DELETE");
  assert.equal(request.url, `/api/entries/${encodeURIComponent(id)}`);
});

test("slow initialization blocks interaction until server loading finishes", async () => {
  const app = await loadApp({ delayInitialLoad: true });
  assert.equal(app.state.initialized, false);
  assert.equal(app.element("calendar-page").inert, true);
  fillSignup(app);
  await app.element("signup-form").handlers.submit({ preventDefault() {} });
  app.element("calendar-grid").handlers.click({
    target: { closest: () => ({ dataset: { date: "2099-01-05" } }) },
  });
  assert.equal(app.state.selectedDate, null);
  assert.equal(app.requests.some((request) => request.method === "POST"), false);
  app.releaseInitialLoad();
  await app.ready;
  assert.equal(app.state.initialized, true);
  assert.equal(app.element("calendar-page").inert, false);
  assert.equal(app.element("app-loading").hidden, true);
});

test("failed initialization stays blocked and Retry restores the app", async () => {
  const app = await loadApp({ initialFailure: true });
  assert.equal(app.state.initialized, false);
  assert.equal(app.element("server-load-error").hidden, false);
  assert.equal(app.element("calendar-page").inert, true);
  app.setFailure(false);
  await app.element("retry-server-load").handlers.click();
  assert.equal(app.state.initialized, true);
  assert.equal(app.element("server-load-error").hidden, true);
});

test("logout reloads public state and restores volunteer windows", async () => {
  const app = await loadApp();
  app.state.adminAuthenticated = true;
  app.state.entriesCache = [{
    id: "private-entry", date: "2099-01-05", start: "11:45", end: "12:45",
    name: "Private volunteer", contact: "private@example.invalid",
  }];
  app.views.updateAdminView();
  assert.equal(app.element(".schedule-panel").classList.contains("hidden"), true);
  await app.element("logout-admin").handlers.click();
  assert.equal(app.state.adminAuthenticated, false);
  assert.equal(app.state.entriesCache.length, 0);
  assert.equal(app.element(".schedule-panel").classList.contains("hidden"), false);
  assert.equal(app.element("admin-content").classList.contains("hidden"), true);
});

test("stored HTML is escaped in admin tables, day details, and public care notes", async () => {
  const app = await loadApp();
  const payload = '<img src=x onerror="alert(1)">';
  app.state.entriesCache = [{
    id: '" onmouseover="alert(1)', date: "2099-01-05",
    start: "11:45", end: "12:45", name: payload, contact: payload, notes: payload,
  }];
  app.state.childCareNeedsCache = [{
    id: '" onclick="alert(1)', date: "2099-01-05",
    start: "09:00", end: "10:00", notes: payload,
  }];
  app.state.selectedDate = "2099-01-05";
  app.state.adminAuthenticated = true;
  app.views.refreshViews();
  for (const id of ["admin-entries", "date-detail"]) {
    const html = app.element(id).innerHTML;
    assert.equal(html.includes(payload), false);
    assert.match(html, /&lt;img/);
    assert.match(html, /&quot;/);
    assert.doesNotMatch(html, /data-(?:entry|childcare)-id="" /);
  }
  app.state.adminAuthenticated = false;
  app.views.renderSelectedDateDetail();
  assert.equal(app.element("date-detail").innerHTML.includes(payload), false);
  assert.match(app.element("date-detail").innerHTML, /&lt;img/);
});

test("slot summaries keep types, counts, dates, and ordering", async () => {
  const app = await loadApp();
  app.state.entriesCache = [
    { date: "2099-01-05", start: "13:00", end: "14:00" },
    { date: "2099-01-05", start: "11:45", end: "12:45", type: "general" },
    { date: "2099-01-05", start: "11:45", end: "12:45", type: "general" },
    { date: "2099-01-05", start: "09:00", end: "10:00", type: "childcare" },
    { date: "2099-01-06", start: "11:45", end: "12:45" },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(app.data.summarizeSlotsForDate("2099-01-05"))), {
    general: [
      { start: "11:45", end: "12:45", count: 2 },
      { start: "13:00", end: "14:00", count: 1 },
    ],
    childcare: [{ start: "09:00", end: "10:00", count: 1 }],
  });
});
