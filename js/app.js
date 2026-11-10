import { createTracker } from "./tracker.js";
import { haversineMeters } from "./geo.js";
import { addTrip, deleteTrip, listTrips, updateTrip } from "./db.js";
import { nearestPlace } from "./places.js";
import { recordsFromImport, tripDocument } from "./transfer.js";
import {
  formatClock,
  formatCoords,
  formatDay,
  formatDistance,
  formatDuration,
  formatPointTime,
  formatTripDuration,
  formatTripTime,
  formatSpeed,
} from "./format.js";

const SESSION_KEY = "layby-active";
const PHASE = {
  idle: "Ready",
  locating: "Finding GPS",
  waiting: "At the start",
  driving: "Driving",
  stationary: "Stopped",
  parked: "Parked",
  paused: "Paused",
};

const tracker = createTracker();
const deck = document.querySelector("#deck");
const phaseLabel = document.querySelector("#phase-label");
const dial = document.querySelector("#dial");
const caption = document.querySelector("#caption");
const clock = document.querySelector("#clock");
const route = document.querySelector("#route");
const speedEl = document.querySelector("#speed");
const travelledEl = document.querySelector("#travelled");
const stillEl = document.querySelector("#still");
const hint = document.querySelector("#hint");
const accuracyEl = document.querySelector("#accuracy");
const primary = document.querySelector("#primary");
const fileButton = document.querySelector("#file");
const discardButton = document.querySelector("#discard");
const errorEl = document.querySelector("#error");
const list = document.querySelector("#list");
const countEl = document.querySelector("#count");
const totalEl = document.querySelector("#total");
const live = document.querySelector("#live");
const toast = document.querySelector("#toast");
const storageChip = document.querySelector("#storage");
const wakeChip = document.querySelector("#wake");
const installButton = document.querySelector("#install");

let lastView = tracker.peek(Date.now());
let lastReading = null;
let priorReading = null;
let watchId = null;
let tickTimer = null;
let wakeLock = null;
let wakeState = "unknown";
let trips = [];
let announcedPhase = "";
let toastTimer = 0;
let highlightId = null;
const filedKeys = new Set();

primary.addEventListener("click", () => {
  if (lastView.mode === "paused") resume();
  else if (lastView.mode === "tracking") endTracking();
  else begin();
});

fileButton.addEventListener("click", endTracking);
discardButton.addEventListener("click", () => {
  unwatch();
  stopTimers();
  releaseWake();
  handle(tracker.discard(), null);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || lastView.mode !== "tracking") return;
  acquireWake().then(() => render(lastView));
  handle(tracker.tick(Date.now()), null);
});

window.addEventListener("pagehide", persistSession);

let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  installButton.hidden = false;
});

installButton.addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installButton.hidden = true;
});

const debugLogEl = document.querySelector("#debug-log");
const debugCopy = document.querySelector("#debug-copy");

function debug(message) {
  const stamp = new Date().toISOString().slice(11, 23);
  debugLogEl.textContent += `${debugLogEl.textContent ? "\n" : ""}${stamp} ${message}`;
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

function gestureNote() {
  const activation = navigator.userActivation;
  if (!activation) return "activation api missing";
  return `tap active ${activation.isActive}, earlier tap ${activation.hasBeenActive}`;
}

let geoPermission = "unknown";

async function logEnvironment() {
  let permission = "permissions API missing";
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: "geolocation" });
      permission = status.state;
      geoPermission = status.state;
      status.addEventListener("change", () => {
        geoPermission = status.state;
        debug(`permission changed to ${status.state}`);
      });
    }
  } catch (error) {
    permission = `query failed: ${error.name} ${error.message}`;
  }
  let allowed = "unknown";
  try {
    if (document.permissionsPolicy?.allowsFeature) allowed = String(document.permissionsPolicy.allowsFeature("geolocation"));
  } catch (error) {
    allowed = `failed ${error.name}`;
  }
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  debug(`browser ${navigator.userAgent}`);
  debug(`page ${location.href}`);
  debug(`secure ${window.isSecureContext}; display ${standalone ? "standalone" : "browser"}`);
  debug(`geolocation ${"geolocation" in navigator}; permission ${permission}; policy allows ${allowed}`);
  debug(`service worker ${navigator.serviceWorker?.controller ? navigator.serviceWorker.controller.scriptURL : "none"}`);
}

