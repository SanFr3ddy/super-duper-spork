/**
 * Vista "Movimientos": filtros por periodo/tipo/categoría/búsqueda, totales y tabla con alta/edición/borrado.
 */
import type { Category, CreditCard, Transaction, TransactionInput, TransactionsResponse, TxType } from '../../../shared/types';
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
let search = '';

let categories: Category[] = [];
let cards: CreditCard[] = [];
let items: Transaction[] = [];
let wrap: HTMLElement | null = null;
let searchTimer: number | undefined;
let seq = 0;

const STYLE = `<style>
  .v-tx .v-tx-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .v-tx .v-tx-filters > select,
  .v-tx .v-tx-filters > input[type='search'] { width: auto; flex: 1 1 190px; min-width: 160px; }
  .v-tx .v-tx-desc { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v-tx td.actions .btn + .btn { margin-left: 2px; }
  .v-tx .stat-value.white { color: var(--white); }
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
  // Cada lista se carga por separado: si una falla, la otra se conserva y el formulario de edición
  // mantiene la categoría/tarjeta actual del movimiento (ver catOptions/cardOptions).
  const [catsRes, cardsRes] = await Promise.allSettled([api.get<Category[]>('/api/categories'), api.get<CreditCard[]>('/api/cards')]);
  categories = catsRes.status === 'fulfilled' ? catsRes.value : [];
  cards = cardsRes.status === 'fulfilled' && Array.isArray(cardsRes.value) ? cardsRes.value : [];
  if (catsRes.status === 'rejected') showError(catsRes.reason, 'No se pudieron cargar las categorías');
  if (cardsRes.status === 'rejected') showError(cardsRes.reason, 'No se pudieron cargar las tarjetas');
  if (wrap !== view) return; // la vista cambió mientras cargaba
  fillCategoryFilter(view);
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
      `/api/transactions${qs({ year: period.year, month: period.month, type: typeFilter, category_id: categoryFilter, q: search.trim() })}`,
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
    const filtered = typeFilter || categoryFilter || search.trim();
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
  const pay = isExpense
    ? t.card_name
      ? `Tarjeta: ${esc(t.card_name)}`
      : `<span class="muted">Efectivo/Débito</span>`
    : `<span class="muted">—</span>`;
  return `<tr>
    <td class="nowrap">${esc(fmtDateShort(t.date))}</td>
    <td><div class="v-tx-desc" title="${esc(t.description)}">${desc}</div></td>
    <td class="nowrap">${cat}</td>
    <td class="nowrap">${pay}</td>
    <td class="amount ${isExpense ? 'expense' : 'income'}">${isExpense ? '-' : '+'}${money(t.amount)}</td>
    <td class="actions">
      <button type="button" class="btn ghost sm icon" data-edit="${t.id}" aria-label="Editar" title="Editar">✎</button>
      <button type="button" class="btn ghost sm icon" data-del="${t.id}" aria-label="Eliminar" title="Eliminar">🗑</button>
    </td>
  </tr>`;
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

function cardOptions(selected: number | null, existing?: Transaction): string {
  const missing =
    selected !== null && !cards.some((c) => c.id === selected)
      ? `<option value="${selected}" selected>${esc(existing?.card_name ?? `Tarjeta #${selected}`)}</option>`
      : '';
  return (
    `<option value="">Efectivo / débito</option>` +
    missing +
    cards.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
  );
}

function openTxForm(existing?: Transaction): void {
  const type: TxType = existing?.type ?? 'expense';
  const html = `<form class="form">
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
    <div data-card-wrap class="${type === 'income' ? 'hidden' : ''}">
      ${field(
        'Tarjeta de crédito',
        `<select name="credit_card_id">${cardOptions(existing?.credit_card_id ?? null, existing)}</select>`,
        cards.length ? 'Elige una tarjeta si el gasto fue a crédito.' : 'Aún no tienes tarjetas registradas.',
      )}
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
      const cardWrap = form.querySelector<HTMLElement>('[data-card-wrap]')!;
      seg.querySelectorAll<HTMLButtonElement>('button[data-type]').forEach((b) =>
        b.addEventListener('click', () => {
          const t = b.dataset.type === 'income' ? 'income' : 'expense';
          if (hidden.value === t) return;
          hidden.value = t;
          seg.querySelectorAll<HTMLButtonElement>('button').forEach((x) => (x.className = x === b ? `active ${t}` : ''));
          catSel.innerHTML = catOptions(t, existing && existing.type === t ? existing.category_id : null, existing);
          cardWrap.classList.toggle('hidden', t === 'income');
        }),
      );
      window.setTimeout(() => form.querySelector<HTMLInputElement>('input[name=amount]')?.focus(), 60);
    },
    async onSubmit(values, _form, modal) {
      const t: TxType = values.type === 'income' ? 'income' : 'expense';
      const body: TransactionInput = {
        type: t,
        amount: toNumber(values.amount ?? '', 'monto'),
        date: values.date ?? '',
        description: (values.description ?? '').trim(),
        category_id: values.category_id ? Number(values.category_id) : null,
        credit_card_id: t === 'expense' && values.credit_card_id ? Number(values.credit_card_id) : null,
      };
      if (existing) await api.put<Transaction>(`/api/transactions/${existing.id}`, body);
      else await api.post<Transaction>('/api/transactions', body);
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
