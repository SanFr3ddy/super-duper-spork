/**
 * Utilidades de interfaz: modales, confirmaciones, toasts, formularios y estados vacíos.
 * Las vistas construyen HTML con template strings y usan estas funciones para interacción.
 */
import { esc } from './format';
import { ApiError } from './api';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
export function toast(message: string, kind: 'ok' | 'error' = 'ok', ms = 3200): void {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/** Muestra el error de una llamada a la API (o cualquier error) como toast. */
export function showError(err: unknown, fallback = 'Ocurrió un error'): void {
  const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback;
  toast(msg || fallback, 'error', 4500);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
export interface ModalHandle {
  el: HTMLElement; // .modal
  body: HTMLElement; // .modal-body
  close: () => void;
}

let openModals: ModalHandle[] = [];

export function openModal(opts: { title: string; html: string; wide?: boolean; onClose?: () => void }): ModalHandle {
  const root = document.getElementById('modal-root')!;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <div class="modal-head">
        <h2>${esc(opts.title)}</h2>
        <button type="button" class="btn ghost icon" data-close aria-label="Cerrar">✕</button>
      </div>
      <div class="modal-body">${opts.html}</div>
    </div>`;
  root.appendChild(backdrop);
  const modal = backdrop.querySelector<HTMLElement>('.modal')!;
  const body = backdrop.querySelector<HTMLElement>('.modal-body')!;

  const close = (): void => {
    backdrop.remove();
    openModals = openModals.filter((m) => m !== handle);
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && openModals[openModals.length - 1] === handle) close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));

  const handle: ModalHandle = { el: modal, body, close };
  openModals.push(handle);
  // Foco al primer control
  setTimeout(() => {
    const first = body.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
  }, 30);
  return handle;
}

/**
 * Abre un modal con un <form> ya incluido en `html` (el primer <form> del cuerpo).
 * onSubmit recibe los valores como objeto {name: value}. Si onSubmit lanza, se muestra el error y el modal sigue abierto.
 */
export function formModal(opts: {
  title: string;
  html: string;
  wide?: boolean;
  submitLabel?: string;
  onSubmit: (values: Record<string, string>, form: HTMLFormElement, modal: ModalHandle) => Promise<void> | void;
  onOpen?: (form: HTMLFormElement, modal: ModalHandle) => void;
}): ModalHandle {
  const modal = openModal({ title: opts.title, html: opts.html, wide: opts.wide });
  const form = modal.body.querySelector('form') as HTMLFormElement | null;
  if (!form) throw new Error('formModal requiere un <form> en html');
  if (!form.querySelector('.form-actions')) {
    form.insertAdjacentHTML(
      'beforeend',
      `<div class="form-actions">
        <button type="button" class="btn ghost" data-close>Cancelar</button>
        <button type="submit" class="btn primary">${esc(opts.submitLabel ?? 'Guardar')}</button>
      </div>`,
    );
  }
  form.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', modal.close));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]');
    if (submit) submit.disabled = true;
    try {
      await opts.onSubmit(formValues(form), form, modal);
    } catch (err) {
      showError(err);
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  opts.onOpen?.(form, modal);
  return modal;
}

/** Lee todos los campos con name de un formulario. Checkboxes: 'on' o ''. */
export function formValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  const fd = new FormData(form);
  form.querySelectorAll<HTMLInputElement>('input[type=checkbox][name]').forEach((c) => (out[c.name] = c.checked ? 'on' : ''));
  fd.forEach((v, k) => {
    if (typeof v === 'string') out[k] = v;
  });
  return out;
}

/** Convierte un valor de input a número; lanza si no es válido. */
export function toNumber(v: string, field = 'monto'): number {
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error(`El campo ${field} no es un número válido`);
  return n;
}

/** Diálogo de confirmación. Resuelve true si el usuario acepta. */
export function confirmDialog(message: string, opts: { title?: string; okLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const modal = openModal({
      title: opts.title ?? 'Confirmar',
      html: `<p class="text-2">${esc(message)}</p>
        <div class="form-actions">
          <button type="button" class="btn ghost" data-cancel>Cancelar</button>
          <button type="button" class="btn ${opts.danger === false ? 'primary' : 'danger'}" data-ok>${esc(opts.okLabel ?? 'Eliminar')}</button>
        </div>`,
      onClose: () => {
        if (!decided) resolve(false);
      },
    });
    modal.body.querySelector('[data-cancel]')!.addEventListener('click', () => {
      decided = true;
      modal.close();
      resolve(false);
    });
    modal.body.querySelector('[data-ok]')!.addEventListener('click', () => {
      decided = true;
      modal.close();
      resolve(true);
    });
  });
}

// ---------------------------------------------------------------------------
// Fragmentos de HTML reutilizables
// ---------------------------------------------------------------------------
export function field(label: string, inputHtml: string, help?: string): string {
  return `<div class="field"><label>${esc(label)}</label>${inputHtml}${help ? `<span class="help">${esc(help)}</span>` : ''}</div>`;
}

export function input(name: string, opts: { type?: string; value?: string | number | null; placeholder?: string; required?: boolean; step?: string; min?: string | number; max?: string | number; autocomplete?: string; id?: string } = {}): string {
  const attrs = [
    `type="${opts.type ?? 'text'}"`,
    `name="${esc(name)}"`,
    opts.id ? `id="${esc(opts.id)}"` : '',
    opts.value !== undefined && opts.value !== null ? `value="${esc(opts.value)}"` : '',
    opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : '',
    opts.required ? 'required' : '',
    opts.step ? `step="${opts.step}"` : '',
    opts.min !== undefined ? `min="${opts.min}"` : '',
    opts.max !== undefined ? `max="${opts.max}"` : '',
    opts.autocomplete ? `autocomplete="${opts.autocomplete}"` : 'autocomplete="off"',
  ]
    .filter(Boolean)
    .join(' ');
  return `<input ${attrs} />`;
}

export function moneyInput(name: string, value?: number | null, placeholder = '0.00'): string {
  return input(name, { type: 'number', step: '0.01', min: '0', value: value ?? '', placeholder, required: true });
}

export function select(name: string, options: { value: string | number; label: string; selected?: boolean }[], opts: { id?: string; placeholder?: string } = {}): string {
  const ph = opts.placeholder ? `<option value="">${esc(opts.placeholder)}</option>` : '';
  return `<select name="${esc(name)}" ${opts.id ? `id="${esc(opts.id)}"` : ''}>${ph}${options
    .map((o) => `<option value="${esc(o.value)}" ${o.selected ? 'selected' : ''}>${esc(o.label)}</option>`)
    .join('')}</select>`;
}

export function emptyState(icon: string, title: string, hint?: string, actionHtml?: string): string {
  return `<div class="empty"><div class="big">${icon}</div><p class="bold white">${esc(title)}</p>${hint ? `<p>${esc(hint)}</p>` : ''}${actionHtml ?? ''}</div>`;
}

export function loadingState(text = 'Cargando…'): string {
  return `<div class="loading">${esc(text)}</div>`;
}

/** Barra de progreso con clase .over si se pasa de 100%. */
export function progressBar(ratio: number, opts: { white?: boolean; lg?: boolean } = {}): string {
  const r = Math.max(0, Number(ratio) || 0);
  const width = Math.min(100, r * 100);
  return `<div class="progress ${opts.lg ? 'lg' : ''} ${r > 1 ? 'over' : ''}"><span class="${opts.white ? 'white' : ''}" style="width:${width.toFixed(1)}%"></span></div>`;
}

/** Selector de mes/año con botones anterior/siguiente. Emite 'change' con {year, month} en el elemento devuelto. */
export function periodPicker(container: HTMLElement, state: { year: number; month: number }, onChange: (year: number, month: number) => void, opts: { allowYearOnly?: boolean; years?: number[] } = {}): void {
  const now = new Date();
  const years = opts.years?.length ? opts.years : Array.from({ length: 7 }, (_, i) => now.getFullYear() + 1 - i);
  if (!years.includes(state.year)) years.push(state.year);
  years.sort((a, b) => b - a);
  const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  container.className = 'period';
  container.innerHTML = `
    <button type="button" class="btn icon" data-prev aria-label="Mes anterior">‹</button>
    <select data-month aria-label="Mes">
      ${opts.allowYearOnly ? `<option value="0" ${state.month === 0 ? 'selected' : ''}>Todo el año</option>` : ''}
      ${MONTHS.map((m, i) => `<option value="${i + 1}" ${state.month === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}
    </select>
    <select data-year aria-label="Año">${years.map((y) => `<option value="${y}" ${y === state.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
    <button type="button" class="btn icon" data-next aria-label="Mes siguiente">›</button>`;
  const monthSel = container.querySelector<HTMLSelectElement>('[data-month]')!;
  const yearSel = container.querySelector<HTMLSelectElement>('[data-year]')!;
  const emit = (): void => onChange(state.year, state.month);
  container.querySelector('[data-prev]')!.addEventListener('click', () => {
    if (state.month === 0) state.year -= 1;
    else if (state.month === 1) {
      state.month = 12;
      state.year -= 1;
    } else state.month -= 1;
    periodPicker(container, state, onChange, opts);
    emit();
  });
  container.querySelector('[data-next]')!.addEventListener('click', () => {
    if (state.month === 0) state.year += 1;
    else if (state.month === 12) {
      state.month = 1;
      state.year += 1;
    } else state.month += 1;
    periodPicker(container, state, onChange, opts);
    emit();
  });
  monthSel.addEventListener('change', () => {
    state.month = Number(monthSel.value);
    emit();
  });
  yearSel.addEventListener('change', () => {
    state.year = Number(yearSel.value);
    emit();
  });
}

/** Delegación de eventos: on(root, 'click', '[data-edit]', (el, ev) => ...) */
export function on<K extends keyof HTMLElementEventMap>(root: HTMLElement, type: K, selector: string, handler: (el: HTMLElement, ev: HTMLElementEventMap[K]) => void): void {
  root.addEventListener(type, (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>(selector);
    if (target && root.contains(target)) handler(target, ev);
  });
}