debugCopy.addEventListener("click", async () => {
  const text = debugLogEl.textContent;
  try {
    await navigator.clipboard.writeText(text);
    debugCopy.textContent = "Copied";
  } catch (error) {
    debugCopy.textContent = "Select the log and copy";
    debug(`copy failed: ${error.name}`);
  }
  setTimeout(() => {
    debugCopy.textContent = "Copy log";
  }, 2500);
});

boot();

async function boot() {
  if (location.protocol === "file:") {
    showError("Open Layby from a local web server so GPS and saved trips can work.");
    primary.disabled = true;
    render(lastView);
    return;
  }
  loadSession();
  render(lastView);
  logEnvironment();
  await refresh();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then(() => {
      storageChip.textContent = "Works offline";
    }).catch(() => {});
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    tracker.restore(JSON.parse(raw));
    lastView = tracker.peek(Date.now());
  } catch {
    localStorage.removeItem(SESSION_KEY);
  }
}

async function begin() {
  showError("");
  const view = tracker.start(Date.now());
  handle(view, null);
  // Location has to be requested in this tap. Waiting for the wake lock first makes the browser skip the prompt.
  debug(`Start tapped. ${gestureNote()}`);
  watch("start");
  startTimers();
  render(lastView);
  await acquireWake();
  render(lastView);
}

async function resume() {
  showError("");
  const view = tracker.resume(Date.now());
  handle(view, null);
  debug(`Resume tapped. ${gestureNote()}`);
  watch("resume");
  startTimers();
  render(lastView);
  await acquireWake();
  render(lastView);
}

async function endTracking() {
  const view = tracker.stop(Date.now());
  unwatch();
  stopTimers();
  await releaseWake();
  handle(view, null);
}

function watch(reason) {
  debug(`watch (${reason}): ${gestureNote()}`);
  if (!window.isSecureContext) {
    debug("watch stopped: page is not a secure context");
    showError("Location needs a secure page. Open Layby with https, or as localhost on this device.");
    unwatch();
    stopTimers();
    releaseWake();
    handle(tracker.discard(), null);
    return;
  }
  if (!navigator.geolocation) {
    debug("watch stopped: navigator.geolocation is missing");
    showError("This browser has no GPS, so a trip can't be recorded.");
    unwatch();
    stopTimers();
    releaseWake();
    handle(tracker.discard(), null);
    return;
  }
  unwatch();
  try {
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 25000,
    });
    debug(`watchPosition returned ${watchId}`);
  } catch (error) {
    debug(`watchPosition threw ${error.name}: ${error.message}`);
    showError("Location could not be requested.");
  }
}

function unwatch() {
  if (watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
}

let lastFixLog = 0;

function onPosition(position) {
  const now = Date.now();
  if (now - lastFixLog > 15000) {
    lastFixLog = now;
    debug(`position received, accuracy ${Math.round(position.coords.accuracy)} m`);
  }
  const reading = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracy: position.coords.accuracy,
    speed: position.coords.speed,
    t: Date.now(),
  };
  if (lastReading && reading.t !== lastReading.t) priorReading = lastReading;
  lastReading = reading;
  showError("");
  handle(tracker.fix(reading), reading);
}

function onGeoError(error) {
  const names = { 1: "PERMISSION_DENIED", 2: "POSITION_UNAVAILABLE", 3: "TIMEOUT" };
  debug(`position error ${error.code} ${names[error.code] || "UNKNOWN"}: ${error.message}`);
  if (error.code === 1) {
    const iphone = /iPhone|iPad/.test(navigator.userAgent);
    showError(
      iphone && geoPermission === "prompt"
        ? "Firefox never asked about this site. On the iPhone, open Settings, then Privacy & Security, Location Services, Firefox, and choose While Using the App. Then tap Start again."
        : "Location is blocked. Allow location for this site, then start again.",
    );
    if (lastView.startedAt == null && lastView.phase !== "parked") {
      unwatch();
      stopTimers();
      releaseWake();
      handle(tracker.discard(), null);
    }
    return;
  }
  showError("Waiting for a GPS fix.");
}

