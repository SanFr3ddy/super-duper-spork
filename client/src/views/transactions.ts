/**
 * Vista "Movimientos": filtros por periodo/tipo/categoría/cuenta/búsqueda, totales y tabla con alta/edición/borrado.
 * Cada movimiento puede ligarse a una cuenta de "Mi dinero" o (gastos) a una tarjeta de crédito, con compra a meses.
 */
import type { Account, Category, CreditCard, Transaction, TransactionInput, TransactionsResponse, TxType } from '../../../shared/types';
import { api, qs } from '../api';
import { esc, money, fmtDateShort, monthName, todayISO, currentYear, currentMonth } from '../format';
import {
  formModal,
  confirmDialog,
  toast,
  showError,
  field,
  input,
  moneyInput,
  emptyState,
  loadingState,
  periodPicker,
  on,
  toNumber,
} from '../ui';

// ---------------------------------------------------------------------------
// Estado de módulo (persiste mientras la app viva, para conservar los filtros)
// ---------------------------------------------------------------------------
const period = { year: currentYear(), month: currentMonth() };
let typeFilter: '' | TxType = '';
let categoryFilter = '';
let accountFilter = '';
let search = '';

let categories: Category[] = [];
let cards: CreditCard[] = [];
let accounts: Account[] = [];
let items: Transaction[] = [];

/** Opciones de "Meses" para compras con tarjeta. */
const INSTALLMENT_OPTIONS = [1, 3, 6, 9, 12, 18, 24];
const LS_EXPENSE_PAY = 'finanzas.tx.lastExpensePay';
const LS_INCOME_ACCOUNT = 'finanzas.tx.lastIncomeAccount';
let wrap: HTMLElement | null = null;
let searchTimer: number | undefined;
let seq = 0;

const STYLE = `<style>
  .v-tx .v-tx-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .v-tx .v-tx-filters > select,
  .v-tx .v-tx-filters > input[type='search'] { width: auto; flex: 1 1 190px; min-width: 160px; }
  .v-tx .v-tx-desc { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v-tx .v-tx-desc-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .v-tx .v-tx-desc-row .v-tx-desc { min-width: 0; }
  .v-tx .v-tx-auto { flex: none; padding: 1px 7px; font-size: 0.7rem; }
  .v-tx td.actions .btn + .btn { margin-left: 2px; }
  .v-tx .stat-value.white { color: var(--white); }
  .v-tx .v-tx-pay { display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
  .v-tx .v-tx-pay + .chip { margin-left: 6px; vertical-align: middle; }
  .v-tx-form .v-tx-inst-info { margin: 0; color: var(--text-2); font-size: 0.85rem; }
  .v-tx-form .v-tx-inst-info strong { color: var(--white); }
  @media (max-width: 820px) {
    .v-tx .v-tx-filters > select,
    .v-tx .v-tx-filters > input[type='search'] { flex-basis: 100%; }
  }
</style>`;

