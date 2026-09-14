/**
 * Vista "Resumen": dashboard anual con gráficas por mes, mes actual, hábitos y accesos a las secciones.
 */
import type { CategoryTotal, DashboardYear, Transaction } from '../../../shared/types';
import { api, qs } from '../api';
import { esc, money, moneySigned, pct, fmtDateShort, daysUntil, monthName, currentYear } from '../format';
import { emptyState, loadingState, progressBar, showError, on } from '../ui';
import { monthlyBars, monthlyLines, horizontalBars, legendHtml, COLORS, destroyChart } from '../charts';

type ChartInst = ReturnType<typeof monthlyBars>;

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const MAX_CATS = 8;

let year = currentYear();
let data: DashboardYear | null = null;
let catTab: 'year' | 'month' = 'year';
let charts: ChartInst[] = [];
let rootEl: HTMLElement | null = null;
let loadSeq = 0;

const STYLE = `<style>
.v-dash .cat-layout{display:grid;grid-template-columns:1fr;gap:10px}
.v-dash .cat-list .list-item{padding:7px 0;gap:10px}
.v-dash .cat-list .name{font-weight:500}
.v-dash .cat-list .share{color:var(--muted);font-size:.8rem;min-width:44px;text-align:right}
.v-dash .amt{font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.v-dash .kv{margin:0}
.v-dash .kv dd.total{border-top:1px solid var(--border);padding-top:6px}
.v-dash .kv dt.total{border-top:1px solid var(--border);padding-top:6px}
.v-dash .habits .icon-box{width:34px;height:34px;font-size:1rem}
.v-dash .habits .text{font-size:.9rem;color:var(--text-2)}
.v-dash .big{font-size:1.45rem;font-weight:800;letter-spacing:-.02em;line-height:1.15;font-variant-numeric:tabular-nums}
.v-dash .summary-card{display:flex;flex-direction:column;gap:10px}
.v-dash .summary-card .card-head{margin-bottom:0}
.v-dash .summary-card .kv{font-size:.85rem}
.v-dash .card-head a.btn{text-decoration:none}
.v-dash .row-gap{margin-top:16px}
.v-dash .cat-empty{padding:18px 0}
</style>`;

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
export async function render(root: HTMLElement): Promise<void> {
  rootEl = root;
  year = currentYear();
  catTab = 'year';
  renderTopbar([year]);
  await load();
}

export function destroy(): void {
  loadSeq++;
  killCharts();
  data = null;
  rootEl = null;
}

function killCharts(): void {
  for (const c of charts) {
    try {
      destroyChart(c.canvas);
    } catch {
      /* ignorar */
    }
  }
  charts = [];
}

// ---------------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------------
async function load(): Promise<void> {
  const root = rootEl;
  if (!root) return;
  const seq = ++loadSeq;
  killCharts();
  root.innerHTML = loadingState('Cargando resumen…');
  try {
    const d = await api.get<DashboardYear>(`/api/dashboard${qs({ year })}`);
    if (seq !== loadSeq || rootEl !== root) return;
    data = d;
    renderTopbar(d.available_years);
    draw(root, d);
  } catch (err) {
    if (seq !== loadSeq || rootEl !== root) return;
    showError(err);
    const msg = err instanceof Error ? err.message : '';
    root.innerHTML = emptyState('⚠️', 'No se pudo cargar el resumen', msg, '<button type="button" class="btn primary" data-retry>Reintentar</button>');
    root.querySelector('[data-retry]')?.addEventListener('click', () => void load());
  }
}

// ---------------------------------------------------------------------------
// Barra superior: selector de año
// ---------------------------------------------------------------------------
function renderTopbar(years: number[]): void {
  const bar = document.getElementById('topbar-actions');
  if (!bar) return;
  const list = Array.from(new Set([...years, year])).sort((a, b) => b - a);
  bar.innerHTML = `
    <div class="period" aria-label="Año del resumen">
      <button type="button" class="btn icon" data-prev aria-label="Año anterior" ${year <= MIN_YEAR ? 'disabled' : ''}>‹</button>
      <select data-year aria-label="Año">${list.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <button type="button" class="btn icon" data-next aria-label="Año siguiente" ${year >= MAX_YEAR ? 'disabled' : ''}>›</button>
    </div>`;
  const setYear = (y: number): void => {
    if (!Number.isInteger(y) || y < MIN_YEAR || y > MAX_YEAR || y === year) return;
    year = y;
    void load();
  };
  bar.querySelector('[data-prev]')?.addEventListener('click', () => setYear(year - 1));
  bar.querySelector('[data-next]')?.addEventListener('click', () => setYear(year + 1));
  bar.querySelector<HTMLSelectElement>('[data-year]')?.addEventListener('change', (e) => setYear(Number((e.target as HTMLSelectElement).value)));
}