function startTimers() {
  stopTimers();
  tickTimer = setInterval(() => {
    handle(tracker.tick(Date.now()), null);
  }, 1000);
}

function stopTimers() {
  if (tickTimer != null) clearInterval(tickTimer);
  tickTimer = null;
}

async function acquireWake() {
  if (!("wakeLock" in navigator)) {
    wakeState = "failed";
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeState = "on";
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      if (wakeState === "on") wakeState = "unknown";
    });
  } catch {
    wakeState = "failed";
  }
}

async function releaseWake() {
  wakeState = "unknown";
  try {
    await wakeLock?.release();
  } catch {
    // Already released.
  }
  wakeLock = null;
}

function handle(view, reading) {
  if (reading) {
    if (lastReading && reading !== lastReading && reading.t !== lastReading.t) priorReading = lastReading;
    lastReading = reading;
  }
  lastView = view;
  render(view);
  persistSession();
  if (view.finished) fileTrip(view.finished);
}

function persistSession() {
  try {
    const data = tracker.serialize();
    if (!data) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    // Private mode can block storage. The open trip still runs in memory.
  }
}

function render(view) {
  deck.dataset.phase = view.phase;
  phaseLabel.textContent = PHASE[view.phase] ?? "Ready";
  caption.textContent = captionFor(view);
  clock.textContent = formatClock(view.elapsedMs);
  route.textContent = routeText(view);
  speedEl.textContent = formatSpeed(speedKmh());
  travelledEl.textContent = formatDistance(view.distanceM);
  stillEl.textContent = view.savable ? formatClock(view.dwellMs) : "–";
  speedEl.parentElement.setAttribute("aria-label", `Speed ${speedEl.textContent} kilometres per hour`);
  travelledEl.parentElement.setAttribute("aria-label", `Travelled ${travelledEl.textContent}`);
  stillEl.parentElement.setAttribute("aria-label", `Still ${stillEl.textContent}`);
  hint.textContent = hintFor(view);
  accuracyEl.textContent = accuracyText(view);
  const progress = view.savable ? Math.min(1, view.dwellMs / view.stopMs) : 0;
  dial.style.setProperty("--p", progress.toFixed(4));
  dial.classList.toggle("is-driving", view.phase === "driving");
  dial.classList.toggle("is-stopped", view.phase === "stationary");
  syncActions(view);
  syncWake(view);
  if (view.phase !== announcedPhase && !view.finished) {
    announcedPhase = view.phase;
    live.textContent = `${PHASE[view.phase]}. ${route.textContent}`;
  }
}

function captionFor(view) {
  if (view.holding) return "Trip time";
  if (view.phase === "parked") return "Next trip";
  if (view.phase === "idle") return "Ready";
  return "Elapsed";
}

function routeText(view) {
  if (view.phase === "idle") return "No trip in progress.";
  if (view.phase === "locating" || !view.start) return "Waiting for the start location.";
  const start = formatCoords(view.start.lat, view.start.lon);
  if (view.phase === "parked") return `Next start ${start}`;
  const here = lastReading ?? view.start;
  const now = formatCoords(here.lat, here.lon);
  if (start === now) return `Start ${start}`;
  return `Start ${start}. Now ${now}.`;
}

function hintFor(view) {
  switch (view.phase) {
    case "locating":
      return "Finding a GPS fix for the start. The phone's location works without a connection.";
    case "waiting":
      return "Start location and time are saved. The trip ends after you drive and then stay still for five minutes, or when you end it.";
    case "driving":
      return "GPS is recording. Five minutes in one place ends the trip. End trip records the stop now.";
    case "stationary":
      if (view.confirming) return "Checking the last GPS points, then the trip will be saved.";
      return `Ending in ${formatClock(view.remainingMs)}. The saved end time is the moment you stopped.`;
    case "parked":
      return "Trip saved. Another starts when you move. Stop ends tracking.";
    case "paused":
      if (view.confirming) return "Five minutes still have passed. Resume files this trip.";
      return "Tracking is paused. Resume keeps this trip going.";
    default:
      return "This is the new Layby. Tap Start and allow location. A trip ends after five minutes in one place, or when you end it here.";
  }
}