// ---------------------------------------------------------------------------
// Render principal
// ---------------------------------------------------------------------------
export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `${STYLE}<div class="v-tx">
    <div class="card">
      <div class="v-tx-filters">
        <div data-period></div>
        <div class="segmented" data-typeseg role="group" aria-label="Tipo de movimiento">
          <button type="button" data-type="" class="${typeFilter === '' ? 'active' : ''}">Todos</button>
          <button type="button" data-type="income" class="${typeFilter === 'income' ? 'active income' : ''}">Ingresos</button>
          <button type="button" data-type="expense" class="${typeFilter === 'expense' ? 'active expense' : ''}">Gastos</button>
        </div>
        <select data-cat aria-label="Filtrar por categoría"><option value="">Todas las categorías</option></select>
        <select data-acc aria-label="Filtrar por cuenta"><option value="">Todas las cuentas</option></select>
        <input type="search" data-q placeholder="Buscar…" aria-label="Buscar movimientos" value="${esc(search)}" />
      </div>
    </div>
    <div class="grid grid-3 mt" data-stats></div>
    <div class="card mt" data-table>${loadingState()}</div>
  </div>`;
  wrap = root.querySelector<HTMLElement>('.v-tx');
  if (!wrap) return;
  const view = wrap;

  mountTopbar();

  // --- Filtros ---
  periodPicker(view.querySelector<HTMLElement>('[data-period]')!, period, () => void loadTable(), { allowYearOnly: true });

  on(view, 'click', '[data-typeseg] button', (el) => {
    const t = (el.dataset.type ?? '') as '' | TxType;
    if (t === typeFilter) return;
    typeFilter = t;
    view.querySelectorAll<HTMLButtonElement>('[data-typeseg] button').forEach((b) => {
      const bt = b.dataset.type ?? '';
      b.className = bt === t ? `active ${t}` : '';
    });
    // Si la categoría elegida no corresponde al tipo, se limpia el filtro de categoría.
    if (categoryFilter && t) {
      const cat = categories.find((c) => String(c.id) === categoryFilter);
      if (cat && cat.type !== t) {
        categoryFilter = '';
        const sel = view.querySelector<HTMLSelectElement>('[data-cat]');
        if (sel) sel.value = '';
      }
    }
    void loadTable();
  });

  view.querySelector<HTMLSelectElement>('[data-cat]')!.addEventListener('change', (e) => {
    categoryFilter = (e.target as HTMLSelectElement).value;
    void loadTable();
  });

  view.querySelector<HTMLSelectElement>('[data-acc]')!.addEventListener('change', (e) => {
    accountFilter = (e.target as HTMLSelectElement).value;
    void loadTable();
  });

  view.querySelector<HTMLInputElement>('[data-q]')!.addEventListener('input', (e) => {
    const value = (e.target as HTMLInputElement).value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      if (value.trim() === search.trim()) return;
      search = value;
      void loadTable();
    }, 250);
  });

  // --- Acciones de la tabla ---
  on(view, 'click', '[data-new]', () => openTxForm());
  on(view, 'click', '[data-edit]', (el) => {
    const tx = items.find((t) => t.id === Number(el.dataset.edit));
    if (tx) openTxForm(tx);
  });
  on(view, 'click', '[data-del]', (el) => void deleteTx(Number(el.dataset.del)));

  // --- Datos de apoyo (una sola vez por render) ---
  // Cada lista se carga por separado: si una falla, las otras se conservan y el formulario de edición
  // mantiene la categoría/tarjeta/cuenta actual del movimiento (ver catOptions/payOptions).
  const [catsRes, cardsRes, accsRes] = await Promise.allSettled([
    api.get<Category[]>('/api/categories'),
    api.get<CreditCard[]>('/api/cards'),
    api.get<Account[]>('/api/accounts/list'),
  ]);
  if (wrap !== view) return; // la vista cambió mientras cargaba
  categories = catsRes.status === 'fulfilled' && Array.isArray(catsRes.value) ? catsRes.value : [];
  cards = cardsRes.status === 'fulfilled' && Array.isArray(cardsRes.value) ? cardsRes.value : [];
  accounts = accsRes.status === 'fulfilled' && Array.isArray(accsRes.value) ? accsRes.value : [];
  if (catsRes.status === 'rejected') showError(catsRes.reason, 'No se pudieron cargar las categorías');
  if (cardsRes.status === 'rejected') showError(cardsRes.reason, 'No se pudieron cargar las tarjetas');
  if (accsRes.status === 'rejected') showError(accsRes.reason, 'No se pudieron cargar las cuentas');
  fillCategoryFilter(view);
  fillAccountFilter(view, accsRes.status === 'fulfilled');
  await loadTable();
}

export function destroy(): void {
  window.clearTimeout(searchTimer);
  searchTimer = undefined;
  seq++;
  wrap = null;
  items = [];
}

// ---------------------------------------------------------------------------
// Piezas de la vista
// ---------------------------------------------------------------------------
function mountTopbar(): void {
  const actions = document.getElementById('topbar-actions');
  if (!actions) return;
  actions.innerHTML = `<button type="button" class="btn primary" data-new-tx>+ Nuevo movimiento</button>`;
  actions.querySelector('[data-new-tx]')!.addEventListener('click', () => openTxForm());
}

