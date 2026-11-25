// DOM helpers, formatting, input parsing and modal forms. All text goes in via textContent.
import { dec } from '../engine/decimal.js';

/** Create an element: h('div', {class: 'x', onclick: fn}, 'text', child, [more]). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

/** Today's date in Lagos as YYYY-MM-DD. */
export function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function fmtNaira(x) {
  if (x == null || x === '') return '—';
  const s = dec(x).toFixed(2);
  const neg = s.startsWith('-');
  const [i, f] = s.replace('-', '').split('.');
  return `${neg ? '−' : ''}₦${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}

/** A fraction shown as a percentage: 0.0075 -> "0.750%". */
export function fmtPct(x, dp = 3) {
  if (x == null || x === '') return '—';
  return `${dec(x).times(100).toFixed(dp)}%`;
}

/** Parse a naira amount typed by a person into a 2 dp string. */
export function parseMoney(v, label, { allowZero = false } = {}) {
  const s = String(v ?? '').replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`${label}: enter an amount such as 1,000,000.00`);
  const d = dec(s);
  if (!allowZero && d.lte(0)) throw new Error(`${label} must be more than zero`);
  return d.toFixed(2);
}

/** Parse a percentage typed by a person ("21.5") into a fraction string ("0.215"). */
export function parsePercent(v, label) {
  const s = String(v ?? '').replace(/[%\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${label}: enter a percentage such as 21.5`);
  return dec(s).div(100).toFixed();
}

/** Parse a plain positive decimal ("100.2345"). */
export function parseDecimal(v, label) {
  const s = String(v ?? '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s) || dec(s).lte(0)) throw new Error(`${label}: enter a positive number`);
  return dec(s).toFixed();
}

export function toast(message, kind = 'ok') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

/** Friendly text for Firebase errors. */
export function errorText(err) {
  const code = err?.code ?? '';
  if (code === 'permission-denied' || /insufficient permissions/i.test(err?.message ?? '')) {
    return 'The database refused this change. Check the values entered, and that firestore.rules has been published in the Firebase console.';
  }
  return err?.message ?? String(err);
}

/**
 * Modal form. fields: [{name, label, type, options, required, value, help, showIf(values)}]
 * types: text, date, money, percent, decimal, number, select, textarea, checkboxes.
 * onSubmit(values) may throw; its message shows in the form. Resolves true when saved.
 */
export function openForm({ title, intro, fields, submitLabel = 'Save', onSubmit }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'modal', 'aria-label': title });
    const rows = {};
    const inputs = {};
    let saved = false;

    const fieldEls = fields.map((f) => {
      const id = `f-${f.name}`;
      let input;
      if (f.type === 'select') {
        input = h(
          'select',
          { id, name: f.name, value: f.value ?? '' },
          f.placeholder ? h('option', { value: '' }, f.placeholder) : null,
          (f.options ?? []).map((o) => h('option', { value: o.value }, o.label)),
        );
      } else if (f.type === 'textarea') {
        input = h('textarea', { id, name: f.name, rows: 3, value: f.value ?? '' });
      } else if (f.type === 'checkboxes') {
        const chosen = new Set(f.value ?? []);
        input = h(
          'div',
          { class: 'checks', id },
          (f.options ?? []).length
            ? f.options.map((o) =>
                h('label', { class: 'check' }, h('input', { type: 'checkbox', value: o.value, checked: chosen.has(o.value) }), ' ', o.label),
              )
            : h('div', { class: 'muted' }, f.emptyText ?? 'Nothing to choose from yet.'),
        );
      } else {
        const type = f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text';
        const mode = ['money', 'percent', 'decimal'].includes(f.type) ? 'decimal' : undefined;
        input = h('input', { id, name: f.name, type, inputmode: mode, value: f.value ?? '', autocomplete: 'off' });
      }
      inputs[f.name] = input;
      const row = h(
        'div',
        { class: 'field' },
        h('label', { for: id }, f.label, f.required ? h('span', { class: 'req' }, ' *') : null),
        input,
        f.help ? h('div', { class: 'help' }, f.help) : null,
      );
      rows[f.name] = row;
      return row;
    });

    const values = () => {
      const v = {};
      for (const f of fields) {
        const el = inputs[f.name];
        v[f.name] = f.type === 'checkboxes' ? [...el.querySelectorAll('input:checked')].map((c) => c.value) : el.value.trim();
      }
      return v;
    };
    const visible = (f, v) => !f.showIf || f.showIf(v);
    const refresh = () => {
      const v = values();
      for (const f of fields) rows[f.name].hidden = !visible(f, v);
    };

    const errorBox = h('div', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'primary' }, submitLabel);
    const form = h(
      'form',
      { novalidate: true },
      h('h2', null, title),
      intro ? h('p', { class: 'muted' }, intro) : null,
      fieldEls,
      errorBox,
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), submit),
    );
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.textContent = '';
      const v = values();
      for (const f of fields) {
        if (f.required && visible(f, v) && (Array.isArray(v[f.name]) ? v[f.name].length === 0 : v[f.name] === '')) {
          errorBox.textContent = `${f.label} is required.`;
          inputs[f.name].focus?.();
          return;
        }
      }
      for (const f of fields) if (!visible(f, v)) delete v[f.name];
      submit.disabled = true;
      try {
        await onSubmit(v);
        saved = true;
        dialog.close();
      } catch (err) {
        errorBox.textContent = errorText(err);
      } finally {
        submit.disabled = false;
      }
    });

    dialog.append(form);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(saved);
    });
    document.body.append(dialog);
    refresh();
    dialog.showModal();
  });
}

/** Yes/no confirmation. Resolves true on confirm. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    const dialog = h(
      'dialog',
      { class: 'modal', 'aria-label': title },
      h('h2', null, title),
      h('p', null, message),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'button', class: danger ? 'danger' : 'primary', onclick: () => { ok = true; dialog.close(); } }, confirmLabel),
      ),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(ok);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Run an async action from a button, with a toast on success or failure. */
export async function runAction(button, fn, successMessage) {
  if (button) button.disabled = true;
  try {
    await fn();
    if (successMessage) toast(successMessage);
  } catch (err) {
    toast(errorText(err), 'bad');
  } finally {
    if (button) button.disabled = false;
  }
}

/** A table wrapped for horizontal scroll on narrow screens. */
export function table(headers, rows, emptyText = 'Nothing here yet.') {
  if (!rows.length) return h('p', { class: 'muted empty' }, emptyText);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h('thead', null, h('tr', null, headers.map((x) => h('th', { class: x.num ? 'num' : null }, x.label ?? x)))),
      h('tbody', null, rows),
    ),
  );
}