function accuracyText(view) {
  if (view.accuracy == null || view.mode === "idle") return "";
  if (view.accuracy <= 30 && view.phase !== "locating") return "";
  return `GPS accuracy about ${Math.round(view.accuracy)} m`;
}

function syncActions(view) {
  fileButton.hidden = true;
  discardButton.hidden = true;
  primary.hidden = false;
  primary.disabled = location.protocol === "file:";
  if (view.mode === "paused") {
    primary.textContent = "Resume";
    discardButton.hidden = false;
    fileButton.hidden = view.startedAt == null;
    return;
  }
  if (view.mode === "tracking") {
    if (view.phase === "locating") primary.textContent = "Cancel";
    else if (view.phase === "parked") primary.textContent = "Stop";
    else primary.textContent = "End trip";
    return;
  }
  primary.textContent = "Start";
}

function syncWake(view) {
  if (view.mode !== "tracking" || wakeState === "unknown") {
    wakeChip.hidden = true;
    return;
  }
  wakeChip.hidden = false;
  wakeChip.textContent = wakeState === "on" ? "Screen stays on" : "Keep the screen on";
  wakeChip.classList.toggle("is-warn", wakeState === "failed");
}

function speedKmh() {
  if (!lastReading) return null;
  if (typeof lastReading.speed === "number" && lastReading.speed >= 0) return lastReading.speed * 3.6;
  if (!priorReading) return null;
  const dt = (lastReading.t - priorReading.t) / 1000;
  if (dt < 1 || dt > 30) return null;
  const kmh = (haversineMeters(priorReading, lastReading) / dt) * 3.6;
  if (kmh > 220) return null;
  return kmh;
}

async function fileTrip(finished) {
  const key = [
    finished.startedAt,
    finished.endedAt,
    finished.start.lat.toFixed(5),
    finished.end.lat.toFixed(5),
  ].join(":");
  if (filedKeys.has(key)) return;
  filedKeys.add(key);
  const record = {
    startedAt: finished.startedAt,
    endedAt: finished.endedAt,
    distanceM: Math.round(finished.distanceM),
    start: roundPoint(finished.start),
    end: roundPoint(finished.end),
    startAddress: "",
    endAddress: "",
  };
  try {
    record.id = await addTrip(record);
  } catch {
    record.id = `local-${key}`;
    trips.unshift(record);
    showError("Couldn't store the trip. It will stay on screen until you close the page.");
    announce(record);
    renderList(record.id);
    return;
  }
  announce(record);
  await refresh(record.id);
}

function announce(record, verb = "saved") {
  const message = `Trip ${verb}. ${formatPointTime(record.startedAt, record.startedAt)} to ${formatPointTime(record.endedAt, record.startedAt)}, ${formatDuration(record.endedAt - record.startedAt)}.`;
  toast.textContent = message;
  toast.hidden = false;
  live.textContent = message;
  announcedPhase = lastView.phase;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 7000);
}

function roundPoint(point) {
  return {
    lat: Math.round(point.lat * 1e6) / 1e6,
    lon: Math.round(point.lon * 1e6) / 1e6,
  };
}

async function refresh(nextHighlight) {
  try {
    const stored = await listTrips();
    const local = trips.filter((trip) => typeof trip.id !== "number");
    trips = [...local, ...stored].sort((a, b) => b.startedAt - a.startedAt);
    showError("");
  } catch {
    showError("Couldn't read the saved log on this device.");
  }
  renderList(nextHighlight);
}

function renderList(nextHighlight) {
  if (nextHighlight != null) highlightId = nextHighlight;
  paintList();
}

function paintList() {
  countEl.textContent = trips.length ? `${trips.length} ${trips.length === 1 ? "trip" : "trips"}` : "";
  const ordered = [...trips].sort((a, b) => b.startedAt - a.startedAt);
  const totalMinutes = ordered.reduce((sum, trip) => sum + tripMinutes(trip), 0);
  totalEl.hidden = ordered.length === 0;
  totalEl.textContent = ordered.length ? `Total ${formatTripDuration(totalMinutes * 60000)}` : "";
  list.replaceChildren();
  if (!ordered.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty";
    cell.textContent = "No trips yet. Start a drive, or add one with its times and a map.";
    row.append(cell);
    list.append(row);
    return;
  }
  for (const trip of ordered) list.append(tripRow(trip));
  highlightId = null;
}

