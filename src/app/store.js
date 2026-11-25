// Live app state: every collection the screens use, kept in sync with Firestore through onSnapshot.
import { db, collection, onSnapshot } from './firebase.js';

export const COLLECTIONS = ['transactions', 'instruments', 'mandateTerms', 'funds', 'fundPrices'];

export const state = {
  data: {},
  loaded: new Set(),
  errors: {},
  /** True when nothing has loaded 10 s after start (database missing, offline or blocked). */
  stalled: false,
};

const listeners = new Set();
let started = false;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn();
}

export function start() {
  if (started) return;
  started = true;
  setTimeout(() => {
    if (state.loaded.size === 0) {
      state.stalled = true;
      emit();
    }
  }, 10_000);
  for (const name of COLLECTIONS) {
    onSnapshot(
      collection(db, name),
      (snap) => {
        state.data[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        state.loaded.add(name);
        state.stalled = false;
        delete state.errors[name];
        emit();
      },
      (err) => {
        state.errors[name] = err.message;
        emit();
      },
    );
  }
}

export function loadedAll(names) {
  return names.every((n) => state.loaded.has(n));
}