function fillCategoryFilter(view: HTMLElement): void {
  const sel = view.querySelector<HTMLSelectElement>('[data-cat]');
  if (!sel) return;
  const group = (type: TxType, label: string): string => {
    const list = categories.filter((c) => c.type === type);
    if (!list.length) return '';
    return `<optgroup label="${esc(label)}">${list
      .map((c) => `<option value="${c.id}" ${String(c.id) === categoryFilter ? 'selected' : ''}>${c.icon ? esc(c.icon) + ' ' : ''}${esc(c.name)}</option>`)
      .join('')}</optgroup>`;
  };
  sel.innerHTML = `<option value="">Todas las categorías</option>${group('expense', 'Gastos')}${group('income', 'Ingresos')}`;
  if (categoryFilter && !categories.some((c) => String(c.id) === categoryFilter)) categoryFilter = '';
  sel.value = categoryFilter;
}

/** "Banco · Nombre" (o solo el nombre si no hay banco). */
function accountLabel(bank: string | null | undefined, name: string | null | undefined): string {
  const b = (bank ?? '').trim();
  const n = (name ?? '').trim() || 'Cuenta';
  return b ? `${b} · ${n}` : n;
}

function fillAccountFilter(view: HTMLElement, loaded: boolean): void {
  const sel = view.querySelector<HTMLSelectElement>('[data-acc]');
  if (!sel) return;
  const opts = (list: Account[]): string =>
    list.map((a) => `<option value="${a.id}">${esc(accountLabel(a.bank, a.name))}</option>`).join('');
  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);
  const known = accounts.some((a) => String(a.id) === accountFilter);
  if (accountFilter && !known && loaded) accountFilter = ''; // la cuenta ya no existe
  // Si la lista no cargó, se conserva el filtro activo con una opción genérica.
  const keep = accountFilter && !known ? `<option value="${esc(accountFilter)}">Cuenta seleccionada</option>` : '';
  sel.innerHTML =
    `<option value="">Todas las cuentas</option>${keep}` +
    (archived.length && active.length ? `<optgroup label="Activas">${opts(active)}</optgroup>` : opts(active)) +
    (archived.length ? `<optgroup label="Archivadas">${opts(archived)}</optgroup>` : '');
  sel.value = accountFilter;
}

function periodLabel(): string {
  return period.month === 0 ? `Año ${period.year}` : `${monthName(period.month)} ${period.year}`;
}

async function loadTable(): Promise<void> {
  const view = wrap;
  if (!view) return;
  const my = ++seq;
  const tableEl = view.querySelector<HTMLElement>('[data-table]');
  if (!tableEl) return;
  tableEl.innerHTML = loadingState();
  try {
    const data = await api.get<TransactionsResponse>(
      `/api/transactions${qs({
        year: period.year,
        month: period.month,
        type: typeFilter,
        category_id: categoryFilter,
        account_id: accountFilter,
        q: search.trim(),
      })}`,
    );
    if (my !== seq || wrap !== view) return;
    items = data.items;
    renderStats(view, data.totals);
    renderTable(view, data.items);
  } catch (err) {
    if (my !== seq || wrap !== view) return;
    showError(err);
    tableEl.innerHTML = `<p class="error-text">No se pudieron cargar los movimientos.</p>`;
  }
}

function renderStats(view: HTMLElement, t: TransactionsResponse['totals']): void {
  const statsEl = view.querySelector<HTMLElement>('[data-stats]');
  if (!statsEl) return;
  const label = esc(periodLabel());
  statsEl.innerHTML = `
    <div class="stat">
      <div class="stat-label">Ingresos</div>
      <div class="stat-value white">${money(t.income)}</div>
      <div class="stat-foot">${label}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Gastos</div>
      <div class="stat-value red">${money(t.expenses)}</div>
      <div class="stat-foot">${label}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Balance</div>
      <div class="stat-value ${t.net >= 0 ? 'white' : 'red'}">${money(t.net)}</div>
      <div class="stat-foot">${label}</div>
    </div>`;
}

