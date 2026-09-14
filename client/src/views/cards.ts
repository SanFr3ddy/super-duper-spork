/**
 * Vista "Tarjetas": tarjetas de crédito con deuda, utilización, fechas de corte/pago,
 * compras a meses (mensualidades), registro de pagos (con la cuenta usada) y consulta de movimientos.
 */
import type { Account, CreditCard, CreditCardInput, CardPayment, CardPaymentInput, InstallmentPlan, InstallmentsResponse, Transaction } from '../../../shared/types';
import { api, qs } from '../api';
import { esc, money, pct, fmtDate, daysUntil, todayISO, monthName, MONTHS_SHORT, currentYear, currentMonth } from '../format';
import { formModal, openModal, confirmDialog, toast, showError, field, input, moneyInput, select, emptyState, loadingState, progressBar, periodPicker, on, toNumber } from '../ui';
import { hexToRgba, destroyChart, destroyDetachedCharts, monthlyBars, COLORS } from '../charts';

const DEFAULT_COLOR = '#e5202e';
const CHARGES_LIMIT = 50;
const LAST_ACCOUNT_KEY = 'finanzas.cards.lastPaymentAccount';

let wrap: HTMLElement | null = null;
let cards: CreditCard[] = [];
let loadSeq = 0;
let instSeq = 0;
let instCanvas: HTMLCanvasElement | null = null;
const instPeriod = { year: currentYear(), month: currentMonth() };

const STYLE = `
<style>
  .v-cards .grid > .card { margin-top: 0; }
  .v-cards .v-card {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: 24px;
  }
  .v-cards .v-card-stripe { position: absolute; top: 0; left: 0; right: 0; height: 6px; }
  .v-cards .v-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .v-cards .v-card-name { font-weight: 700; font-size: 1.05rem; overflow-wrap: anywhere; }
  .v-cards .v-card-chip {
    width: 34px; height: 24px; border-radius: 6px; flex: none;
    background: linear-gradient(135deg, #e6e6e6 0%, #9a9a9a 55%, #cfcfcf 100%);
    box-shadow: inset 0 0 0 1px rgba(0,0,0,.25);
  }
  .v-cards .v-card-amount {
    font-size: 1.7rem; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .v-cards .v-card-pay {
    background: var(--white-soft); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
    padding: 8px 12px; font-size: 0.9rem; line-height: 1.35;
  }
  .v-cards .v-card-pay .num { font-size: 1.05rem; white-space: nowrap; }
  .v-cards .v-card-util { display: flex; flex-direction: column; gap: 6px; }
  .v-cards .v-card .kv { margin: 0; }
  .v-cards .v-card .kv dd .muted { font-weight: 400; }
  .v-cards .v-card-actions { margin-top: auto; padding-top: 4px; }
  .v-cards .v-days { font-weight: 400; }
  .v-cards .v-stat-util .progress { margin-top: 4px; }
  .v-cards .v-stats2 { margin-top: 16px; }
  .v-cards .v-tip { margin-top: 16px; }
  .v-cards .v-grid { margin-top: 16px; }
  .v-cards .v-inst { margin-top: 16px; }
  .v-cards .v-inst .card-head { margin-bottom: 16px; }
  .v-cards .v-inst-stats .stat { background: var(--surface-2); }
  .v-cards .v-inst-chart { margin-top: 20px; }
  .v-cards .v-inst-chart h3 { margin-bottom: 10px; }
  .v-cards .v-inst-table { margin-top: 20px; }
  .v-cards .v-inst-buy { display: flex; align-items: center; gap: 10px; min-width: 180px; }
  .v-cards .v-inst-buy .ico { font-size: 1.15rem; flex: none; width: 24px; text-align: center; }
  .v-cards .v-inst-buy .name { font-weight: 600; overflow-wrap: anywhere; }
  .v-cards .v-inst-progress { min-width: 120px; display: flex; flex-direction: column; gap: 5px; }
  .v-cards .v-inst tr.v-done td { opacity: 0.5; }
  .v-cards .v-inst .v-inst-tip { margin-top: 16px; }
  .v-cards-modal .v-desc { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v-cards-modal .v-note { color: var(--text-2); }
  .v-cards-modal .v-panel-foot { margin-top: 12px; }
  .v-cards-modal .v-desc-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .v-cards-modal .v-msi { flex: none; }
</style>`;

