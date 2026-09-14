/**
 * Vista "Suscripciones": cargos recurrentes (suscripciones, renta, pagos e ingresos fijos) que se registran solos.
 * El servidor es la fuente de verdad del calendario (server/recurring.ts); aquí solo hay una copia mínima
 * para la vista previa del formulario.
 */
import type {
  Account,
  Category,
  CreditCard,
  RecurringCharge,
  RecurringFrequency,
  RecurringInput,
  RecurringOverview,
  TxType,
  UpcomingCharge,
} from '../../../shared/types';
import { RECURRING_FREQUENCY_LABELS, WEEKDAY_LABELS } from '../../../shared/types';
import { api } from '../api';
import { esc, money, fmtDate, fmtDateShort, daysUntil, todayISO, MONTHS } from '../format';
import { formModal, confirmDialog, toast, showError, field, input, moneyInput, emptyState, loadingState, on, toNumber } from '../ui';
import { monthlyBars, horizontalBars, destroyChart, hexToRgba, COLORS } from '../charts';

const DEFAULT_COLOR = '#e5202e';
const HEX_RE = /^#[0-9a-f]{6}$/i;
const FREQUENCIES: RecurringFrequency[] = ['monthly', 'weekly', 'yearly', 'daily'];
const MAX_DAY_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const UPCOMING_SHOWN = 15;
const CHART_MAX = 10;

let viewRoot: HTMLElement | null = null;
let data: RecurringOverview | null = null;
let categories: Category[] = [];
let cards: CreditCard[] = [];
let accounts: Account[] = [];
let chartCanvas: HTMLCanvasElement | null = null;
/** Se incrementa en cada carga y en destroy(); una respuesta tardía no pinta sobre otra vista. */
let loadToken = 0;
let running = false;

const STYLE = `<style>
  .v-rec .grid > .card { margin-top: 0; }
  .v-rec .v-rec-item { border-top: 3px solid var(--rec-color, var(--red)); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .v-rec .v-rec-item.paused { opacity: 0.78; }
  .v-rec .v-rec-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .v-rec .v-rec-head .grow { flex: 1; min-width: 0; }
  .v-rec .v-rec-head h3 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v-rec .v-rec-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .v-rec .v-rec-amount { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .v-rec .v-rec-item .kv dd { min-width: 0; overflow-wrap: anywhere; }
  .v-rec .v-rec-actions { margin-top: auto; padding-top: 6px; }
  .v-rec .v-rec-up .list { max-height: 380px; overflow-y: auto; }
  .v-rec .v-rec-up .amt { font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .v-rec .v-rec-up .icon-box { width: 34px; height: 34px; font-size: 1rem; }
  .v-rec .v-rec-more { padding-top: 10px; }
  .v-rec .v-rec-section .card-head { margin-bottom: 12px; }
  .v-rec-form .v-rec-every { display: flex; align-items: center; gap: 10px; }
  .v-rec-form .v-rec-every input { width: 96px; flex: none; }
  .v-rec-form .v-rec-preview { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 0.85rem; color: var(--text-2); display: flex; flex-direction: column; gap: 4px; }
  .v-rec-form .v-rec-preview strong { color: var(--white); }
  .v-rec-check { display: inline-flex; align-items: flex-start; gap: 8px; color: var(--text-2); font-size: 0.9rem; cursor: pointer; user-select: none; }
  .v-rec-check input { width: 16px; height: 16px; margin: 3px 0 0; flex: none; accent-color: var(--red); cursor: pointer; }
  .v-rec-form .v-rec-backfill-info { margin: 4px 0 0 24px; color: var(--muted); font-size: 0.8rem; }
</style>`;