// ---------------------------------------------------------------------------
// Dibujo principal
// ---------------------------------------------------------------------------
function draw(root: HTMLElement, d: DashboardYear): void {
  const wrap = document.createElement('div');
  wrap.className = 'v-dash';
  const isCurrentYear = d.year === currentYear();
  const cm = d.current_month;

  const noData = d.recent.length === 0;
  const netCls = d.totals.net < 0 ? 'red' : 'white';
  const bestWorst =
    d.totals.best_month && d.totals.worst_month
      ? `Mejor mes: ${monthName(d.totals.best_month)} · Peor mes: ${monthName(d.totals.worst_month)}`
      : 'Sin actividad este año';

  wrap.innerHTML = `
    ${STYLE}
    ${
      noData
        ? emptyState(
            '📊',
            'Aún no hay movimientos registrados',
            'Registra tu primer ingreso o gasto para empezar a ver tu resumen, tus hábitos y tus gráficas.',
            '<a class="btn primary" href="#/movimientos">+ Registrar mi primer movimiento</a>',
          ) + '<div class="row-gap"></div>'
        : ''
    }

    <div class="grid grid-4">
      ${statTile('Ingresos del año', money(d.totals.income), 'white', `${d.income_by_category.length} categorías de ingreso`)}
      ${statTile('Gastos del año', money(d.totals.expenses), 'red', `Promedio mensual: ${money(d.totals.avg_monthly_expenses)}`)}
      ${statTile('Ahorro del año', money(d.totals.savings), '', `Tasa de ahorro ${pct(d.totals.savings_rate)}`)}
      ${statTile('Disponible del año', money(d.totals.net), netCls, bestWorst)}
    </div>

    <div class="grid grid-2 row-gap">
      <div class="card">
        <div class="card-head">
          <h2>${isCurrentYear ? 'Este mes' : 'Cierre del año'} <span class="sub">${esc(monthName(cm.month))} ${cm.year}</span></h2>
        </div>
        ${monthKv(d)}
        ${budgetHtml(cm.budget)}
        <div class="divider"></div>
        <h3 class="mb">Hábitos</h3>
        <div class="list habits">${habitsHtml(d)}</div>
      </div>

      <div class="card" data-cat-card>
        <div class="card-head">
          <h2>Gastos por categoría</h2>
        </div>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" data-tab="year" class="${catTab === 'year' ? 'active' : ''}">Año</button>
          <button type="button" role="tab" data-tab="month" class="${catTab === 'month' ? 'active' : ''}">${isCurrentYear ? 'Este mes' : esc(monthName(cm.month))}</button>
        </div>
        <div data-cat-body>${catBodyHtml(d)}</div>
      </div>
    </div>

    <div class="card row-gap">
      <div class="card-head"><h2>Ingresos vs gastos por mes</h2><span class="sub">${d.year}</span></div>
      <div class="chart-box"><canvas data-chart="inc-exp" aria-label="Ingresos y gastos por mes"></canvas></div>
      ${legendHtml([
        { label: 'Ingresos', color: COLORS.income },
        { label: 'Gastos', color: COLORS.expense },
      ])}
    </div>

    <div class="grid grid-2 row-gap">
      <div class="card">
        <div class="card-head"><h2>Salidas por mes</h2><span class="sub">Gastos + préstamos + ahorro</span></div>
        <div class="chart-box"><canvas data-chart="outflows" aria-label="Salidas por mes"></canvas></div>
        ${legendHtml([
          { label: 'Gastos', color: COLORS.expense },
          { label: 'Préstamos', color: COLORS.loans },
          { label: 'Ahorro', color: COLORS.savings },
        ])}
      </div>
      <div class="card">
        <div class="card-head"><h2>Disponible por mes</h2><span class="sub">Ingresos − gastos − préstamos − ahorro</span></div>
        <div class="chart-box"><canvas data-chart="net" aria-label="Disponible por mes"></canvas></div>
      </div>
    </div>

    <div class="grid grid-3 row-gap">
      ${cardsSummary(d)}
      ${loansSummary(d)}
      ${goalsSummary(d)}
    </div>

    <div class="card row-gap">
      <div class="card-head">
        <h2>Últimos movimientos</h2>
        <a class="btn ghost sm" href="#/movimientos">Ver todos →</a>
      </div>
      ${recentHtml(d.recent)}
    </div>`;

  root.replaceChildren(wrap);

  // Gráficas mensuales
  const incExp = wrap.querySelector<HTMLCanvasElement>('[data-chart="inc-exp"]');
  if (incExp) {
    charts.push(
      monthlyBars(incExp, [
        { label: 'Ingresos', data: d.months.map((m) => m.income), color: COLORS.income },
        { label: 'Gastos', data: d.months.map((m) => m.expenses), color: COLORS.expense },
      ]),
    );
  }
  const outflows = wrap.querySelector<HTMLCanvasElement>('[data-chart="outflows"]');
  if (outflows) {
    charts.push(
      monthlyBars(
        outflows,
        [
          { label: 'Gastos', data: d.months.map((m) => m.expenses), color: COLORS.expense },
          { label: 'Préstamos', data: d.months.map((m) => m.loan_payments), color: COLORS.loans },
          { label: 'Ahorro', data: d.months.map((m) => m.savings), color: COLORS.savings },
        ],
        { stacked: true },
      ),
    );
  }
  const net = wrap.querySelector<HTMLCanvasElement>('[data-chart="net"]');
  if (net) {
    // En el año en curso los meses que aún no llegan no se dibujan (no son $0, simplemente no existen todavía).
    const cy = currentYear();
    const lastMonth = d.year < cy ? 12 : d.year === cy ? d.current_month.month : 0;
    const netData = d.months.map((m) => (m.month <= lastMonth ? m.net : null));
    charts.push(monthlyLines(net, [{ label: 'Disponible', data: netData, color: COLORS.net }], { fill: true, zeroLine: true }));
  }
  mountCatChart(wrap);

  // Pestañas de categorías (cambian los datos sin recargar)
  on(wrap, 'click', '[data-tab]', (el) => {
    const tab = el.dataset.tab === 'month' ? 'month' : 'year';
    if (tab === catTab || !data) return;
    catTab = tab;
    wrap.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    const body = wrap.querySelector<HTMLElement>('[data-cat-body]');
    if (!body) return;
    const old = body.querySelector<HTMLCanvasElement>('canvas');
    if (old) {
      destroyChart(old);
      charts = charts.filter((c) => c.canvas !== old);
    }
    body.innerHTML = catBodyHtml(data);
    mountCatChart(wrap);
  });
}

