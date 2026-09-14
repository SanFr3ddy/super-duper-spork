/**
 * Vista "Presupuestos": límites mensuales por categoría de gasto.
 *
 *  - Selector de mes/año + "Copiar del mes anterior".
 *  - Resumen (presupuestado / gastado / restante) con barra global.
 *  - Gráfica presupuesto vs gastado por categoría.
 *  - Lista de presupuestos (editar / eliminar) y categorías sin presupuesto (agregar).
 */
import type { Budget, BudgetsResponse } from '../../../shared/types';
import { api, qs } from '../api';
import { esc, money, pct, monthName, currentYear, currentMonth } from '../format';
import {
  formModal,
  confirmDialog,
  toast,
  showError,
  field,
  moneyInput,
  select,
  emptyState,
  loadingState,
  progressBar,
  periodPicker,
  on,
  toNumber,
} from '../ui';
import { monthlyBars, legendHtml, COLORS, destroyChart } from '../charts';

type Unbudgeted = BudgetsResponse['unbudgeted'][number];

const CHART_SERIES = [
  { label: 'Presupuesto', color: COLORS.income },
  { label: 'Gastado', color: COLORS.expense },
];

const state = { year: currentYear(), month: currentMonth() };
let wrap: HTMLElement | null = null;
let data: BudgetsResponse | null = null;
let chartCanvas: HTMLCanvasElement | null = null;
let loadSeq = 0;

const STYLE = `<style>
  .v-budgets .bud-head .card-head { margin-bottom: 0; }
  .v-budgets .bud-body { margin-top: 16px; }
  .v-budgets .bud-body > * + * { margin-top: 16px; }
  .v-budgets .bud-global-meta { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 8px; font-size: .82rem; color: var(--muted); }
  .v-budgets .bud-row { cursor: pointer; border-radius: var(--radius-sm); }
  .v-budgets .bud-row:focus-visible { outline: 2px solid var(--red); outline-offset: 2px; }
  .v-budgets .bud-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px 12px; flex-wrap: wrap; margin-bottom: 6px; }
  .v-budgets .bud-top .name { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .v-budgets .bud-top .name > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v-budgets .bud-amounts { font-size: .85rem; white-space: nowrap; font-weight: 600; }
  .v-budgets .bud-meta { margin-top: 6px; }
  .v-budgets .bud-actions { display: flex; gap: 2px; flex: none; }
  .v-budgets .empty .row { justify-content: center; }
</style>`;

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `${STYLE}<div class="v-budgets">
    <div class="card bud-head">
      <div class="card-head">
        <div id="bud-period"></div>
        <button type="button" class="btn sm" data-copy-prev>Copiar del mes anterior</button>
      </div>
    </div>
    <div class="bud-body" id="bud-body">${loadingState()}</div>
  </div>`;

  wrap = root.querySelector<HTMLElement>('.v-budgets');
  if (!wrap) return;

  mountTopbar();
  periodPicker(wrap.querySelector<HTMLElement>('#bud-period')!, state, (year, month) => {
    state.year = year;
    state.month = month;
    void load();
  });

  on(wrap, 'click', '[data-copy-prev]', () => void copyFromPrevious());
  on(wrap, 'click', '[data-new-budget]', () => openNew());
  on(wrap, 'click', '[data-add]', (el) => openNew(Number(el.dataset.add)));
  on(wrap, 'click', '[data-edit]', (el) => {
    const b = findBudget(el.dataset.edit);
    if (b) openEdit(b);
  });
  on(wrap, 'click', '[data-del]', (el) => {
    const b = findBudget(el.dataset.del);
    if (b) void removeBudget(b);
  });
  // Clic en la fila completa (fuera de los botones) también edita.
  on(wrap, 'click', '.bud-row', (el, ev) => {
    if ((ev.target as HTMLElement | null)?.closest('button')) return;
    const b = findBudget(el.dataset.id);
    if (b) openEdit(b);
  });
  on(wrap, 'keydown', '.bud-row', (el, ev) => {
    if (ev.key !== 'Enter' || ev.target !== el) return;
    const b = findBudget(el.dataset.id);
    if (b) {
      ev.preventDefault();
      openEdit(b);
    }
  });

  await load();
}

export function destroy(): void {
  loadSeq += 1;
  destroyChart(chartCanvas);
  chartCanvas = null;
  data = null;
  wrap = null;
}