// ---------------------------------------------------------------------------
// Helpers de presentación
// ---------------------------------------------------------------------------
function daysLabel(iso: string): string {
  const d = daysUntil(iso);
  if (d === 0) return 'hoy';
  if (d === 1) return 'mañana';
  if (d < 0) return `hace ${Math.abs(d)} día${Math.abs(d) === 1 ? '' : 's'}`;
  return `en ${d} días`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const sum = (list: CreditCard[], pick: (c: CreditCard) => number): number => Math.round(list.reduce((a, c) => a + pick(c), 0) * 100) / 100;

/** 'YYYY-MM' -> 'Sep 26' */
function ymShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1] ?? ''} ${String(y).slice(2)}`;
}

/** 'YYYY-MM' -> 'septiembre 2026' */
function ymLong(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${monthName(m).toLowerCase()} ${y}`;
}

function statsHtml(list: CreditCard[]): string {
  const totalDebt = sum(list, (c) => c.balance);
  const totalLimit = sum(list, (c) => c.credit_limit);
  const util = totalLimit > 0 ? totalDebt / totalLimit : 0;
  const available = Math.max(0, totalLimit - totalDebt);
  const payMonth = sum(list, (c) => c.pay_this_month);
  const dueInst = sum(list, (c) => c.installments_due_this_month);
  const deferred = sum(list, (c) => c.deferred_remaining);
  const plans = list.reduce((a, c) => a + c.active_plans, 0);
  const next = list
    .filter((c) => c.pay_this_month > 0)
    .sort((a, b) => a.next_payment_date.localeCompare(b.next_payment_date) || a.id - b.id)[0];
  const nextDays = next ? daysUntil(next.next_payment_date) : null;

  return `
    <div class="grid grid-4 stat-row-2">
      <div class="stat">
        <div class="stat-label">Deuda total</div>
        <div class="stat-value red">${money(totalDebt)}</div>
        <div class="stat-foot">${list.length} tarjeta${list.length === 1 ? '' : 's'} · ${list.filter((c) => c.balance > 0).length} con deuda</div>
      </div>
      <div class="stat accent">
        <div class="stat-label">Pago del mes sin intereses</div>
        <div class="stat-value">${money(payMonth)}</div>
        <div class="stat-foot">${deferred > 0 ? `Sin contar ${money(deferred)} diferido a meses` : totalDebt > 0 ? 'Toda tu deuda es exigible este mes' : 'No hay nada que pagar'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Mensualidades este mes</div>
        <div class="stat-value">${money(dueInst)}</div>
        <div class="stat-foot">${plans > 0 ? `${plural(plans, 'compra a meses activa', 'compras a meses activas')}` : 'Sin compras a meses'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Próximo pago</div>
        ${
          next
            ? `<div class="stat-value">${esc(next.name)}</div>
               <div class="stat-foot ${nextDays !== null && nextDays <= 3 ? 'red' : ''}">${esc(fmtDate(next.next_payment_date))} · ${esc(daysLabel(next.next_payment_date))} · ${money(next.pay_this_month)}</div>`
            : `<div class="stat-value muted">Sin pagos pendientes</div>
               <div class="stat-foot">${totalDebt > 0 ? 'Tu deuda restante está diferida a meses' : 'Ninguna tarjeta tiene deuda'}</div>`
        }
      </div>
    </div>
    <div class="grid grid-2 stat-row-2 v-stats2">
      <div class="stat v-stat-util">
        <div class="stat-label">Utilización global</div>
        <div class="stat-value ${util > 1 ? 'red' : ''}">${pct(util)}</div>
        ${progressBar(util)}
        <div class="stat-foot">${totalLimit > 0 ? (util > 1 ? 'Por encima del límite' : util >= 0.3 ? 'Recomendado: menos del 30%' : 'Dentro del rango recomendado') : 'Define límites para medirla'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Límite total</div>
        <div class="stat-value">${money(totalLimit)}</div>
        <div class="stat-foot">${totalLimit > 0 ? `Disponible ${money(available)}` : 'Sin límites definidos'}</div>
      </div>
    </div>
    <div class="tip v-tip">Los pagos a la tarjeta no cuentan como gasto: el gasto ya se contó en el momento de la compra. Aquí solo reducen la deuda de la tarjeta.</div>`;
}