function tripMinutes(trip) {
  const ms = Number(trip.endedAt) - Number(trip.startedAt);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms / 60000));
}

function tripRow(trip) {
  const row = document.createElement("tr");
  if (trip.id === highlightId) row.className = "is-new";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "icon-button";
  edit.setAttribute("aria-label", "Edit");
  edit.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
  edit.addEventListener("click", () => openImport(trip));
  const action = document.createElement("td");
  action.append(edit);
  row.append(
    textCell(formatDay(trip.startedAt), "trip-date"),
    textCell(`${nearestPlace(trip.start).name} to ${nearestPlace(trip.end).name}`, "trip-route"),
    textCell(formatTripTime(trip.startedAt), "trip-time"),
    textCell(formatTripDuration(trip.endedAt - trip.startedAt), "trip-duration"),
    action,
  );
  return row;
}

function textCell(text, className) {
  const cell = document.createElement("td");
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

const addTripButton = document.querySelector("#add-trip");
const importDialog = document.querySelector("#import");
const importForm = document.querySelector("#import-form");
const importTitle = document.querySelector("#import-title");
const importNote = document.querySelector("#import-note");
const importStart = document.querySelector("#import-start");
const importEnd = document.querySelector("#import-end");
const pickStartButton = document.querySelector("#pick-start");
const pickEndButton = document.querySelector("#pick-end");
const pickReadout = document.querySelector("#pick-readout");
const importError = document.querySelector("#import-error");
const importSave = document.querySelector("#import-save");
const importRemove = document.querySelector("#import-remove");
const importCancel = document.querySelector("#import-cancel");

const ADD_NOTE = "Enter the two times, then tap the map for the start and the end. Street tiles load when you are online.";
const EDIT_NOTE = "Change the times, or tap the map to move the start and the end. Street tiles load when you are online.";

let importMap = null;
let importArmed = "start";
let importSaving = false;
let editingId = null;
const importPicks = { start: null, end: null };
const importMarkers = { start: null, end: null };
let importLine = null;

addTripButton.addEventListener("click", () => openImport());

const exportJsonButton = document.querySelector("#export-json");
const copyJsonButton = document.querySelector("#copy-json");
const importJsonButton = document.querySelector("#import-json");
const pasteJsonButton = document.querySelector("#paste-json");
const importFile = document.querySelector("#import-file");

exportJsonButton.addEventListener("click", saveTripFile);
copyJsonButton.addEventListener("click", copyTripJson);
importJsonButton.addEventListener("click", () => importFile.click());
pasteJsonButton.addEventListener("click", pasteTripJson);
importFile.addEventListener("change", () => {
  const file = importFile.files?.[0];
  importFile.value = "";
  if (file) importTripFile(file);
});

function saveTripFile() {
  const payload = tripDocument(trips);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = "layby-trips.json";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showError("");
  live.textContent = countPhrase(payload.trips.length, "Saved");
}

async function copyTripJson() {
  const payload = tripDocument(trips);
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    showError("");
    live.textContent = countPhrase(payload.trips.length, "Copied");
  } catch {
    showError("Couldn't copy the JSON. Save a file instead.");
  }
}

async function importTripFile(file) {
  try {
    await importTripText(await file.text());
  } catch (error) {
    showError(error.message || "That file could not be imported.");
  }
}

async function pasteTripJson() {
  try {
    if (!navigator.clipboard?.readText) {
      showError("This browser can't read the clipboard. Load a file instead.");
      return;
    }
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      showError("The clipboard is empty.");
      return;
    }
    await importTripText(text);
  } catch (error) {
    showError(error.name === "NotAllowedError"
      ? "Clipboard access was blocked. Allow it, or load a file instead."
      : (error.message || "Couldn't read the clipboard."));
  }
}

async function importTripText(text) {
  const result = recordsFromImport(text, trips);
  if (!result.trips.length) {
    showError(result.duplicate && !result.unreadable
      ? "Those trips are already in this log."
      : "Nothing in that JSON could be imported.");
    return;
  }
  for (const record of result.trips) await addTrip(record);
  showError("");
  const skipped = [];
  if (result.duplicate) skipped.push(`${result.duplicate} already saved`);
  if (result.unreadable) skipped.push(`${result.unreadable} unreadable`);
  const count = result.trips.length === 1 ? "1 trip" : `${result.trips.length} trips`;
  live.textContent = skipped.length ? `Imported ${count}. Skipped ${skipped.join(" and ")}.` : `Imported ${count}.`;
  await refresh();
}