// ---------------------------------------------------------------------------
// Fragmentos
// ---------------------------------------------------------------------------
function statTile(label: string, value: string, cls: string, foot: string): string {
  return `<div class="stat">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value ${cls}">${esc(value)}</div>
    <div class="stat-foot">${esc(foot)}</div>
  </div>`;
}

function monthKv(d: DashboardYear): string {
  const cm = d.current_month;
  const row = (k: string, v: string, cls = '', total = false): string =>
    `<dt class="${total ? 'total' : ''}">${esc(k)}</dt><dd class="num ${cls} ${total ? 'total' : ''}">${esc(v)}</dd>`;
  return `<dl class="kv">
    ${row('Ingresos', money(cm.income), 'white')}
    ${row('Gastos', money(cm.expenses), 'red')}
    ${row('Préstamos', money(cm.loan_payments))}
    ${row('Ahorro', money(cm.savings))}
    ${row('Disponible', money(cm.net), cm.net < 0 ? 'red' : 'white', true)}
  </dl>`;
}

function budgetHtml(budget: DashboardYear['current_month']['budget']): string {
  if (!budget) return '';
  const ratio = budget.budgeted > 0 ? budget.spent / budget.budgeted : budget.spent > 0 ? 1.01 : 0;
  return `<div class="mt">
    <div class="row between small"><span class="muted">Presupuesto: <span class="${ratio > 1 ? 'red' : 'white'}">${esc(money(budget.spent))}</span> / ${esc(money(budget.budgeted))}</span><span class="muted">${esc(pct(ratio))}</span></div>
    ${progressBar(ratio)}
  </div>`;
}