// ---------------------------------------------------------------------------
// Calendario (copia mínima de server/recurring.ts, solo para la vista previa del formulario)
// ---------------------------------------------------------------------------
interface Rule {
  frequency: RecurringFrequency;
  interval_n: number;
  day_of_month: number | null;
  weekday: number | null;
  month_of_year: number | null;
  start_date: string;
  end_date: string | null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parseIso(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}
function addDays(s: string, days: number): string {
  const { y, m, d } = parseIso(s);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function weekdayOf(s: string): number {
  const { y, m, d } = parseIso(s);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function clampedDate(y: number, m: number, day: number): string {
  return isoOf(y, m, Math.min(Math.max(1, day), lastDay(y, m)));
}

function firstOccurrence(rule: Rule): string {
  const start = rule.start_date.slice(0, 10);
  const { y, m, d } = parseIso(start);
  switch (rule.frequency) {
    case 'daily':
      return start;
    case 'weekly': {
      const target = rule.weekday ?? weekdayOf(start);
      return addDays(start, (target - weekdayOf(start) + 7) % 7);
    }
    case 'monthly': {
      const day = rule.day_of_month ?? d;
      const thisMonth = clampedDate(y, m, day);
      if (thisMonth >= start) return thisMonth;
      return m === 12 ? clampedDate(y + 1, 1, day) : clampedDate(y, m + 1, day);
    }
    case 'yearly': {
      const month = rule.month_of_year ?? m;
      const day = rule.day_of_month ?? d;
      const thisYear = clampedDate(y, month, day);
      return thisYear >= start ? thisYear : clampedDate(y + 1, month, day);
    }
  }
}

function occurrenceAt(rule: Rule, k: number): string {
  const n = Math.max(1, Math.floor(rule.interval_n || 1));
  const first = firstOccurrence(rule);
  switch (rule.frequency) {
    case 'daily':
      return addDays(first, k * n);
    case 'weekly':
      return addDays(first, k * 7 * n);
    case 'monthly': {
      const { y, m } = parseIso(first);
      const day = rule.day_of_month ?? parseIso(rule.start_date).d;
      const total = y * 12 + (m - 1) + k * n;
      return clampedDate(Math.floor(total / 12), (total % 12) + 1, day);
    }
    case 'yearly': {
      const { y, m } = parseIso(first);
      const day = rule.day_of_month ?? parseIso(rule.start_date).d;
      return clampedDate(y + k * n, m, day);
    }
  }
}

/** Ocurrencias con after < fecha <= until (after exclusivo; null = desde el inicio), respetando end_date. */
function occurrencesBetween(rule: Rule, after: string | null, until: string, limit: number): string[] {
  const out: string[] = [];
  const end = rule.end_date && rule.end_date < until ? rule.end_date : until;
  let k = 0;
  if (after && (rule.frequency === 'daily' || rule.frequency === 'weekly')) {
    const first = firstOccurrence(rule);
    if (after > first) {
      const step = (rule.frequency === 'daily' ? 1 : 7) * Math.max(1, Math.floor(rule.interval_n || 1));
      const days = Math.floor((Date.parse(`${after}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000);
      k = Math.max(0, Math.floor(days / step) - 1);
    }
  }
  for (let guard = 0; guard < 100_000 && out.length < limit; guard++, k++) {
    const date = occurrenceAt(rule, k);
    if (date > end) break;
    if (after === null || date > after) out.push(date);
  }
  return out;
}

function monthlyEquivalent(amount: number, frequency: RecurringFrequency, intervalN: number): number {
  const n = Math.max(1, Math.floor(intervalN || 1));
  const a = Number(amount) || 0;
  const raw = frequency === 'daily' ? (a * 30.4375) / n : frequency === 'weekly' ? (a * 52) / 12 / n : frequency === 'monthly' ? a / n : a / (12 * n);
  return Math.round((raw + Number.EPSILON) * 100) / 100;
}

function scheduleLabel(rule: Rule): string {
  const n = Math.max(1, Math.floor(rule.interval_n || 1));
  switch (rule.frequency) {
    case 'daily':
      return n === 1 ? 'Cada día' : `Cada ${n} días`;
    case 'weekly': {
      const wd = rule.weekday !== null ? WEEKDAY_LABELS[rule.weekday]?.toLowerCase() : null;
      const base = n === 1 ? 'Cada semana' : `Cada ${n} semanas`;
      return wd ? `${base} los ${wd}${wd.endsWith('s') ? '' : 's'}` : base;
    }
    case 'monthly':
      return `${n === 1 ? 'Cada mes' : `Cada ${n} meses`}${rule.day_of_month ? ` el día ${rule.day_of_month}` : ''}`;
    case 'yearly': {
      const when = rule.day_of_month && rule.month_of_year ? ` el ${rule.day_of_month} de ${MONTHS[rule.month_of_year - 1].toLowerCase()}` : '';
      return `${n === 1 ? 'Cada año' : `Cada ${n} años`}${when}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
export async function render(root: HTMLElement): Promise<void> {
  viewRoot = root;
  running = false;
  mountTopbar();
  root.innerHTML = loadingState('Cargando suscripciones…');
  await load(true);
}

export function destroy(): void {
  loadToken++;
  destroyChart(chartCanvas);
  chartCanvas = null;
  viewRoot = null;
  data = null;
}

function mountTopbar(): void {
  const actions = document.getElementById('topbar-actions');
  if (!actions) return;
  actions.innerHTML = `<button type="button" class="btn primary" data-rec-new>+ Nuevo cargo</button>
    <button type="button" class="btn" data-rec-run>Registrar vencidos</button>`;
  actions.querySelector('[data-rec-new]')?.addEventListener('click', () => openForm());
  actions.querySelector<HTMLButtonElement>('[data-rec-run]')?.addEventListener('click', (e) => void runDue(e.currentTarget as HTMLButtonElement));
}

/** Carga el resumen y las listas de apoyo. `first` = primera carga (muestra error con reintento). */
async function load(first = false): Promise<void> {
  const root = viewRoot;
  if (!root) return;
  const my = ++loadToken;
  const [recRes, catsRes, cardsRes, accsRes] = await Promise.allSettled([
    api.get<RecurringOverview>('/api/recurring'),
    api.get<Category[]>('/api/categories'),
    api.get<CreditCard[]>('/api/cards'),
    api.get<Account[]>('/api/accounts/list'),
  ]);
  if (my !== loadToken || viewRoot !== root) return;
  if (catsRes.status === 'fulfilled' && Array.isArray(catsRes.value)) categories = catsRes.value;
  if (cardsRes.status === 'fulfilled' && Array.isArray(cardsRes.value)) cards = cardsRes.value;
  if (accsRes.status === 'fulfilled' && Array.isArray(accsRes.value)) accounts = accsRes.value;
  if (recRes.status === 'rejected') {
    showError(recRes.reason, 'No se pudieron cargar los cargos recurrentes');
    if (first || !data) {
      root.innerHTML = `<div class="card">
        <p class="error-text">No se pudieron cargar tus suscripciones.</p>
        <p class="muted small">${esc(recRes.reason instanceof Error ? recRes.reason.message : '')}</p>
        <div class="form-actions"><button type="button" class="btn" data-retry>Reintentar</button></div>
      </div>`;
      root.querySelector('[data-retry]')?.addEventListener('click', () => {
        root.innerHTML = loadingState('Cargando suscripciones…');
        void load(true);
      });
    }
    return;
  }
  data = recRes.value;
  paint();
}

// ---------------------------------------------------------------------------
// Utilidades de presentación
// ---------------------------------------------------------------------------
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function relDay(date: string): string {
  const d = daysUntil(date);
  if (d === 0) return 'hoy';
  if (d === 1) return 'mañana';
  if (d < 0) return d === -1 ? 'ayer' : `hace ${-d} días`;
  return `en ${d} días`;
}

function accountLabel(bank: string | null | undefined, name: string | null | undefined): string {
  const b = (bank ?? '').trim();
  const n = (name ?? '').trim() || 'Cuenta';
  return b ? `${b} · ${n}` : n;
}

function payText(r: RecurringCharge): string {
  if (r.credit_card_id !== null) return `💳 ${r.card_name ?? 'Tarjeta'}`;
  if (r.account_id !== null) {
    const a = accounts.find((x) => x.id === r.account_id);
    const label = a ? accountLabel(a.bank, a.name) : r.account_name ?? 'Cuenta';
    return r.type === 'income' ? `→ ${label}` : `🏦 ${label}`;
  }
  return 'Sin especificar';
}

function signedAmount(type: TxType, amount: number): string {
  return `${type === 'expense' ? '−' : '+'}${money(amount)}`;
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------
function paint(): void {
  const root = viewRoot;
  const d = data;
  if (!root || !d) return;
  destroyChart(chartCanvas);
  chartCanvas = null;

  const t = d.totals;
  const paused = d.items.filter((i) => !i.active).length;
  const upcomingExpenses = d.upcoming.filter((u) => u.type === 'expense').length;

  root.innerHTML = `${STYLE}<div class="v-rec stack">
    <div class="grid grid-4 stat-row-2">
      <div class="stat">
        <div class="stat-label">Gastas al mes en cargos fijos</div>
        <div class="stat-value red">${esc(money(t.monthly_expense))}</div>
        <div class="stat-foot">Equivalente mensual</div>
      </div>
      <div class="stat">
        <div class="stat-label">Próximos 30 días</div>
        <div class="stat-value">${esc(money(t.next_30_days_expense))}</div>
        <div class="stat-foot">${upcomingExpenses ? esc(plural(upcomingExpenses, 'cargo', 'cargos')) : 'Sin cargos próximos'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Ingresos fijos al mes</div>
        <div class="stat-value white">${esc(money(t.monthly_income))}</div>
        <div class="stat-foot">Equivalente mensual</div>
      </div>
      <div class="stat">
        <div class="stat-label">Cargos activos</div>
        <div class="stat-value">${t.active}</div>
        <div class="stat-foot">${paused ? esc(plural(paused, 'en pausa', 'en pausa')) : `de ${d.items.length}`}</div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card v-rec-up">
        <div class="card-head"><h2>Próximos cargos <span class="sub">30 días</span></h2></div>
        ${upcomingHtml(d.upcoming)}
      </div>
      <div class="card">
        <div class="card-head"><h2>Cargos fijos por mes <span class="sub">equivalente mensual</span></h2></div>
        <div data-chart></div>
      </div>
    </div>

    <div class="tip">Los cargos automáticos se registran solos en Movimientos el día que tocan (al abrir la app se ponen al día). Si pagas con una cartera, se descuenta de su saldo; si pagas con tarjeta, suma a su deuda.</div>

    <section class="v-rec-section">
      <div class="card-head"><h2>Tus cargos <span class="sub">${esc(plural(d.items.length, 'cargo', 'cargos'))}</span></h2></div>
      ${
        d.items.length
          ? `<div class="grid grid-auto">${d.items.map(itemCard).join('')}</div>`
          : emptyState(
              '🔁',
              'Aún no tienes cargos recurrentes',
              'Agrega tus suscripciones (Netflix, Spotify), la renta o tu nómina y se registrarán solas en Movimientos.',
              '<button type="button" class="btn primary" data-new>Agregar mi primer cargo</button>',
            )
      }
    </section>
  </div>`;

  const wrap = root.querySelector<HTMLElement>('.v-rec');
  if (!wrap) return;
  bind(wrap);
  const chartBox = wrap.querySelector<HTMLElement>('[data-chart]');
  if (chartBox) paintChart(chartBox, d.items);
}

function upcomingHtml(list: UpcomingCharge[]): string {
  if (!list.length) return `<p class="muted small">No hay cargos en los próximos 30 días.</p>`;
  const shown = list.slice(0, UPCOMING_SHOWN);
  const rest = list.length - shown.length;
  return `<div class="list">${shown
    .map((u) => {
      const isExpense = u.type === 'expense';
      return `<div class="list-item">
        <div class="icon-box">${esc(u.category_icon || '🔁')}</div>
        <div class="grow">
          <div class="name" title="${esc(u.name)}">${esc(u.name)}</div>
          <div class="meta">${esc(fmtDateShort(u.date))} · ${esc(relDay(u.date))} · ${esc(u.payment_label)}</div>
        </div>
        <span class="amt ${isExpense ? 'red' : 'white'}">${esc(signedAmount(u.type, u.amount))}</span>
      </div>`;
    })
    .join('')}</div>${rest > 0 ? `<p class="muted small v-rec-more">y ${esc(plural(rest, 'cargo más', 'cargos más'))} en los próximos 30 días</p>` : ''}`;
}

function paintChart(box: HTMLElement, items: RecurringCharge[]): void {
  const rows = items
    .filter((i) => i.active && i.type === 'expense' && i.monthly_equivalent > 0)
    .map((i) => ({ label: i.name, value: i.monthly_equivalent }))
    .sort((a, b) => b.value - a.value)
    .slice(0, CHART_MAX);
  if (!rows.length) {
    box.innerHTML = emptyState('📉', 'Sin cargos de gasto activos', 'Cuando agregues suscripciones o pagos fijos verás aquí cuánto pesa cada uno al mes.');
    return;
  }
  if (rows.length > 6) {
    box.innerHTML = `<div class="chart-box" style="height:${Math.max(240, rows.length * 34 + 40)}px"><canvas aria-label="Equivalente mensual por cargo"></canvas></div>`;
    chartCanvas = box.querySelector('canvas');
    if (chartCanvas) horizontalBars(chartCanvas, rows, COLORS.expense);
  } else {
    box.innerHTML = `<div class="chart-box sm"><canvas aria-label="Equivalente mensual por cargo"></canvas></div>`;
    chartCanvas = box.querySelector('canvas');
    if (chartCanvas) {
      monthlyBars(chartCanvas, [{ label: 'Cargos', data: rows.map((r) => r.value), color: COLORS.expense }], { labels: rows.map((r) => r.label) });
    }
  }
}

function itemCard(r: RecurringCharge): string {
  const color = HEX_RE.test(r.color) ? r.color : DEFAULT_COLOR;
  const isExpense = r.type === 'expense';
  const today = todayISO();
  const ended = r.end_date !== null && r.end_date < today;
  let nextHtml: string;
  if (r.next_date) nextHtml = `Próximo: <span class="white">${esc(fmtDate(r.next_date))}</span> <span class="muted">· ${esc(relDay(r.next_date))}</span>`;
  else if (!r.active && !ended) nextHtml = 'En pausa';
  else nextHtml = 'Terminado';

  const badges = [
    r.auto_post ? '<span class="badge white">Automático</span>' : '<span class="badge gray">Manual</span>',
    r.active ? '' : '<span class="badge red">Pausado</span>',
  ].join('');

  const category = r.category_name ? `${r.category_icon ? `${esc(r.category_icon)} ` : ''}${esc(r.category_name)}` : '<span class="muted">Sin categoría</span>';

  return `<div class="card v-rec-item ${r.active ? '' : 'paused'}" style="--rec-color:${color}">
    <div class="v-rec-head">
      <div class="icon-box" style="border-color:${hexToRgba(color, 0.55)};background:${hexToRgba(color, 0.16)}">${esc(r.category_icon || '🔁')}</div>
      <div class="grow">
        <h3 title="${esc(r.name)}">${esc(r.name)}</h3>
        <div class="v-rec-badges">${badges}</div>
      </div>
    </div>
    <div>
      <div class="v-rec-amount ${isExpense ? 'red' : 'white'}">${esc(signedAmount(r.type, r.amount))}</div>
      <div class="text-2 small">${esc(r.schedule_label)}</div>
    </div>
    <div class="small text-2">${nextHtml}</div>
    <dl class="kv">
      <dt>${isExpense ? 'Forma de pago' : 'Entra a'}</dt><dd>${esc(payText(r))}</dd>
      <dt>Categoría</dt><dd>${category}</dd>
      <dt>Al mes</dt><dd class="num">≈ ${esc(money(r.monthly_equivalent))}</dd>
      <dt>Registrados</dt><dd class="num">${r.posted_count} (${esc(money(r.posted_total))})</dd>
      ${r.end_date ? `<dt>${ended ? 'Terminó' : 'Termina'}</dt><dd>${esc(fmtDate(r.end_date))}</dd>` : ''}
    </dl>
    <div class="row v-rec-actions">
      <button type="button" class="btn ghost sm" data-edit="${r.id}">Editar</button>
      <button type="button" class="btn sm" data-toggle="${r.id}">${r.active ? 'Pausar' : 'Reanudar'}</button>
      <button type="button" class="btn danger sm icon" data-delete="${r.id}" aria-label="Eliminar cargo" title="Eliminar cargo">🗑</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function findItem(id: string | undefined): RecurringCharge | undefined {
  return data?.items.find((i) => i.id === Number(id));
}

function bind(wrap: HTMLElement): void {
  on(wrap, 'click', '[data-new]', () => openForm());
  on(wrap, 'click', '[data-edit]', (el) => {
    const r = findItem(el.dataset.edit);
    if (r) openForm(r);
  });
  on(wrap, 'click', '[data-toggle]', (el) => {
    const r = findItem(el.dataset.toggle);
    if (r) void toggleActive(r, el as HTMLButtonElement);
  });
  on(wrap, 'click', '[data-delete]', (el) => {
    const r = findItem(el.dataset.delete);
    if (r) void deleteCharge(r);
  });
}

async function runDue(btn: HTMLButtonElement): Promise<void> {
  if (running) return;
  running = true;
  btn.disabled = true;
  try {
    const res = await api.post<{ posted: number }>('/api/recurring/run');
    const n = Number(res?.posted) || 0;
    toast(n === 0 ? 'No hay cargos vencidos por registrar' : `Se ${n === 1 ? 'registró 1 movimiento' : `registraron ${n} movimientos`}`);
    await load();
  } catch (err) {
    showError(err);
  } finally {
    running = false;
    btn.disabled = false;
  }
}

async function toggleActive(r: RecurringCharge, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    await api.put<RecurringCharge>(`/api/recurring/${r.id}`, { active: !r.active });
    toast(r.active ? `"${r.name}" en pausa` : `"${r.name}" reanudado`);
    await load();
  } catch (err) {
    btn.disabled = false;
    showError(err);
  }
}

async function deleteCharge(r: RecurringCharge): Promise<void> {
  const ok = await confirmDialog(`¿Eliminar "${r.name}"? Los movimientos que ya se registraron se conservan.`, { title: 'Eliminar cargo' });
  if (!ok) return;
  try {
    await api.del(`/api/recurring/${r.id}`);
    toast('Cargo eliminado');
    await load();
  } catch (err) {
    showError(err);
  }
}

// ---------------------------------------------------------------------------
// Formulario (alta y edición)
// ---------------------------------------------------------------------------
function catOptions(type: TxType, selected: number | null, existing?: RecurringCharge): string {
  const missing =
    selected !== null && !categories.some((c) => c.id === selected)
      ? `<option value="${selected}" selected>${esc(existing?.category_name ?? `Categoría #${selected}`)}</option>`
      : '';
  return (
    '<option value="">Sin categoría</option>' +
    missing +
    categories
      .filter((c) => c.type === type)
      .map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.icon ? `${esc(c.icon)} ` : ''}${esc(c.name)}</option>`)
      .join('')
  );
}

function parsePay(value: string): { kind: 'acc' | 'card' | ''; id: number | null } {
  const m = /^(acc|card):(\d+)$/.exec(value);
  return m ? { kind: m[1] as 'acc' | 'card', id: Number(m[2]) } : { kind: '', id: null };
}

function payValueOf(r: RecurringCharge | undefined, t: TxType): string {
  if (!r) return '';
  if (t === 'expense' && r.credit_card_id !== null) return `card:${r.credit_card_id}`;
  if (r.account_id !== null) return `acc:${r.account_id}`;
  return '';
}

function payOptions(t: TxType, selected: string, existing?: RecurringCharge): string {
  const sel = parsePay(selected);
  const opt = (value: string, label: string): string => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  const accOpts = accounts.filter((a) => !a.archived).map((a) => opt(`acc:${a.id}`, accountLabel(a.bank, a.name)));
  if (sel.kind === 'acc' && !accounts.some((a) => a.id === sel.id && !a.archived)) {
    const known = accounts.find((a) => a.id === sel.id);
    const label = known
      ? `${accountLabel(known.bank, known.name)} (archivada)`
      : existing && existing.account_id === sel.id
        ? existing.account_name ?? `Cuenta #${sel.id}`
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
  const cardGroup = cardOpts.length ? `<optgroup label="Tarjetas">${cardOpts.join('')}</optgroup>` : '';
  return none + accGroup + cardGroup;
}

function payLabel(t: TxType): string {
  return t === 'income' ? '¿A qué cuenta entra?' : 'Forma de pago';
}

function everySuffix(f: RecurringFrequency, n: number): string {
  const one = n === 1;
  switch (f) {
    case 'daily':
      return one ? 'día' : 'días';
    case 'weekly':
      return one ? 'semana' : 'semanas';
    case 'monthly':
      return one ? 'mes' : 'meses';
    case 'yearly':
      return one ? 'año' : 'años';
  }
}

function intIn(raw: string | undefined, min: number, max: number): number | null {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

function openForm(existing?: RecurringCharge): void {
  const today = todayISO();
  const now = parseIso(today);
  const type: TxType = existing?.type ?? 'expense';
  const freq: RecurringFrequency = existing?.frequency ?? 'monthly';
  const interval = existing?.interval_n ?? 1;
  const domMonthly = existing?.frequency === 'monthly' && existing.day_of_month ? existing.day_of_month : now.d;
  const weekday = existing?.frequency === 'weekly' && existing.weekday !== null ? existing.weekday : weekdayOf(today);
  const yMonth = existing?.frequency === 'yearly' && existing.month_of_year ? existing.month_of_year : now.m;
  const yDay = existing?.frequency === 'yearly' && existing.day_of_month ? existing.day_of_month : now.d;
  const pay = payValueOf(existing, type);
  const color = existing && HEX_RE.test(existing.color) ? existing.color : DEFAULT_COLOR;

  const html = `<form class="form v-rec-form">
    ${field('Nombre', `<input type="text" name="name" maxlength="80" required placeholder="Netflix, Spotify, Renta…" value="${esc(existing?.name ?? '')}" autocomplete="off" />`)}
    <div class="form-row">
      <div class="field">
        <label>Tipo</label>
        <div class="segmented" data-seg role="group" aria-label="Tipo">
          <button type="button" data-type="expense" class="${type === 'expense' ? 'active expense' : ''}">Gasto</button>
          <button type="button" data-type="income" class="${type === 'income' ? 'active income' : ''}">Ingreso</button>
        </div>
        <input type="hidden" name="type" value="${type}" />
      </div>
      ${field('Monto', moneyInput('amount', existing?.amount ?? null))}
    </div>
    <div class="form-row">
      ${field(
        'Frecuencia',
        `<select name="frequency" data-freq>${FREQUENCIES.map((f) => `<option value="${f}" ${f === freq ? 'selected' : ''}>${esc(RECURRING_FREQUENCY_LABELS[f])}</option>`).join('')}</select>`,
      )}
      <div class="field">
        <label for="rec-every">Cada</label>
        <div class="v-rec-every">
          <input type="number" id="rec-every" name="interval_n" min="1" max="365" step="1" value="${interval}" required />
          <span class="text-2" data-every-suffix>${esc(everySuffix(freq, interval))}</span>
        </div>
      </div>
    </div>
    <div data-group="monthly">
      ${field('Día del mes', input('day_monthly', { type: 'number', min: 1, max: 31, step: '1', value: domMonthly }), 'Si el mes no tiene ese día, se usa el último día del mes')}
    </div>
    <div data-group="weekly">
      ${field('Día de la semana', `<select name="weekday">${WEEKDAY_LABELS.map((w, i) => `<option value="${i}" ${i === weekday ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select>`)}
    </div>
    <div class="form-row" data-group="yearly">
      ${field('Mes', `<select name="year_month" data-ymonth>${MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === yMonth ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`)}
      ${field('Día', input('year_day', { type: 'number', min: 1, max: MAX_DAY_IN_MONTH[yMonth - 1], step: '1', value: yDay }))}
    </div>
    ${field('Categoría', `<select name="category_id" data-cat>${catOptions(type, existing?.category_id ?? null, existing)}</select>`)}
    <div class="field">
      <label for="rec-pay" data-pay-label>${esc(payLabel(type))}</label>
      <select name="pay" id="rec-pay" data-pay>${payOptions(type, pay, existing)}</select>
      <span class="help" data-pay-help></span>
    </div>
    <div class="form-row">
      ${field('Fecha de inicio', input('start_date', { type: 'date', value: existing?.start_date ?? today, required: true }))}
      ${field('Fecha de fin', input('end_date', { type: 'date', value: existing?.end_date ?? '' }), 'Opcional')}
    </div>
    <div class="field">
      <label class="v-rec-check"><input type="checkbox" name="auto_post" ${existing ? (existing.auto_post ? 'checked' : '') : 'checked'} /> Registrar automáticamente</label>
      <span class="help" data-auto-help></span>
    </div>
    ${
      existing
        ? ''
        : `<div class="field hidden" data-backfill-wrap>
            <label class="v-rec-check"><input type="checkbox" name="backfill" /> Registrar también los cargos pasados desde la fecha de inicio</label>
            <p class="v-rec-backfill-info" data-backfill-info aria-live="polite"></p>
          </div>`
    }
    ${field('Color', `<input type="color" name="color" value="${esc(color)}" />`)}
    <div class="v-rec-preview" data-preview aria-live="polite"></div>
  </form>`;

  formModal({
    title: existing ? 'Editar cargo' : 'Nuevo cargo recurrente',
    html,
    submitLabel: existing ? 'Guardar cambios' : 'Agregar cargo',
    onOpen(form) {
      const q = <T extends Element>(sel: string): T => form.querySelector<T>(sel)!;
      const seg = q<HTMLElement>('[data-seg]');
      const hiddenType = q<HTMLInputElement>('input[name=type]');
      const amountIn = q<HTMLInputElement>('input[name=amount]');
      const freqSel = q<HTMLSelectElement>('[data-freq]');
      const everyIn = q<HTMLInputElement>('input[name=interval_n]');
      const suffix = q<HTMLElement>('[data-every-suffix]');
      const domIn = q<HTMLInputElement>('input[name=day_monthly]');
      const wdSel = q<HTMLSelectElement>('select[name=weekday]');
      const yMonthSel = q<HTMLSelectElement>('[data-ymonth]');
      const yDayIn = q<HTMLInputElement>('input[name=year_day]');
      const catSel = q<HTMLSelectElement>('[data-cat]');
      const paySel = q<HTMLSelectElement>('[data-pay]');
      const payLabelEl = q<HTMLElement>('[data-pay-label]');
      const payHelpEl = q<HTMLElement>('[data-pay-help]');
      const startIn = q<HTMLInputElement>('input[name=start_date]');
      const endIn = q<HTMLInputElement>('input[name=end_date]');
      const autoIn = q<HTMLInputElement>('input[name=auto_post]');
      const autoHelp = q<HTMLElement>('[data-auto-help]');
      const backfillWrap = form.querySelector<HTMLElement>('[data-backfill-wrap]');
      const backfillIn = form.querySelector<HTMLInputElement>('input[name=backfill]');
      const backfillInfo = form.querySelector<HTMLElement>('[data-backfill-info]');
      const preview = q<HTMLElement>('[data-preview]');
      let payTouched = false;

      const currentRule = (): Rule | null => {
        const f = (FREQUENCIES as string[]).includes(freqSel.value) ? (freqSel.value as RecurringFrequency) : 'monthly';
        const n = intIn(everyIn.value, 1, 365);
        const start = startIn.value;
        if (n === null || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
        const rule: Rule = { frequency: f, interval_n: n, day_of_month: null, weekday: null, month_of_year: null, start_date: start, end_date: endIn.value || null };
        if (f === 'monthly') {
          rule.day_of_month = intIn(domIn.value, 1, 31);
          if (rule.day_of_month === null) return null;
        } else if (f === 'weekly') {
          rule.weekday = intIn(wdSel.value, 0, 6);
          if (rule.weekday === null) return null;
        } else if (f === 'yearly') {
          rule.month_of_year = intIn(yMonthSel.value, 1, 12);
          if (rule.month_of_year === null) return null;
          rule.day_of_month = intIn(yDayIn.value, 1, MAX_DAY_IN_MONTH[rule.month_of_year - 1]);
          if (rule.day_of_month === null) return null;
        }
        return rule;
      };

      const refresh = (): void => {
        const f = freqSel.value as RecurringFrequency;
        const n = intIn(everyIn.value, 1, 365) ?? 1;
        suffix.textContent = everySuffix(f, n);
        form.querySelectorAll<HTMLElement>('[data-group]').forEach((g) => {
          const shown = g.dataset.group === f;
          g.classList.toggle('hidden', !shown);
          g.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((el) => (el.disabled = !shown));
        });
        yDayIn.max = String(MAX_DAY_IN_MONTH[(Number(yMonthSel.value) || 1) - 1]);

        const t: TxType = hiddenType.value === 'income' ? 'income' : 'expense';
        const hasAccounts = accounts.some((a) => !a.archived);
        payHelpEl.textContent =
          t === 'income'
            ? hasAccounts
              ? 'El ingreso se suma al saldo de esa cuenta en Mi dinero.'
              : 'Registra tus cuentas en Mi dinero para elegir a dónde entra.'
            : parsePay(paySel.value).kind === 'card'
              ? 'Cada cargo suma a la deuda de la tarjeta.'
              : parsePay(paySel.value).kind === 'acc'
                ? 'Cada cargo se descuenta del saldo de esa cuenta.'
                : 'Elige una cuenta o tarjeta para que el cargo afecte su saldo.';
        autoHelp.textContent = autoIn.checked
          ? 'Se guarda solo en Movimientos el día que toca.'
          : 'No se registra: solo aparece como recordatorio en Próximos cargos.';

        const rule = currentRule();
        // Cargos pasados (solo al crear, con inicio anterior a hoy y registro automático)
        const canBackfill = !existing && autoIn.checked && /^\d{4}-\d{2}-\d{2}$/.test(startIn.value) && startIn.value < today;
        if (backfillWrap) backfillWrap.classList.toggle('hidden', !canBackfill);
        if (backfillInfo) {
          if (canBackfill && rule && backfillIn?.checked) {
            const past = occurrencesBetween(rule, null, addDays(today, -1), 401);
            const amount = Number(amountIn.value);
            const count = Math.min(400, past.length);
            backfillInfo.textContent =
              count === 0
                ? 'No hay cargos entre la fecha de inicio y ayer.'
                : `${count === 1 ? 'Se registrará' : 'Se registrarán'} ${plural(count, 'cargo pasado', 'cargos pasados')}${Number.isFinite(amount) && amount > 0 ? ` (${money(amount * count)})` : ''}${past.length > 400 ? ' · máximo 400' : ''}.`;
          } else backfillInfo.textContent = canBackfill ? 'Si no lo marcas, solo se registra desde hoy.' : '';
        }

        if (!rule) {
          preview.innerHTML = '<span>Completa la frecuencia y la fecha de inicio para ver las próximas fechas.</span>';
          return;
        }
        if (rule.end_date && rule.end_date < rule.start_date) {
          preview.innerHTML = '<span class="error-text">La fecha de fin no puede ser anterior a la fecha de inicio.</span>';
          return;
        }
        const lastPosted = existing?.last_posted_date ?? null;
        const from = lastPosted && addDays(lastPosted, 1) > today ? addDays(lastPosted, 1) : today;
        const next = occurrencesBetween(rule, addDays(from, -1), '9999-12-31', 3);
        const amount = Number(amountIn.value);
        const perMonth = Number.isFinite(amount) && amount > 0 ? monthlyEquivalent(amount, rule.frequency, rule.interval_n) : null;
        const dates = next.length
          ? next
              .map((dt) => {
                const note = dt === today && autoIn.checked ? ' (se registra al guardar)' : '';
                return `${esc(fmtDate(dt))} <span class="muted">· ${esc(relDay(dt))}${esc(note)}</span>`;
              })
              .join('<br>')
          : '<span class="muted">Sin próximas fechas: la fecha de fin ya pasó.</span>';
        preview.innerHTML = `<span><strong>${esc(scheduleLabel(rule))}</strong>${perMonth !== null ? ` · ≈ ${esc(money(perMonth))} al mes` : ''}</span>
          <span class="muted small">Próximas fechas:</span>
          <span>${dates}</span>`;
      };

      const setType = (t: TxType): void => {
        if (hiddenType.value === t) return;
        hiddenType.value = t;
        seg.querySelectorAll<HTMLButtonElement>('button[data-type]').forEach((b) => (b.className = b.dataset.type === t ? `active ${t}` : ''));
        catSel.innerHTML = catOptions(t, existing && existing.type === t ? existing.category_id : null, existing);
        const cur = paySel.value;
        const next = payTouched && !(t === 'income' && parsePay(cur).kind === 'card') ? cur : payValueOf(existing, t);
        paySel.innerHTML = payOptions(t, next, existing);
        paySel.value = next;
        payLabelEl.textContent = payLabel(t);
        refresh();
      };

      seg.querySelectorAll<HTMLButtonElement>('button[data-type]').forEach((b) =>
        b.addEventListener('click', () => setType(b.dataset.type === 'income' ? 'income' : 'expense')),
      );
      paySel.addEventListener('change', () => {
        payTouched = true;
        refresh();
      });
      yMonthSel.addEventListener('change', () => {
        const max = MAX_DAY_IN_MONTH[(Number(yMonthSel.value) || 1) - 1];
        if ((Number(yDayIn.value) || 0) > max) yDayIn.value = String(max);
        refresh();
      });
      [freqSel, wdSel, autoIn, backfillIn].forEach((el) => el?.addEventListener('change', refresh));
      [amountIn, everyIn, domIn, yDayIn, startIn, endIn].forEach((el) => {
        el.addEventListener('input', refresh);
        el.addEventListener('change', refresh);
      });
      refresh();
    },
    async onSubmit(values, form, modal) {
      const name = (values.name ?? '').trim();
      if (!name) throw new Error('Escribe el nombre del cargo');
      const t: TxType = values.type === 'income' ? 'income' : 'expense';
      const amount = toNumber(values.amount ?? '', 'monto');
      if (!(amount > 0)) throw new Error('El monto debe ser mayor a 0');
      const freqRaw = form.querySelector<HTMLSelectElement>('[data-freq]')?.value ?? '';
      const frequency: RecurringFrequency = (FREQUENCIES as string[]).includes(freqRaw) ? (freqRaw as RecurringFrequency) : 'monthly';
      const interval_n = intIn(values.interval_n, 1, 365);
      if (interval_n === null) throw new Error('"Cada" debe ser un número entero entre 1 y 365');

      let day_of_month: number | null = null;
      let weekdayVal: number | null = null;
      let month_of_year: number | null = null;
      if (frequency === 'monthly') {
        day_of_month = intIn(values.day_monthly, 1, 31);
        if (day_of_month === null) throw new Error('El día del mes debe estar entre 1 y 31');
      } else if (frequency === 'weekly') {
        weekdayVal = intIn(values.weekday, 0, 6);
        if (weekdayVal === null) throw new Error('Elige el día de la semana');
      } else if (frequency === 'yearly') {
        month_of_year = intIn(values.year_month, 1, 12);
        if (month_of_year === null) throw new Error('Elige el mes');
        const max = MAX_DAY_IN_MONTH[month_of_year - 1];
        day_of_month = intIn(values.year_day, 1, max);
        if (day_of_month === null) throw new Error(`${MONTHS[month_of_year - 1]} no tiene ese día: elige un día entre 1 y ${max}`);
      }

      const start_date = values.start_date ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) throw new Error('La fecha de inicio es obligatoria');
      const end_date = values.end_date ? values.end_date : null;
      if (end_date && end_date < start_date) throw new Error('La fecha de fin no puede ser anterior a la fecha de inicio');

      const p = parsePay(values.pay ?? '');
      const credit_card_id = t === 'expense' && p.kind === 'card' ? p.id : null;
      const account_id = p.kind === 'acc' ? p.id : null;
      const auto_post = values.auto_post === 'on';

      const body: RecurringInput = {
        name,
        type: t,
        amount: Math.round((amount + Number.EPSILON) * 100) / 100,
        category_id: values.category_id ? Number(values.category_id) : null,
        account_id,
        credit_card_id,
        frequency,
        interval_n,
        day_of_month,
        weekday: weekdayVal,
        month_of_year,
        start_date,
        end_date,
        auto_post,
        color: HEX_RE.test(values.color ?? '') ? values.color : DEFAULT_COLOR,
      };

      if (existing) {
        await api.put<RecurringCharge>(`/api/recurring/${existing.id}`, body);
        modal.close();
        toast('Cargo actualizado');
      } else {
        const today = todayISO();
        if (auto_post && start_date < today && values.backfill === 'on') body.backfill = true;
        const created = await api.post<RecurringCharge>('/api/recurring', body);
        modal.close();
        toast(
          created.posted_count > 0
            ? `Cargo agregado · ${created.posted_count === 1 ? 'se registró 1 movimiento' : `se registraron ${created.posted_count} movimientos`}`
            : 'Cargo agregado',
        );
      }
      await load();
    },
  });
}