function cardHtml(c: CreditCard): string {
  const hasDebt = c.balance > 0;
  const available = c.credit_limit > 0 ? Math.max(0, c.credit_limit - c.balance) : null;
  const payDays = daysUntil(c.next_payment_date);
  const payUrgent = hasDebt && c.pay_this_month > 0 && payDays <= 3;
  const glow = `background: linear-gradient(180deg, ${hexToRgba(c.color, 0.14)}, transparent 46%), var(--surface);`;

  return `
    <div class="card v-card" data-id="${c.id}" style="${esc(glow)}">
      <div class="v-card-stripe" style="background:${esc(c.color)}"></div>
      <div class="v-card-head">
        <div class="v-card-name">${esc(c.name)}</div>
        <div class="v-card-chip" aria-hidden="true"></div>
      </div>
      <div>
        <div class="muted small">Deuda</div>
        ${hasDebt ? `<div class="v-card-amount red">${money(c.balance)}</div>` : `<div class="v-card-amount muted">Sin deuda</div>`}
        ${available !== null ? `<div class="small text-2">Disponible <span class="bold white num">${money(available)}</span></div>` : ''}
      </div>
      ${hasDebt ? `<div class="v-card-pay white bold">Paga este mes para no generar intereses: <span class="num">${money(c.pay_this_month)}</span></div>` : ''}
      <div class="v-card-util">
        ${
          c.credit_limit > 0
            ? `${progressBar(c.utilization)}<div class="small ${c.utilization > 1 ? 'red' : 'muted'}">${pct(c.utilization)} del límite${c.utilization > 1 ? ' · excedido' : ''}</div>`
            : `<div class="small muted">Sin límite definido</div>`
        }
      </div>
      <dl class="kv">
        <dt>Corte</dt>
        <dd>${esc(fmtDate(c.next_cutoff_date))} <span class="muted v-days">· ${esc(daysLabel(c.next_cutoff_date))}</span></dd>
        <dt>Pago límite</dt>
        <dd class="${payUrgent ? 'red' : ''}">${esc(fmtDate(c.next_payment_date))} <span class="${payUrgent ? 'red' : 'muted'} v-days">· ${esc(daysLabel(c.next_payment_date))}</span></dd>
        ${
          c.active_plans > 0
            ? `<dt>Mensualidades este mes</dt>
               <dd class="num">${money(c.installments_due_this_month)} <span class="muted v-days">· ${plural(c.active_plans, 'compra', 'compras')}</span></dd>`
            : ''
        }
        ${c.deferred_remaining > 0 ? `<dt>Diferido pendiente</dt><dd class="num">${money(c.deferred_remaining)}</dd>` : ''}
        <dt>Compras este mes</dt>
        <dd class="num">${money(c.charged_this_month)}</dd>
        <dt>Pagado este mes</dt>
        <dd class="num">${money(c.paid_this_month)}</dd>
        <dt>Último pago</dt>
        <dd>${c.last_payment_date ? esc(fmtDate(c.last_payment_date)) : '<span class="muted">—</span>'}</dd>
      </dl>
      <div class="row v-card-actions">
        <button type="button" class="btn primary sm" data-action="pay">Registrar pago</button>
        <button type="button" class="btn sm" data-action="moves">Movimientos</button>
        <button type="button" class="btn ghost sm" data-action="edit">Editar</button>
        <button type="button" class="btn danger sm icon" data-action="delete" aria-label="Eliminar tarjeta" title="Eliminar">🗑</button>
      </div>
    </div>`;
}

