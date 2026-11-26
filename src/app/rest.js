// Read-only Firestore access over REST (no SDK, no open connection): used by digest.html, which runs in headless
// Chrome on the scheduled job and must finish loading. Values come back in the same shape the SDK gives.
const PROJECT = 'abud-24577';
const KEY = 'AIzaSyA_kaAFZtElUvI5kW3OGBAgCIj7_8az0rU';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

/** Firestore REST value → plain JS (timestamps as ISO strings). */
export function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromValue(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromValue);
  return null;
}

/** Every document of a collection as {id, ...fields}. */
export async function fetchCollection(name) {
  const out = [];
  let token = '';
  do {
    const url = `${BASE}/${name}?key=${KEY}&pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) {
      const fields = Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, x]) => [k, fromValue(x)]));
      out.push({ id: d.name.split('/').pop(), ...fields });
    }
    token = body.nextPageToken ?? '';
  } while (token);
  return out;
}

/** The named collections; one the rules refuse (not yet published) comes back missing, not as an error. */
export async function fetchAll(names) {
  const data = {};
  await Promise.all(names.map(async (n) => { try { data[n] = await fetchCollection(n); } catch { /* left out */ } }));
  return data;
}