function renderTable(view: HTMLElement, list: Transaction[]): void {
  const tableEl = view.querySelector<HTMLElement>('[data-table]');
  if (!tableEl) return;
  if (!list.length) {
    const filtered = typeFilter || categoryFilter || accountFilter || search.trim();
    tableEl.innerHTML = emptyState(
      '🧾',
      'Sin movimientos',
      filtered ? `No hay movimientos que coincidan con los filtros en ${periodLabel()}.` : `Aún no registras movimientos en ${periodLabel()}.`,
      `<button type="button" class="btn primary" data-new>Agregar movimiento</button>`,
    );
    return;
  }
  tableEl.innerHTML = `
    <div class="card-head">
      <h2>Movimientos <span class="sub">${list.length} ${list.length === 1 ? 'registro' : 'registros'} · ${esc(periodLabel())}</span></h2>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Descripción</th>
            <th>Categoría</th>
            <th>Pago</th>
            <th class="amount">Monto</th>
            <th class="right">Acciones</th>
          </tr>
        </thead>
        <tbody>${list.map(rowHtml).join('')}</tbody>
      </table>
    </div>`;
}

function rowHtml(t: Transaction): string {
  const isExpense = t.type === 'expense';
  const desc = t.description
    ? esc(t.description)
    : `<span class="muted">${esc(t.category_name ?? 'Sin descripción')}</span>`;
  const cat =
    t.category_id && t.category_name
      ? `<span class="chip"><span class="dot" style="background:${esc(t.category_color ?? '#8a8a8a')}"></span>${
          t.category_icon ? esc(t.category_icon) + ' ' : ''
        }${esc(t.category_name)}</span>`
      : `<span class="muted small">Sin categoría</span>`;
  return `<tr>
    <td class="nowrap">${esc(fmtDateShort(t.date))}</td>
    <td>${
      t.recurring_id != null
        ? `<div class="v-tx-desc-row"><div class="v-tx-desc" title="${esc(t.description)}">${desc}</div><span class="chip v-tx-auto" title="Registrado automáticamente por un cargo recurrente">🔁 Automático</span></div>`
        : `<div class="v-tx-desc" title="${esc(t.description)}">${desc}</div>`
    }</td>
    <td class="nowrap">${cat}</td>
    <td class="nowrap">${payHtml(t)}</td>
    <td class="amount ${isExpense ? 'expense' : 'income'}">${isExpense ? '-' : '+'}${money(t.amount)}</td>
    <td class="actions">
      <button type="button" class="btn ghost sm icon" data-edit="${t.id}" aria-label="Editar" title="Editar">✎</button>
      <button type="button" class="btn ghost sm icon" data-del="${t.id}" aria-label="Eliminar" title="Eliminar">🗑</button>
    </td>
  </tr>`;
}

/** Columna "Pago": tarjeta (con meses), cuenta de origen/destino o sin especificar. */
function payHtml(t: Transaction): string {
  const hasAccount = t.account_id !== null;
  const accText = hasAccount ? accountLabel(t.account_bank, t.account_name) : '';
  if (t.type === 'income') {
    return hasAccount
      ? `<span class="v-tx-pay" title="${esc(accText)}">→ ${esc(accText)}</span>`
      : `<span class="muted">—</span>`;
  }
  if (t.credit_card_id !== null) {
    const name = t.card_name ?? 'Tarjeta';
    const n = Number(t.installments) || 1;
    const msi = n > 1 ? `<span class="chip" title="Compra a ${n} meses">${n} MSI</span>` : '';
    return `<span class="v-tx-pay" title="${esc(name)}">💳 ${esc(name)}</span>${msi}`;
  }
  if (hasAccount) return `<span class="v-tx-pay" title="${esc(accText)}">🏦 ${esc(accText)}</span>`;
  return `<span class="muted">Sin especificar</span>`;
}