function listHtml(list: CreditCard[]): string {
  if (list.length === 0) {
    return emptyState(
      '💳',
      'Aún no tienes tarjetas',
      'Registra tus tarjetas de crédito para seguir su deuda, fechas de corte y de pago.',
      '<button type="button" class="btn primary" data-action="new">Agregar tarjeta</button>',
    );
  }
  return `${statsHtml(list)}<div class="grid grid-auto v-grid">${list.map(cardHtml).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Compras a meses
// ---------------------------------------------------------------------------
const INST_TIP =
  'Las compras a meses cuentan como gasto completo el día que compraste. Aquí ves lo que te toca pagar cada mes. La primera mensualidad se paga el mes siguiente a la compra. Para registrar una compra a meses, en Movimientos elige la tarjeta como forma de pago y el número de meses.';

function progressCell(p: InstallmentPlan): string {
  if (p.status === 'pendiente') {
    return `<div class="v-inst-progress"><span class="small text-2">Empieza en ${esc(ymLong(p.first_month))}</span>${progressBar(0)}</div>`;
  }
  if (p.status === 'terminada') {
    return `<div class="v-inst-progress"><span><span class="badge white">Terminada</span></span><span class="small muted">${p.installments} de ${p.installments}</span></div>`;
  }
  return `<div class="v-inst-progress"><span class="small bold">${p.current_number} de ${p.installments}</span>${progressBar(p.current_number / p.installments, { white: true })}</div>`;
}

function installmentsBodyHtml(d: InstallmentsResponse): string {
  const isCurrent = d.year === currentYear() && d.month === currentMonth();
  const periodLabel = `${monthName(d.month).toLowerCase()} ${d.year}`;
  const dueLabel = isCurrent ? 'Toca pagar este mes' : `Toca pagar en ${periodLabel}`;
  const colLabel = isCurrent ? 'Este mes' : `En ${MONTHS_SHORT[d.month - 1] ?? ''}`;
  const tip = `<div class="tip v-inst-tip">${esc(INST_TIP)}</div>`;

  if (d.items.length === 0) {
    return `${emptyState('🗓️', 'Sin compras a meses', 'Cuando registres una compra con tarjeta a meses, aquí verás qué mensualidad te toca y cuánto pagar cada mes.')}${tip}`;
  }

  const cardsCount = d.by_card.length;
  const stats = `
    <div class="grid grid-3 v-inst-stats">
      <div class="stat">
        <div class="stat-label">${esc(dueLabel)}</div>
        <div class="stat-value red">${money(d.totals.due_this_month)}</div>
        <div class="stat-foot">Suma de mensualidades de ${esc(periodLabel)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Diferido pendiente</div>
        <div class="stat-value">${money(d.totals.deferred_remaining)}</div>
        <div class="stat-foot">Mensualidades de meses posteriores</div>
      </div>
      <div class="stat">
        <div class="stat-label">Compras activas</div>
        <div class="stat-value">${d.totals.active_plans}</div>
        <div class="stat-foot">${cardsCount > 0 ? `En ${plural(cardsCount, 'tarjeta', 'tarjetas')}` : 'Ninguna con mensualidades pendientes'}</div>
      </div>
    </div>`;

  const chart = `
    <div class="v-inst-chart">
      <h3>Mensualidades próximos 12 meses</h3>
      <div class="chart-box sm"><canvas data-inst-chart role="img" aria-label="Total de mensualidades por mes durante los próximos 12 meses"></canvas></div>
    </div>`;

  const rows = d.items
    .map((p) => {
      const done = p.status === 'terminada';
      return `<tr class="${done ? 'v-done' : ''}">
        <td>
          <div class="v-inst-buy">
            <span class="ico" aria-hidden="true">${esc(p.category_icon || '🛍️')}</span>
            <div>
              <div class="name">${esc(p.description)}</div>
              <div class="meta muted small">${esc(p.card_name)} · ${esc(fmtDate(p.purchase_date))}</div>
            </div>
          </div>
        </td>
        <td class="amount">${money(p.total)}</td>
        <td class="amount">${money(p.monthly_amount)}<div class="muted small">${p.installments} meses</div></td>
        <td>${progressCell(p)}</td>
        <td class="amount ${p.due_this_month > 0 ? 'expense' : 'muted'}">${money(p.due_this_month)}</td>
        <td class="amount">${money(p.remaining_amount)}</td>
        <td class="nowrap">${esc(ymShort(p.last_month))}</td>
      </tr>`;
    })
    .join('');

  const table = `
    <div class="table-wrap v-inst-table">
      <table>
        <thead><tr><th>Compra</th><th class="amount">Total</th><th class="amount">Mensualidad</th><th>Avance</th><th class="amount">${esc(colLabel)}</th><th class="amount">Restante</th><th>Termina</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  return `${stats}${chart}${table}${tip}`;
}

function installmentsSectionHtml(): string {
  return `
    <div class="card-head">
      <h2>🗓️ Compras a meses</h2>
      <div data-inst-period></div>
    </div>
    <div data-inst-body>${loadingState('Cargando compras a meses…')}</div>`;
}

async function loadInstallments(): Promise<void> {
  const el = wrap;
  const section = el?.querySelector<HTMLElement>('[data-inst]');
  const body = section?.querySelector<HTMLElement>('[data-inst-body]');
  if (!el || !section || !body) return;
  const my = ++instSeq;
  try {
    const res = await api.get<InstallmentsResponse>(`/api/cards/installments${qs({ year: instPeriod.year, month: instPeriod.month })}`);
    if (my !== instSeq || wrap !== el || !body.isConnected) return;
    destroyChart(instCanvas);
    instCanvas = null;
    body.innerHTML = installmentsBodyHtml(res);
    const canvas = body.querySelector<HTMLCanvasElement>('[data-inst-chart]');
    if (canvas) {
      instCanvas = canvas;
      monthlyBars(canvas, [{ label: 'Mensualidades', data: res.schedule.map((s) => s.amount), color: COLORS.installments }], {
        labels: res.schedule.map((s) => ymShort(s.month)),
      });
    }
  } catch (err) {
    if (my !== instSeq || wrap !== el || !body.isConnected) return;
    destroyChart(instCanvas);
    instCanvas = null;
    showError(err);
    body.innerHTML = `<p class="error-text">No se pudieron cargar las compras a meses.</p><p class="muted small">${esc(err instanceof Error ? err.message : String(err))}</p><div class="mt"><button type="button" class="btn sm" data-action="reload-inst">Reintentar</button></div>`;
  }
}

// ---------------------------------------------------------------------------
// Carga y render
// ---------------------------------------------------------------------------
async function load(): Promise<void> {
  const el = wrap;
  const listEl = el?.querySelector<HTMLElement>('[data-list]');
  const section = el?.querySelector<HTMLElement>('[data-inst]');
  if (!el || !el.isConnected || !listEl || !section) return;
  const my = ++loadSeq;
  try {
    const list = await api.get<CreditCard[]>('/api/cards');
    if (my !== loadSeq || wrap !== el || !el.isConnected) return;
    cards = list;
    listEl.innerHTML = listHtml(cards);
    // Sin tarjetas no puede haber compras a meses: se oculta la sección.
    section.classList.toggle('hidden', cards.length === 0);
    if (cards.length > 0) await loadInstallments();
  } catch (err) {
    if (my !== loadSeq || wrap !== el || !el.isConnected) return;
    showError(err);
    section.classList.add('hidden');
    listEl.innerHTML = `<div class="card"><p class="error-text">No se pudieron cargar las tarjetas.</p><p class="muted small">${esc(err instanceof Error ? err.message : String(err))}</p><div class="mt"><button type="button" class="btn" data-action="reload">Reintentar</button></div></div>`;
  }
}

export async function render(root: HTMLElement): Promise<void> {
  const el = document.createElement('div');
  el.className = 'v-cards';
  el.innerHTML = `${STYLE}<div data-list>${loadingState('Cargando tarjetas…')}</div><section class="card v-inst hidden" data-inst>${installmentsSectionHtml()}</section>`;
  root.replaceChildren(el);
  wrap = el;
  instCanvas = null;
  instPeriod.year = currentYear();
  instPeriod.month = currentMonth();

  const actions = document.getElementById('topbar-actions');
  if (actions) {
    actions.innerHTML = '<button type="button" class="btn primary" id="v-cards-new">+ Nueva tarjeta</button>';
    actions.querySelector('#v-cards-new')?.addEventListener('click', () => openCardForm());
  }

  const periodEl = el.querySelector<HTMLElement>('[data-inst-period]');
  if (periodEl) {
    periodPicker(periodEl, instPeriod, (year, month) => {
      instPeriod.year = year;
      instPeriod.month = month;
      void loadInstallments();
    });
  }

  on(el, 'click', '[data-action]', (btn) => {
    const action = btn.dataset.action;
    if (action === 'new') {
      openCardForm();
      return;
    }
    if (action === 'reload') {
      void load();
      return;
    }
    if (action === 'reload-inst') {
      void loadInstallments();
      return;
    }
    const id = Number(btn.closest<HTMLElement>('[data-id]')?.dataset.id);
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    if (action === 'pay') openPaymentForm(card);
    else if (action === 'moves') openMovements(card);
    else if (action === 'edit') openCardForm(card);
    else if (action === 'delete') void deleteCard(card);
  });

  await load();
}

export function destroy(): void {
  loadSeq += 1;
  instSeq += 1;
  destroyChart(instCanvas);
  instCanvas = null;
  wrap = null;
  cards = [];
  destroyDetachedCharts();
}

// ---------------------------------------------------------------------------
// Crear / editar tarjeta
// ---------------------------------------------------------------------------
function openCardForm(card?: CreditCard): void {
  formModal({
    title: card ? 'Editar tarjeta' : 'Nueva tarjeta',
    submitLabel: card ? 'Guardar cambios' : 'Crear tarjeta',
    html: `
      <form class="form">
        ${field('Nombre', input('name', { value: card?.name ?? '', placeholder: 'p. ej. Banco Azul', required: true }))}
        ${field('Límite de crédito', moneyInput('credit_limit', card ? card.credit_limit : 0), 'Escribe 0 si no quieres definir un límite')}
        <div class="form-row">
          ${field('Día de corte', input('cutoff_day', { type: 'number', min: 1, max: 31, step: '1', value: card?.cutoff_day ?? 1, required: true }), 'Día del mes (1-31)')}
          ${field('Día límite de pago', input('payment_day', { type: 'number', min: 1, max: 31, step: '1', value: card?.payment_day ?? 20, required: true }), 'Día del mes (1-31)')}
        </div>
        ${field('Color', `<div class="row">${input('color', { type: 'color', value: card?.color ?? DEFAULT_COLOR })}<span class="muted small">Identifica la tarjeta en la lista</span></div>`)}
      </form>`,
    onSubmit: async (v, _form, modal) => {
      const body: CreditCardInput = {
        name: v.name.trim(),
        credit_limit: toNumber(v.credit_limit, 'límite de crédito'),
        cutoff_day: toNumber(v.cutoff_day, 'día de corte'),
        payment_day: toNumber(v.payment_day, 'día límite de pago'),
        color: /^#[0-9a-fA-F]{6}$/.test(v.color ?? '') ? v.color : DEFAULT_COLOR,
      };
      if (card) await api.put<CreditCard>(`/api/cards/${card.id}`, body);
      else await api.post<CreditCard>('/api/cards', body);
      modal.close();
      toast(card ? 'Tarjeta actualizada' : 'Tarjeta creada');
      await load();
    },
  });
}

// ---------------------------------------------------------------------------
// Eliminar tarjeta
// ---------------------------------------------------------------------------
async function deleteCard(card: CreditCard): Promise<void> {
  const ok = await confirmDialog(
    `¿Eliminar la tarjeta "${card.name}"? Se eliminarán también sus pagos registrados. Las compras hechas con ella se conservarán sin tarjeta.`,
    { title: 'Eliminar tarjeta', okLabel: 'Eliminar' },
  );
  if (!ok) return;
  try {
    await api.del(`/api/cards/${card.id}`);
    toast('Tarjeta eliminada');
    await load();
  } catch (err) {
    showError(err);
  }
}

// ---------------------------------------------------------------------------
// Registrar pago
// ---------------------------------------------------------------------------
function readLastAccount(): string {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveLastAccount(value: string): void {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, value);
  } catch {
    /* almacenamiento no disponible */
  }
}

