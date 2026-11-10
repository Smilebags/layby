const DB_NAME = "layby";
const DB_VERSION = 1;
const STORE = "trips";

let dbPromise;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("byStart", "startedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function db() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function addTrip(record) {
  omitPostcode(record);
  const database = await db();
  const tx = database.transaction(STORE, "readwrite");
  const id = await requestResult(tx.objectStore(STORE).add(record));
  return id;
}

export async function listTrips() {
  const database = await db();
  const read = database.transaction(STORE, "readonly");
  const finished = transactionDone(read);
  const rows = await requestResult(read.objectStore(STORE).getAll());
  await finished;
  const stale = rows.filter((row) => "startPostcode" in row || "endPostcode" in row);
  if (stale.length) {
    const write = database.transaction(STORE, "readwrite");
    const store = write.objectStore(STORE);
    for (const row of stale) {
      omitPostcode(row);
      store.put(row);
    }
    await transactionDone(write);
  }
  rows.sort((a, b) => b.startedAt - a.startedAt);
  return rows;
}

export async function updateTrip(id, patch) {
  const database = await db();
  const tx = database.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const record = await requestResult(store.get(id));
  if (!record) throw new Error("Trip is missing");
  Object.assign(record, patch);
  omitPostcode(record);
  await requestResult(store.put(record));
  return record;
}

function omitPostcode(record) {
  delete record.startPostcode;
  delete record.endPostcode;
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteTrip(id) {
  const database = await db();
  const tx = database.transaction(STORE, "readwrite");
  await requestResult(tx.objectStore(STORE).delete(id));
}