// ---------------------------------------------------------------------------
// Formulario (alta y edición)
// ---------------------------------------------------------------------------
function catOptions(type: TxType, selected: number | null, existing?: Transaction): string {
  // Si la categoría actual no está en la lista cargada, se agrega para no perderla al guardar.
  const missing =
    selected !== null && !categories.some((c) => c.id === selected)
      ? `<option value="${selected}" selected>${esc(existing?.category_name ?? `Categoría #${selected}`)}</option>`
      : '';
  return (
    `<option value="">Sin categoría</option>` +
    missing +
    categories
      .filter((c) => c.type === type)
      .map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.icon ? esc(c.icon) + ' ' : ''}${esc(c.name)}</option>`)
      .join('')
  );
}

// --- Forma de pago: valor 'acc:ID' (cuenta), 'card:ID' (tarjeta, solo gastos) o '' (sin especificar) ---
function lsGet(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function lsSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* almacenamiento no disponible: se ignora */
  }
}

function parsePay(value: string): { kind: 'acc' | 'card' | ''; id: number | null } {
  const m = /^(acc|card):(\d+)$/.exec(value);
  return m ? { kind: m[1] as 'acc' | 'card', id: Number(m[2]) } : { kind: '', id: null };
}

/** Forma de pago actual de un movimiento vista como tipo `t`. */
function payValueOf(tx: Transaction, t: TxType): string {
  if (t === 'expense' && tx.credit_card_id !== null) return `card:${tx.credit_card_id}`;
  if (tx.account_id !== null) return `acc:${tx.account_id}`;
  return '';
}

/** true si el valor está entre las opciones cargadas (cuentas activas; tarjetas solo para gastos). */
function payAvailable(value: string, t: TxType): boolean {
  const p = parsePay(value);
  if (p.kind === 'acc') return accounts.some((a) => a.id === p.id && !a.archived);
  if (p.kind === 'card') return t === 'expense' && cards.some((c) => c.id === p.id);
  return false;
}

/** En edición, lo actual del movimiento; en altas, la última forma de pago / cuenta usada (si sigue disponible). */
function defaultPay(t: TxType, existing?: Transaction): string {
  if (existing) return payValueOf(existing, t);
  const stored = lsGet(t === 'expense' ? LS_EXPENSE_PAY : LS_INCOME_ACCOUNT);
  return payAvailable(stored, t) ? stored : '';
}

function payOptions(t: TxType, selected: string, existing?: Transaction): string {
  const sel = parsePay(selected);
  const opt = (value: string, label: string): string =>
    `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;

  const accOpts = accounts.filter((a) => !a.archived).map((a) => opt(`acc:${a.id}`, accountLabel(a.bank, a.name)));
  // Si la cuenta actual no está entre las activas (archivada o la lista no cargó), se agrega para no perderla.
  if (sel.kind === 'acc' && !accounts.some((a) => a.id === sel.id && !a.archived)) {
    const known = accounts.find((a) => a.id === sel.id);
    const label = known
      ? `${accountLabel(known.bank, known.name)} (archivada)`
      : existing && existing.account_id === sel.id
        ? accountLabel(existing.account_bank, existing.account_name)
        : `Cuenta #${sel.id}`;
    accOpts.unshift(opt(selected, label));
  }
  const none = opt('', 'Sin especificar');
  const accGroup = accOpts.length ? `<optgroup label="Cuentas">${accOpts.join('')}</optgroup>` : '';
  if (t === 'income') return none + accGroup;

  const cardOpts = cards.map((c) => opt(`card:${c.id}`, c.name));
  if (sel.kind === 'card' && !cards.some((c) => c.id === sel.id)) {
    const label = existing && existing.credit_card_id === sel.id && existing.card_name ? existing.card_name : `Tarjeta #${sel.id}`;
    cardOpts.unshift(opt(selected, label));
  }
  const cardGroup = cardOpts.length ? `<optgroup label="Tarjetas de crédito">${cardOpts.join('')}</optgroup>` : '';
  return none + accGroup + cardGroup;
}

function payLabel(t: TxType): string {
  return t === 'income' ? '¿A qué cuenta entró?' : 'Forma de pago';
}

function payHelp(t: TxType): string {
  const hasAccounts = accounts.some((a) => !a.archived);
  if (t === 'income') {
    return hasAccounts ? 'El ingreso se suma al saldo de esa cuenta en Mi dinero.' : 'Registra tus cuentas en Mi dinero para saber a dónde entró tu dinero.';
  }
  if (!hasAccounts && !cards.length) return 'Registra tus cuentas en Mi dinero y tus tarjetas en Tarjetas para elegirlas aquí.';
  return 'Una compra con tarjeta no descuenta de tus cuentas: se paga después desde Tarjetas.';
}

function installmentOptions(selected: number): string {
  const list = INSTALLMENT_OPTIONS.includes(selected) ? INSTALLMENT_OPTIONS : [...INSTALLMENT_OPTIONS, selected].sort((a, b) => a - b);
  return list
    .map((n) => `<option value="${n}" ${n === selected ? 'selected' : ''}>${n === 1 ? 'Una sola exhibición' : `${n} meses`}</option>`)
    .join('');
}