function mountTopbar(): void {
  const bar = document.getElementById('topbar-actions');
  if (!bar) return;
  bar.innerHTML = `<button type="button" class="btn primary" data-new-budget>+ Presupuesto</button>`;
  bar.querySelector('[data-new-budget]')?.addEventListener('click', () => openNew());
}

function findBudget(raw: string | undefined): Budget | undefined {
  const id = Number(raw);
  return data?.items.find((b) => b.id === id);
}

// ---------------------------------------------------------------------------
// Carga y render
// ---------------------------------------------------------------------------
async function load(): Promise<void> {
  const seq = ++loadSeq;
  data = null; // mientras carga, "+ Presupuesto" no debe usar datos de otro mes
  const body = wrap?.querySelector<HTMLElement>('#bud-body');
  if (!body) return;
  destroyChart(chartCanvas);
  chartCanvas = null;
  body.innerHTML = loadingState();
  try {
    const res = await api.get<BudgetsResponse>(`/api/budgets${qs({ year: state.year, month: state.month })}`);
    if (seq !== loadSeq || !wrap) return;
    data = res;
    renderBody(body, res);
  } catch (err) {
    if (seq !== loadSeq) return;
    showError(err);
    const msg = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="card"><p class="error-text">No se pudieron cargar los presupuestos.</p><p class="muted small">${esc(msg)}</p></div>`;
  }
}

function renderBody(body: HTMLElement, d: BudgetsResponse): void {
  const title = `${monthName(d.month)} ${d.year}`;
  const parts: string[] = [];

  if (d.items.length === 0) {
    parts.push(
      emptyState(
        '📐',
        `Sin presupuestos para ${title}`,
        'Define un límite por categoría de gasto para vigilar tus hábitos.',
        `<div class="row">
          <button type="button" class="btn sm" data-copy-prev>Copiar del mes anterior</button>
          <button type="button" class="btn primary" data-new-budget>Crear presupuesto</button>
        </div>`,
      ),
    );
  } else {
    parts.push(statsHtml(d), globalHtml(d, title), chartCardHtml(), listHtml(d));
  }
  if (d.unbudgeted.length > 0) parts.push(unbudgetedHtml(d));
  parts.push(
    `<div class="tip">Los presupuestos se comparan contra los gastos del mes por categoría (incluye compras con tarjeta).</div>`,
  );

  body.innerHTML = parts.join('');
  if (d.items.length > 0) mountChart(body, d);
}

function statsHtml(d: BudgetsResponse): string {
  const t = d.totals;
  const ratio = t.budgeted > 0 ? t.spent / t.budgeted : 0;
  const overCount = d.items.filter((b) => b.remaining < 0).length;
  const n = d.items.length;
  const restFoot =
    t.remaining < 0
      ? 'Te pasaste del presupuesto del mes'
      : overCount > 0
        ? `${overCount} ${overCount === 1 ? 'categoría excedida' : 'categorías excedidas'}`
        : 'Dentro del presupuesto';
  return `<div class="grid grid-3">
    <div class="stat">
      <div class="stat-label">Presupuestado</div>
      <div class="stat-value">${money(t.budgeted)}</div>
      <div class="stat-foot">${n} ${n === 1 ? 'categoría con límite' : 'categorías con límite'}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Gastado</div>
      <div class="stat-value red">${money(t.spent)}</div>
      <div class="stat-foot">${t.budgeted > 0 ? `${pct(ratio)} del presupuesto` : 'Sin límite definido'}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Restante</div>
      <div class="stat-value ${t.remaining < 0 ? 'red' : 'white'}">${money(t.remaining)}</div>
      <div class="stat-foot">${esc(restFoot)}</div>
    </div>
  </div>`;
}

function globalHtml(d: BudgetsResponse, title: string): string {
  const t = d.totals;
  const over = t.spent > t.budgeted;
  const ratio = t.budgeted > 0 ? t.spent / t.budgeted : 0;
  // progressBar marca .over cuando ratio > 1; si el límite es 0 y hay gasto, forzamos el estado excedido.
  const barRatio = over ? Math.max(ratio, 1.001) : ratio;
  return `<div class="card">
    <div class="card-head">
      <h3>Avance global <span class="sub">${esc(title)}</span></h3>
      <span class="badge ${over ? 'red' : 'gray'}">${t.budgeted > 0 ? `${pct(ratio)} usado` : over ? 'Excedido' : 'Sin gasto'}</span>
    </div>
    ${progressBar(barRatio, { lg: true })}
    <div class="bud-global-meta">
      <span>Gastado <b class="red num">${money(t.spent)}</b></span>
      <span>Límite <b class="white num">${money(t.budgeted)}</b></span>
    </div>
  </div>`;
}

function chartCardHtml(): string {
  return `<div class="card">
    <div class="card-head"><h3>Presupuesto vs gastado</h3><span class="muted small">Por categoría</span></div>
    <div class="chart-box"><canvas id="bud-chart" aria-label="Presupuesto contra gastado por categoría" role="img"></canvas></div>
    ${legendHtml(CHART_SERIES)}
  </div>`;
}

function mountChart(body: HTMLElement, d: BudgetsResponse): void {
  const canvas = body.querySelector<HTMLCanvasElement>('#bud-chart');
  if (!canvas) return;
  chartCanvas = canvas;
  monthlyBars(
    canvas,
    [
      { label: CHART_SERIES[0].label, color: CHART_SERIES[0].color, data: d.items.map((b) => b.amount) },
      { label: CHART_SERIES[1].label, color: CHART_SERIES[1].color, data: d.items.map((b) => b.spent) },
    ],
    { labels: d.items.map((b) => b.category_name) },
  );
}

function listHtml(d: BudgetsResponse): string {
  return `<div class="card">
    <div class="card-head"><h3>Presupuestos <span class="sub">${d.items.length}</span></h3></div>
    <div class="list">${d.items.map(itemHtml).join('')}</div>
  </div>`;
}

function itemHtml(b: Budget): string {
  const over = b.remaining < 0;
  const barRatio = over ? Math.max(b.ratio, 1.001) : b.ratio;
  const status = over
    ? `<span class="red">Excedido por ${money(-b.remaining)}</span>`
    : `Quedan ${money(b.remaining)}`;
  return `<div class="list-item bud-row" data-id="${b.id}" role="button" tabindex="0" aria-label="Editar presupuesto de ${esc(b.category_name)}">
    <div class="icon-box">${esc(b.category_icon || '📐')}</div>
    <div class="grow">
      <div class="bud-top">
        <div class="name"><span class="dot" style="background:${esc(b.category_color)}"></span><span>${esc(b.category_name)}</span></div>
        <div class="bud-amounts num"><span class="${over ? 'red' : 'white'}">${money(b.spent)}</span> <span class="muted">/ ${money(b.amount)}</span></div>
      </div>
      ${progressBar(barRatio)}
      <div class="meta bud-meta">${status} · ${pct(b.ratio)}</div>
    </div>
    <div class="bud-actions">
      <button type="button" class="btn ghost icon" data-edit="${b.id}" aria-label="Editar" title="Editar">✎</button>
      <button type="button" class="btn ghost icon" data-del="${b.id}" aria-label="Eliminar" title="Eliminar">🗑</button>
    </div>
  </div>`;
}

function unbudgetedHtml(d: BudgetsResponse): string {
  const n = d.unbudgeted.length;
  return `<div class="card">
    <div class="card-head">
      <h3>Sin presupuesto <span class="sub">${n} ${n === 1 ? 'categoría de gasto' : 'categorías de gasto'}</span></h3>
    </div>
    <div class="list">${d.unbudgeted
      .map(
        (u) => `<div class="list-item">
          <div class="icon-box">${esc(u.category_icon || '🏷️')}</div>
          <div class="grow">
            <div class="name"><span class="dot" style="background:${esc(u.category_color)}"></span> ${esc(u.category_name)}</div>
            <div class="meta">Gastado este mes: <span class="num ${u.spent > 0 ? 'red' : ''}">${money(u.spent)}</span></div>
          </div>
          <button type="button" class="btn sm" data-add="${u.category_id}">Agregar</button>
        </div>`,
      )
      .join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------
function spentHint(u: Unbudgeted | undefined): string {
  if (!u) return 'Elige una categoría para ver lo gastado este mes.';
  return `Gastado este mes en ${u.category_name}: ${money(u.spent)}`;
}

function openNew(presetId?: number): void {
  if (!data || data.year !== state.year || data.month !== state.month) {
    toast('Espera a que carguen los presupuestos');
    return;
  }
  const list = data.unbudgeted;
  if (list.length === 0) {
    toast('Todas las categorías de gasto ya tienen presupuesto este mes');
    return;
  }
  const preset = list.find((u) => u.category_id === presetId);
  const options = list.map((u) => ({
    value: u.category_id,
    label: `${u.category_icon ? `${u.category_icon} ` : ''}${u.category_name}`,
    selected: u.category_id === preset?.category_id,
  }));
  const { year, month } = state;

  formModal({
    title: `Nuevo presupuesto · ${monthName(month)} ${year}`,
    html: `<form class="form">
      ${field('Categoría', select('category_id', options, preset ? {} : { placeholder: 'Selecciona una categoría' }))}
      ${field('Límite mensual', moneyInput('amount'))}
      <p class="help" data-spent-hint>${esc(spentHint(preset))}</p>
    </form>`,
    onOpen: (form) => {
      const sel = form.querySelector<HTMLSelectElement>('select[name=category_id]');
      const hint = form.querySelector<HTMLElement>('[data-spent-hint]');
      sel?.addEventListener('change', () => {
        const u = list.find((x) => x.category_id === Number(sel.value));
        if (hint) hint.textContent = spentHint(u);
      });
    },
    onSubmit: async (v, _form, modal) => {
      const category_id = Number(v.category_id);
      if (!Number.isInteger(category_id) || category_id <= 0) throw new Error('Selecciona una categoría');
      const amount = toNumber(v.amount, 'límite');
      if (amount < 0) throw new Error('El límite no puede ser negativo');
      await api.put<Budget>('/api/budgets', { category_id, year, month, amount });
      modal.close();
      toast('Presupuesto guardado');
      await load();
    },
  });
}

function openEdit(b: Budget): void {
  formModal({
    title: `Editar presupuesto · ${b.category_name}`,
    html: `<form class="form">
      <div class="row">
        <span class="chip"><span class="dot" style="background:${esc(b.category_color)}"></span>${esc(b.category_icon ? `${b.category_icon} ` : '')}${esc(b.category_name)}</span>
        <span class="muted small">${esc(monthName(b.month))} ${b.year}</span>
      </div>
      ${field('Límite mensual', moneyInput('amount', b.amount), `Gastado este mes: ${money(b.spent)}`)}
    </form>`,
    onSubmit: async (v, _form, modal) => {
      const amount = toNumber(v.amount, 'límite');
      if (amount < 0) throw new Error('El límite no puede ser negativo');
      await api.put<Budget>('/api/budgets', { category_id: b.category_id, year: b.year, month: b.month, amount });
      modal.close();
      toast('Guardado');
      await load();
    },
  });
}

async function removeBudget(b: Budget): Promise<void> {
  const ok = await confirmDialog(`¿Eliminar el presupuesto de "${b.category_name}" de ${monthName(b.month)} ${b.year}?`, {
    title: 'Eliminar presupuesto',
  });
  if (!ok) return;
  try {
    await api.del<{ ok: true }>(`/api/budgets/${b.id}`);
    toast('Presupuesto eliminado');
    await load();
  } catch (err) {
    showError(err);
  }
}

async function copyFromPrevious(): Promise<void> {
  const { year, month } = state;
  const fromYear = month === 1 ? year - 1 : year;
  const fromMonth = month === 1 ? 12 : month - 1;
  const src = `${monthName(fromMonth)} ${fromYear}`;
  const buttons = wrap ? Array.from(wrap.querySelectorAll<HTMLButtonElement>('[data-copy-prev]')) : [];
  buttons.forEach((btn) => (btn.disabled = true));
  try {
    const r = await api.post<{ copied: number }>('/api/budgets/copy', {
      from_year: fromYear,
      from_month: fromMonth,
      to_year: year,
      to_month: month,
    });
    if (r.copied === 0) {
      toast(`No había presupuestos nuevos que copiar de ${src}`);
    } else {
      toast(`Se ${r.copied === 1 ? 'copió 1 presupuesto' : `copiaron ${r.copied} presupuestos`} de ${src}`);
      await load();
    }
  } catch (err) {
    showError(err);
  } finally {
    buttons.forEach((btn) => (btn.disabled = false));
  }
}