function accountLabel(a: Account): string {
  return a.bank ? `${a.name} · ${a.bank}` : a.name;
}

/** Opciones del select de cuenta: "Sin especificar" + cuentas activas; preselecciona la última usada si sigue activa. */
function accountOptionsHtml(accounts: Account[], selected: string): string {
  const active = accounts.filter((a) => !a.archived);
  const has = active.some((a) => String(a.id) === selected);
  const opt = (value: string, label: string, isSel: boolean): string => `<option value="${esc(value)}"${isSel ? ' selected' : ''}>${esc(label)}</option>`;
  return [opt('', 'Sin especificar', !has), ...active.map((a) => opt(String(a.id), accountLabel(a), String(a.id) === selected))].join('');
}

function openPaymentForm(card: CreditCard): void {
  const hasDebt = card.balance > 0;
  const help = hasDebt ? `Para no generar intereses: ${money(card.pay_this_month)} · Deuda total: ${money(card.balance)}` : 'Esta tarjeta no tiene deuda registrada';
  formModal({
    title: `Registrar pago · ${card.name}`,
    submitLabel: 'Registrar pago',
    html: `
      <form class="form">
        ${field('Monto', moneyInput('amount', card.pay_this_month > 0 ? card.pay_this_month : null), help)}
        ${field('Fecha', input('date', { type: 'date', value: todayISO(), required: true }))}
        ${field('¿Con qué cuenta pagaste?', select('account_id', [{ value: '', label: 'Sin especificar', selected: true }]), 'El pago se descuenta del saldo de esa cuenta en Mi dinero')}
        ${field('Nota', input('note', { placeholder: 'Opcional, p. ej. pago para no generar intereses' }))}
      </form>`,
    onOpen: (form) => {
      const sel = form.querySelector<HTMLSelectElement>('select[name="account_id"]');
      if (!sel) return;
      sel.disabled = true;
      void api
        .get<Account[]>('/api/accounts/list')
        .then((accounts) => {
          if (!sel.isConnected) return;
          sel.innerHTML = accountOptionsHtml(accounts, readLastAccount());
        })
        .catch(() => {
          /* sin cuentas: queda "Sin especificar" */
        })
        .finally(() => {
          sel.disabled = false;
        });
    },
    onSubmit: async (v, _form, modal) => {
      const rawAccount = v.account_id ?? '';
      const body: CardPaymentInput = {
        amount: toNumber(v.amount, 'monto'),
        date: v.date,
        note: (v.note ?? '').trim(),
        account_id: rawAccount ? Number(rawAccount) : null,
      };
      await api.post<CardPayment>(`/api/cards/${card.id}/payments`, body);
      saveLastAccount(rawAccount);
      modal.close();
      toast('Pago registrado');
      await load();
    },
  });
}