/** Texto (HTML seguro) con la mensualidad: la primera se paga el mes siguiente a la compra. */
function installmentInfo(amountRaw: string, date: string, n: number): string {
  if (n <= 1) return 'Se carga completo a la tarjeta en una sola exhibición.';
  const [y, m] = date.split('-').map(Number);
  const start = y && m && m >= 1 && m <= 12 ? (m === 12 ? `${monthName(1).toLowerCase()} de ${y + 1}` : `${monthName(m + 1).toLowerCase()} de ${y}`) : 'el mes siguiente a la compra';
  const amount = Number(String(amountRaw).replace(/,/g, ''));
  if (!amountRaw.trim() || !Number.isFinite(amount) || amount <= 0) {
    return `Escribe el monto para calcular la mensualidad (${n} meses, desde ${start}).`;
  }
  const monthly = Math.round((amount / n + Number.EPSILON) * 100) / 100;
  return `Mensualidad: <strong>${money(monthly)}</strong> durante ${n} meses, desde ${start}.`;
}

function openTxForm(existing?: Transaction): void {
  const type: TxType = existing?.type ?? 'expense';
  const pay = defaultPay(type, existing);
  const installments = existing && existing.credit_card_id !== null ? Number(existing.installments) || 1 : 1;
  const html = `<form class="form v-tx-form">
    <div class="field">
      <label>Tipo</label>
      <div class="segmented" data-seg role="group" aria-label="Tipo">
        <button type="button" data-type="expense" class="${type === 'expense' ? 'active expense' : ''}">Gasto</button>
        <button type="button" data-type="income" class="${type === 'income' ? 'active income' : ''}">Ingreso</button>
      </div>
      <input type="hidden" name="type" value="${type}" />
    </div>
    <div class="form-row">
      ${field('Monto', moneyInput('amount', existing?.amount ?? null))}
      ${field('Fecha', input('date', { type: 'date', value: existing?.date ?? todayISO(), required: true }))}
    </div>
    ${field('Categoría', `<select name="category_id" data-cat-select>${catOptions(type, existing?.category_id ?? null, existing)}</select>`)}
    ${field('Descripción', input('description', { value: existing?.description ?? '', placeholder: '¿En qué fue?' }))}
    <div class="field">
      <label for="tx-pay" data-pay-label>${esc(payLabel(type))}</label>
      <select name="pay" id="tx-pay" data-pay>${payOptions(type, pay, existing)}</select>
      <span class="help" data-pay-help>${esc(payHelp(type))}</span>
    </div>
    <div class="field ${type === 'expense' && parsePay(pay).kind === 'card' ? '' : 'hidden'}" data-inst-wrap>
      <label for="tx-inst">Meses</label>
      <select name="installments" id="tx-inst" data-inst>${installmentOptions(installments)}</select>
      <p class="v-tx-inst-info" data-inst-info aria-live="polite"></p>
    </div>
  </form>`;

  formModal({
    title: existing ? 'Editar movimiento' : 'Nuevo movimiento',
    html,
    submitLabel: existing ? 'Guardar cambios' : 'Agregar',
    onOpen(form) {
      const seg = form.querySelector<HTMLElement>('[data-seg]')!;
      const hidden = form.querySelector<HTMLInputElement>('input[name=type]')!;
      const catSel = form.querySelector<HTMLSelectElement>('[data-cat-select]')!;
      const paySel = form.querySelector<HTMLSelectElement>('[data-pay]')!;
      const payLabelEl = form.querySelector<HTMLElement>('[data-pay-label]')!;
      const payHelpEl = form.querySelector<HTMLElement>('[data-pay-help]')!;
      const instWrap = form.querySelector<HTMLElement>('[data-inst-wrap]')!;
      const instSel = form.querySelector<HTMLSelectElement>('[data-inst]')!;
      const instInfo = form.querySelector<HTMLElement>('[data-inst-info]')!;
      const amountIn = form.querySelector<HTMLInputElement>('input[name=amount]')!;
      const dateIn = form.querySelector<HTMLInputElement>('input[name=date]')!;
      let payTouched = false;

      const refreshInstallments = (): void => {
        const isCard = hidden.value === 'expense' && parsePay(paySel.value).kind === 'card';
        instWrap.classList.toggle('hidden', !isCard);
        instInfo.innerHTML = isCard ? installmentInfo(amountIn.value, dateIn.value, Number(instSel.value) || 1) : '';
      };
      paySel.addEventListener('change', () => {
        payTouched = true;
        refreshInstallments();
      });
      instSel.addEventListener('change', refreshInstallments);
      amountIn.addEventListener('input', refreshInstallments);
      dateIn.addEventListener('input', refreshInstallments);
      dateIn.addEventListener('change', refreshInstallments);

      seg.querySelectorAll<HTMLButtonElement>('button[data-type]').forEach((b) =>
        b.addEventListener('click', () => {
          const t = b.dataset.type === 'income' ? 'income' : 'expense';
          if (hidden.value === t) return;
          hidden.value = t;
          seg.querySelectorAll<HTMLButtonElement>('button').forEach((x) => (x.className = x === b ? `active ${t}` : ''));
          catSel.innerHTML = catOptions(t, existing && existing.type === t ? existing.category_id : null, existing);
          // Se conserva la elección del usuario si aplica al nuevo tipo (una tarjeta no aplica a ingresos).
          const cur = paySel.value;
          const next = payTouched && !(t === 'income' && parsePay(cur).kind === 'card') ? cur : defaultPay(t, existing);
          paySel.innerHTML = payOptions(t, next, existing);
          paySel.value = next;
          payLabelEl.textContent = payLabel(t);
          payHelpEl.textContent = payHelp(t);
          refreshInstallments();
        }),
      );
      refreshInstallments();
      window.setTimeout(() => amountIn.focus(), 60);
    },
    async onSubmit(values, _form, modal) {
      const t: TxType = values.type === 'income' ? 'income' : 'expense';
      const payValue = values.pay ?? '';
      const p = parsePay(payValue);
      const accountId = p.kind === 'acc' ? p.id : null;
      const cardId = t === 'expense' && p.kind === 'card' ? p.id : null;
      const months = cardId !== null ? Math.min(48, Math.max(1, Math.floor(Number(values.installments) || 1))) : 1;
      const categoryId = values.category_id ? Number(values.category_id) : null;
      const base = {
        type: t,
        amount: toNumber(values.amount ?? '', 'monto'),
        date: values.date ?? '',
        description: (values.description ?? '').trim(),
        installments: months,
      };
      if (existing) {
        // Solo se envían las referencias que cambiaron: el servidor conserva lo omitido
        // (así no se pierde una categoría/tarjeta/cuenta que no esté en las listas cargadas).
        const body: Partial<TransactionInput> = { ...base };
        if (categoryId !== existing.category_id) body.category_id = categoryId;
        if (cardId !== existing.credit_card_id) body.credit_card_id = cardId;
        if (accountId !== existing.account_id) body.account_id = accountId;
        await api.put<Transaction>(`/api/transactions/${existing.id}`, body);
      } else {
        const body: TransactionInput = { ...base, category_id: categoryId, credit_card_id: cardId, account_id: accountId };
        await api.post<Transaction>('/api/transactions', body);
        // Recordar para la siguiente alta.
        if (t === 'expense') lsSet(LS_EXPENSE_PAY, payValue);
        else lsSet(LS_INCOME_ACCOUNT, accountId !== null ? `acc:${accountId}` : '');
      }
      modal.close();
      toast(existing ? 'Movimiento actualizado' : 'Movimiento guardado');
      await loadTable();
    },
  });
}

async function deleteTx(id: number): Promise<void> {
  const tx = items.find((t) => t.id === id);
  const what = tx ? `${tx.type === 'expense' ? 'el gasto' : 'el ingreso'} de ${money(tx.amount)}${tx.description ? ` (${tx.description})` : ''}` : 'este movimiento';
  const ok = await confirmDialog(`¿Eliminar ${what}? Esta acción no se puede deshacer.`, { title: 'Eliminar movimiento' });
  if (!ok) return;
  try {
    await api.del(`/api/transactions/${id}`);
    toast('Movimiento eliminado');
    await loadTable();
  } catch (err) {
    showError(err);
  }
}