function countPhrase(count, verb) {
  return `${verb} ${count === 1 ? "1 trip" : `${count} trips`}.`;
}

importCancel.addEventListener("click", () => importDialog.close());
importRemove.addEventListener("click", removeEditing);
pickStartButton.addEventListener("click", () => armImport("start"));
pickEndButton.addEventListener("click", () => armImport("end"));
importForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveImport();
});

function openImport(trip) {
  const editing = Boolean(trip);
  editingId = editing ? trip.id : null;
  resetImport();
  importTitle.textContent = editing ? "Edit trip" : "Add a trip";
  importNote.textContent = editing ? EDIT_NOTE : ADD_NOTE;
  importSave.textContent = editing ? "Save changes" : "Save trip";
  importRemove.hidden = !editing;
  importRemove.dataset.armed = "";
  importRemove.textContent = "Remove";
  if (editing) {
    importStart.value = toDatetimeLocal(trip.startedAt);
    importEnd.value = toDatetimeLocal(trip.endedAt);
    importPicks.start = { lat: trip.start.lat, lon: trip.start.lon };
    importPicks.end = { lat: trip.end.lat, lon: trip.end.lon };
  }
  importDialog.showModal();
  ensureImportMap();
  if (editing && importMap) {
    placeImportPoint("start", { lat: trip.start.lat, lng: trip.start.lon });
    placeImportPoint("end", { lat: trip.end.lat, lng: trip.end.lon });
  } else {
    updateImportReadout();
  }
  requestAnimationFrame(() => {
    if (!importMap) return;
    importMap.invalidateSize();
    if (editing) fitImport();
  });
}

function resetImport() {
  importPicks.start = null;
  importPicks.end = null;
  importStart.value = "";
  importEnd.value = "";
  importSaving = false;
  showImportError("");
  armImport("start");
  if (importMap) {
    for (const which of ["start", "end"]) {
      if (importMarkers[which]) {
        importMap.removeLayer(importMarkers[which]);
        importMarkers[which] = null;
      }
    }
    if (importLine) {
      importMap.removeLayer(importLine);
      importLine = null;
    }
  }
  updateImportReadout();
}

function armImport(which) {
  importArmed = which;
  pickStartButton.setAttribute("aria-pressed", which === "start" ? "true" : "false");
  pickEndButton.setAttribute("aria-pressed", which === "end" ? "true" : "false");
}

function ensureImportMap() {
  if (importMap) {
    importMap.invalidateSize();
    return;
  }
  const Leaflet = globalThis.L;
  if (!Leaflet) {
    showImportError("The map could not load.");
    return;
  }
  importMap = Leaflet.map(document.querySelector("#map"), { zoomControl: true }).setView([-43.0825, 147.2472], 14);
  Leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(importMap);
  importMap.on("click", (event) => {
    placeImportPoint(importArmed, event.latlng);
    if (importArmed === "start" && !importPicks.end) armImport("end");
  });
  if (!navigator.geolocation) {
    debug("map recenter skipped: no geolocation");
    return;
  }
  debug(`map recenter requested. ${gestureNote()}`);
  navigator.geolocation.getCurrentPosition((position) => {
    debug(`map position received, accuracy ${Math.round(position.coords.accuracy)} m`);
    if (importPicks.start || importPicks.end || !importMap) return;
    importMap.setView([position.coords.latitude, position.coords.longitude], 14);
  }, (error) => {
    const names = { 1: "PERMISSION_DENIED", 2: "POSITION_UNAVAILABLE", 3: "TIMEOUT" };
    debug(`map position error ${error.code} ${names[error.code] || "UNKNOWN"}: ${error.message}`);
  }, { enableHighAccuracy: true, maximumAge: 120000, timeout: 5000 });
}