// ---------------------------------------------------------------------------
// Movimientos: pagos y compras
// ---------------------------------------------------------------------------
function paymentsTableHtml(items: CardPayment[]): string {
  if (items.length === 0) return emptyState('💸', 'Sin pagos registrados', 'Usa "Registrar pago" en la tarjeta para abonar a su deuda.');
  const total = items.reduce((a, p) => a + p.amount, 0);
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Fecha</th><th>Cuenta</th><th>Nota</th><th class="amount">Monto</th><th></th></tr></thead>
        <tbody>
          ${items
            .map(
              (p) => `<tr data-payment-id="${p.id}">
                <td class="nowrap">${esc(fmtDate(p.date))}</td>
                <td>${p.account_name ? esc(p.account_name) : '<span class="muted">—</span>'}</td>
                <td class="v-note">${p.note ? esc(p.note) : '<span class="muted">—</span>'}</td>
                <td class="amount income">${money(p.amount)}</td>
                <td class="actions"><button type="button" class="btn ghost sm icon" data-del-payment="${p.id}" aria-label="Eliminar pago" title="Eliminar pago">🗑</button></td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="row between v-panel-foot small muted"><span>${items.length} pago${items.length === 1 ? '' : 's'}</span><span class="num">Total pagado ${money(total)}</span></div>`;
}

function chargesTableHtml(items: Transaction[]): string {
  const tip = '<div class="tip v-panel-foot">Las compras se registran en Movimientos eligiendo esta tarjeta como forma de pago (y, si aplica, el número de meses).</div>';
  if (items.length === 0) return `${emptyState('🛍️', 'Sin compras con esta tarjeta')}${tip}`;
  const total = items.reduce((a, t) => a + t.amount, 0);
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Fecha</th><th>Descripción</th><th class="amount">Monto</th></tr></thead>
        <tbody>
          ${items
            .map((t) => {
              const cat = t.category_name ? `${t.category_icon ? `${esc(t.category_icon)} ` : ''}${esc(t.category_name)}` : '';
              const main = t.description ? esc(t.description) : cat || '<span class="muted">Sin descripción</span>';
              const sub = t.description && cat ? `<div class="muted small">${cat}</div>` : '';
              const msi = t.installments > 1 ? `<span class="chip v-msi">${t.installments} MSI</span>` : '';
              return `<tr>
                <td class="nowrap">${esc(fmtDate(t.date))}</td>
                <td><div class="v-desc-row"><div class="v-desc" title="${esc(t.description)}">${main}</div>${msi}</div>${sub}</td>
                <td class="amount expense">${money(t.amount)}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="row between v-panel-foot small muted"><span>Últimas ${items.length} compra${items.length === 1 ? '' : 's'}</span><span class="num">Total ${money(total)}</span></div>
    ${tip}`;
}

function openMovements(card: CreditCard): void {
  let changed = false;
  const modal = openModal({
    title: `Movimientos · ${card.name}`,
    wide: true,
    html: `
      <div class="v-cards-modal">
        <div class="tabs" role="tablist">
          <button type="button" class="active" data-tab="payments" role="tab">Pagos</button>
          <button type="button" data-tab="charges" role="tab">Compras</button>
        </div>
        <div data-panel="payments">${loadingState()}</div>
        <div data-panel="charges" class="hidden">${loadingState()}</div>
      </div>`,
    onClose: () => {
      if (changed) void load();
    },
  });
  const body = modal.body;
  const panel = (name: string): HTMLElement => body.querySelector<HTMLElement>(`[data-panel="${name}"]`)!;

  const loadPayments = async (): Promise<void> => {
    try {
      const items = await api.get<CardPayment[]>(`/api/cards/${card.id}/payments`);
      if (!body.isConnected) return;
      panel('payments').innerHTML = paymentsTableHtml(items);
    } catch (err) {
      if (!body.isConnected) return;
      panel('payments').innerHTML = `<p class="error-text">No se pudieron cargar los pagos.</p>`;
      showError(err);
    }
  };
  const loadCharges = async (): Promise<void> => {
    try {
      const items = await api.get<Transaction[]>(`/api/cards/${card.id}/charges${qs({ limit: CHARGES_LIMIT })}`);
      if (!body.isConnected) return;
      panel('charges').innerHTML = chargesTableHtml(items);
    } catch (err) {
      if (!body.isConnected) return;
      panel('charges').innerHTML = `<p class="error-text">No se pudieron cargar las compras.</p>`;
      showError(err);
    }
  };

  on(body, 'click', '[data-tab]', (btn) => {
    const tab = btn.dataset.tab!;
    body.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    body.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  });

  on(body, 'click', '[data-del-payment]', async (btn) => {
    const paymentId = Number(btn.dataset.delPayment);
    const row = btn.closest('tr');
    const amountText = row?.querySelector('.amount')?.textContent?.trim() ?? '';
    const ok = await confirmDialog(`¿Eliminar este pago${amountText ? ` de ${amountText}` : ''}? La deuda de la tarjeta volverá a aumentar.`, { title: 'Eliminar pago' });
    if (!ok) return;
    try {
      await api.del(`/api/cards/${card.id}/payments/${paymentId}`);
      changed = true;
      toast('Pago eliminado');
      await Promise.all([loadPayments(), load()]);
    } catch (err) {
      showError(err);
    }
  });

  void Promise.all([loadPayments(), loadCharges()]);
}
