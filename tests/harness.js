// Minimal in-browser test runner: describe / it / expect. No install needed.

const suites = [];
let current = { name: '', tests: [], children: [] };
const root = current;

export function describe(name, fn) {
  const parent = current;
  const suite = { name, tests: [], children: [] };
  parent.children.push(suite);
  current = suite;
  try {
    fn();
  } finally {
    current = parent;
  }
}

export function it(name, fn) {
  current.tests.push({ name, fn });
}

function fmt(v) {
  if (v && typeof v === 'object' && typeof v.toFixed === 'function' && typeof v.plus === 'function') return `Decimal(${v.toString()})`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function expect(actual) {
  const fail = (msg) => {
    throw new Error(msg);
  };
  return {
    toBe(expected) {
      if (!Object.is(actual, expected)) fail(`expected ${fmt(actual)} to be ${fmt(expected)}`);
    },
    toEqual(expected) {
      if (!deepEqual(actual, expected)) fail(`expected ${fmt(actual)} to equal ${fmt(expected)}`);
    },
    toHaveLength(n) {
      if (actual?.length !== n) fail(`expected length ${n}, got ${actual?.length}`);
    },
    toContain(item) {
      if (!actual?.includes?.(item)) fail(`expected ${fmt(actual)} to contain ${fmt(item)}`);
    },
    notToContain(item) {
      if (actual?.includes?.(item)) fail(`expected ${fmt(actual)} not to contain ${fmt(item)}`);
    },
    toMatchObject(expected) {
      for (const [k, v] of Object.entries(expected)) {
        if (!deepEqual(actual?.[k], v)) fail(`expected .${k} to be ${fmt(v)}, got ${fmt(actual?.[k])}`);
      }
    },
    toThrow(pattern) {
      let threw = false;
      let message = '';
      try {
        actual();
      } catch (e) {
        threw = true;
        message = String(e?.message ?? e);
      }
      if (!threw) fail('expected function to throw');
      if (pattern instanceof RegExp && !pattern.test(message)) fail(`expected error matching ${pattern}, got "${message}"`);
    },
    notToThrow() {
      try {
        actual();
      } catch (e) {
        fail(`expected no throw, got "${e?.message ?? e}"`);
      }
    },
  };
}

/** Runs every registered test and returns { passed, failed, results }. */
export async function run() {
  const results = [];
  async function walk(suite, path) {
    const here = suite.name ? [...path, suite.name] : path;
    for (const t of suite.tests) {
      const name = [...here, t.name].join(' > ');
      try {
        await t.fn();
        results.push({ name, ok: true });
      } catch (e) {
        results.push({ name, ok: false, error: String(e?.message ?? e) });
      }
    }
    for (const child of suite.children) await walk(child, here);
  }
  await walk(root, []);
  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, results };
}

export { suites };