function placeImportPoint(which, latlng) {
  importPicks[which] = { lat: latlng.lat, lon: latlng.lng };
  if (!importMap) {
    updateImportReadout();
    return;
  }
  if (importMarkers[which]) {
    importMarkers[which].setLatLng(latlng);
  } else {
    importMarkers[which] = globalThis.L.marker(latlng, {
      icon: pinIcon(which),
      draggable: true,
      keyboard: true,
      alt: which === "start" ? "Start location" : "End location",
    }).addTo(importMap);
    importMarkers[which].on("dragend", () => {
      const point = importMarkers[which].getLatLng();
      importPicks[which] = { lat: point.lat, lon: point.lng };
      syncImportLine();
      updateImportReadout();
    });
  }
  syncImportLine();
  updateImportReadout();
}

function pinIcon(which) {
  return globalThis.L.divIcon({
    className: `pin pin-${which}`,
    html: `<span>${which === "start" ? "S" : "E"}</span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function fitImport() {
  if (!importMap || !importPicks.start || !importPicks.end) return;
  const bounds = globalThis.L.latLngBounds(
    [importPicks.start.lat, importPicks.start.lon],
    [importPicks.end.lat, importPicks.end.lon],
  );
  if (bounds.getSouthWest().equals(bounds.getNorthEast())) {
    importMap.setView(bounds.getCenter(), 15);
    return;
  }
  importMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
}

function syncImportLine() {
  if (!importMap) return;
  if (importLine) {
    importMap.removeLayer(importLine);
    importLine = null;
  }
  if (!importPicks.start || !importPicks.end) return;
  importLine = globalThis.L.polyline([
    [importPicks.start.lat, importPicks.start.lon],
    [importPicks.end.lat, importPicks.end.lon],
  ], { color: "#8f3f22", weight: 3, opacity: 0.85 }).addTo(importMap);
}

function updateImportReadout() {
  pickReadout.textContent = `${placedText("start", "Start")} ${placedText("end", "End")}`;
  showImportError("");
}

function placedText(which, label) {
  const point = importPicks[which];
  if (!point) return `${label} not placed.`;
  return `${label} ${nearestPlace(point).name}, ${formatCoords(point.lat, point.lon)}.`;
}

async function removeEditing() {
  if (editingId == null || importSaving) return;
  if (importRemove.dataset.armed !== "1") {
    importRemove.dataset.armed = "1";
    importRemove.textContent = "Confirm remove";
    return;
  }
  importSaving = true;
  try {
    if (typeof editingId === "number") await deleteTrip(editingId);
    trips = trips.filter((trip) => trip.id !== editingId);
    importDialog.close();
    paintList();
  } catch {
    showImportError("Couldn't remove that trip.");
  } finally {
    importSaving = false;
  }
}

function showImportError(message) {
  importError.hidden = !message;
  importError.textContent = message || "";
}

function toDatetimeLocal(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value || "");
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second || 0), 0).getTime();
}

async function saveImport() {
  if (importSaving) return;
  const startedAt = parseLocalDateTime(importStart.value);
  const endedAt = parseLocalDateTime(importEnd.value);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    showImportError("Enter both the start time and the end time.");
    return;
  }
  if (endedAt <= startedAt) {
    showImportError("The end time has to be later than the start time.");
    return;
  }
  if (!importPicks.start || !importPicks.end) {
    showImportError("Place the start and the end on the map.");
    return;
  }
  importSaving = true;
  const patch = {
    startedAt,
    endedAt,
    distanceM: Math.round(haversineMeters(importPicks.start, importPicks.end)),
    start: roundPoint(importPicks.start),
    end: roundPoint(importPicks.end),
  };
  try {
    if (editingId == null) {
      const record = {
        ...patch,
        startAddress: "",
        endAddress: "",
      };
      record.id = await addTrip(record);
      importDialog.close();
      announce(record);
      await refresh(record.id);
      return;
    }
    const existing = trips.find((trip) => trip.id === editingId);
    if (!existing) {
      showImportError("That trip is no longer in the log.");
      return;
    }
    if (typeof editingId === "number") await updateTrip(editingId, patch);
    Object.assign(existing, patch);
    importDialog.close();
    announce(existing, "updated");
    await refresh(existing.id);
  } catch {
    showImportError("Couldn't save the trip on this device.");
  } finally {
    importSaving = false;
  }
}