function habitsHtml(d: DashboardYear): string {
  const cm = d.current_month;
  const isCurrentYear = d.year === currentYear();
  const items: { icon: string; text: string }[] = [];

  if (cm.income === 0 && cm.expenses === 0) {
    items.push({ icon: '📝', text: 'Aún no hay movimientos en este mes. Registra tus ingresos y gastos para ver tus hábitos.' });
  } else {
    if (cm.expenses > cm.income) {
      items.push({ icon: '⚠️', text: `Este mes gastaste más de lo que ingresó (${money(cm.expenses - cm.income)} de más).` });
    }
    if (cm.income > 0) {
      const rate = cm.savings / cm.income;
      if (rate >= 0.2) items.push({ icon: '🏆', text: `Excelente: ahorraste el ${pct(rate)} de tus ingresos.` });
      else if (rate >= 0.1) items.push({ icon: '👍', text: `Vas bien: ahorraste el ${pct(rate)} de tus ingresos. El objetivo ideal es 20%.` });
      else items.push({ icon: '💡', text: `Intenta apartar al menos el 10% de tus ingresos; este mes llevas ${pct(Math.max(0, rate))}.` });
    }
    if (cm.budget && cm.budget.budgeted > 0) {
      const ratio = cm.budget.spent / cm.budget.budgeted;
      if (ratio > 1) items.push({ icon: '📐', text: `Te pasaste del presupuesto por ${money(cm.budget.spent - cm.budget.budgeted)}.` });
      else if (ratio >= 0.9) items.push({ icon: '📐', text: `Estás cerca del límite de tu presupuesto (${pct(ratio)}).` });
    }
  }
  if (isCurrentYear) {
    if (d.cards.utilization > 0.3) {
      items.push({ icon: '💳', text: `Tu utilización de crédito es ${pct(d.cards.utilization)}; procura mantenerla bajo 30%.` });
    }
    const np = d.cards.next_payment;
    if (np) {
      const days = daysUntil(np.date);
      if (days <= 5) {
        const when = days <= 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`;
        items.push({ icon: '⏰', text: `Pago de ${np.name} ${when} (${fmtDateShort(np.date)}): ${money(np.balance)}.` });
      }
    }
  }
  if (items.length === 0) {
    items.push({ icon: '✅', text: 'Todo en orden: sin alertas para este mes.' });
  }
  return items
    .slice(0, 4)
    .map((it) => `<div class="list-item"><div class="icon-box">${it.icon}</div><div class="grow text">${esc(it.text)}</div></div>`)
    .join('');
}

interface CatSlice {
  label: string;
  value: number;
  share: number;
  icon: string | null;
}

function prepCats(items: CategoryTotal[]): CatSlice[] {
  const sorted = [...items].filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  // Hasta MAX_CATS categorías; el resto se agrupa en "Otros" (nunca se generan más colores).
  const top: CatSlice[] = sorted.slice(0, MAX_CATS).map((c) => ({ label: c.name, value: c.total, share: c.share, icon: c.icon }));
  const rest = sorted.slice(MAX_CATS);
  if (rest.length > 0) {
    top.push({
      label: `Otros (${rest.length})`,
      value: rest.reduce((a, c) => a + c.total, 0),
      share: rest.reduce((a, c) => a + c.share, 0),
      icon: null,
    });
  }
  return top;
}

function catBodyHtml(d: DashboardYear): string {
  const source = catTab === 'year' ? d.expenses_by_category : d.current_month.expenses_by_category;
  const slices = prepCats(source);
  if (slices.length === 0) {
    return `<div class="cat-empty">${emptyState('🧾', 'Sin gastos en este periodo', 'Cuando registres gastos verás aquí su distribución por categoría.')}</div>`;
  }
  // Una sola serie en rojo: la longitud de la barra compara montos; la lista es la vista de tabla.
  const height = Math.max(160, slices.length * 30 + 36);
  return `<div class="cat-layout">
    <div class="chart-box" style="height:${height}px"><canvas data-chart="cats" role="img" aria-label="Gastos por categoría"></canvas></div>
    <div class="list cat-list">
      ${slices
        .map(
          (s) => `<div class="list-item">
            <div class="grow name">${s.icon ? `${esc(s.icon)} ` : ''}${esc(s.label)}</div>
            <span class="amt">${esc(money(s.value))}</span>
            <span class="share num">${esc(pct(s.share))}</span>
          </div>`,
        )
        .join('')}
    </div>
  </div>`;
}

function mountCatChart(wrap: HTMLElement): void {
  if (!data) return;
  const canvas = wrap.querySelector<HTMLCanvasElement>('[data-chart="cats"]');
  if (!canvas) return;
  const source = catTab === 'year' ? data.expenses_by_category : data.current_month.expenses_by_category;
  const slices = prepCats(source);
  if (slices.length === 0) return;
  charts.push(horizontalBars(canvas, slices.map((s) => ({ label: s.label, value: s.value, share: s.share }))));
}

function cardsSummary(d: DashboardYear): string {
  const c = d.cards;
  const np = c.next_payment;
  let npHtml = '<span class="muted small">Sin pagos pendientes</span>';
  if (np) {
    const days = daysUntil(np.date);
    const when = days <= 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`;
    npHtml = `<span class="small"><span class="muted">Próximo pago:</span> ${esc(np.name)} · ${esc(fmtDateShort(np.date))} · ${esc(when)}</span>`;
  }
  return `<div class="card summary-card">
    <div class="card-head"><h2>💳 Tarjetas</h2><a class="btn ghost sm" href="#/tarjetas">Ver →</a></div>
    <div>
      <div class="stat-label">Deuda total</div>
      <div class="big red">${esc(money(c.total_debt))}</div>
    </div>
    ${progressBar(c.utilization)}
    <div class="row between small muted"><span>Utilización ${esc(pct(c.utilization))}</span><span>Límite ${esc(money(c.total_limit))}</span></div>
    ${npHtml}
    <span class="muted small">${c.count} ${c.count === 1 ? 'tarjeta' : 'tarjetas'}</span>
  </div>`;
}

function loansSummary(d: DashboardYear): string {
  const l = d.loans;
  const paidRatio = l.total_principal > 0 ? (l.total_principal - l.total_remaining) / l.total_principal : 0;
  return `<div class="card summary-card">
    <div class="card-head"><h2>🏦 Préstamos</h2><a class="btn ghost sm" href="#/prestamos">Ver →</a></div>
    <div>
      <div class="stat-label">Restante total</div>
      <div class="big ${l.total_remaining > 0 ? 'red' : 'white'}">${esc(money(l.total_remaining))}</div>
    </div>
    ${progressBar(paidRatio, { white: true })}
    <div class="row between small muted"><span>Pagado ${esc(pct(paidRatio))}</span><span>Original ${esc(money(l.total_principal))}</span></div>
    <span class="small"><span class="muted">Compromiso mensual:</span> ${esc(money(l.monthly_commitment))}</span>
    <span class="muted small">${l.count} ${l.count === 1 ? 'préstamo' : 'préstamos'}</span>
  </div>`;
}

function goalsSummary(d: DashboardYear): string {
  const g = d.goals;
  return `<div class="card summary-card">
    <div class="card-head"><h2>🎯 Ahorros</h2><a class="btn ghost sm" href="#/ahorros">Ver →</a></div>
    <div>
      <div class="stat-label">Ahorrado / meta</div>
      <div class="big white">${esc(money(g.total_saved))} <span class="muted small">/ ${esc(money(g.total_target))}</span></div>
    </div>
    ${progressBar(g.progress, { white: true })}
    <div class="row between small muted"><span>Progreso ${esc(pct(g.progress))}</span><span>Faltan ${esc(money(Math.max(0, g.total_target - g.total_saved)))}</span></div>
    <span class="muted small">${g.count} ${g.count === 1 ? 'meta' : 'metas'}</span>
  </div>`;
}

function recentHtml(items: Transaction[]): string {
  if (items.length === 0) {
    return emptyState('🧾', 'Sin movimientos', 'Registra tu primer ingreso o gasto.', '<a class="btn primary" href="#/movimientos">+ Nuevo movimiento</a>');
  }
  return `<div class="list">
    ${items
      .map((t) => {
        const isIncome = t.type === 'income';
        const icon = t.category_icon || (isIncome ? '💰' : '💸');
        const title = t.description || t.category_name || (isIncome ? 'Ingreso' : 'Gasto');
        const meta = [fmtDateShort(t.date), t.category_name ?? 'Sin categoría', t.card_name ? `💳 ${t.card_name}` : ''].filter(Boolean).join(' · ');
        return `<div class="list-item">
          <div class="icon-box">${esc(icon)}</div>
          <div class="grow"><div class="name">${esc(title)}</div><div class="meta">${esc(meta)}</div></div>
          <span class="amt amount ${isIncome ? 'income' : 'expense'}">${esc(moneySigned(isIncome ? t.amount : -t.amount))}</span>
        </div>`;
      })
      .join('')}
  </div>`;
}
