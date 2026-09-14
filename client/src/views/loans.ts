/**
 * Vista "Préstamos": resumen de deudas, pagos por mes, tarjeta por préstamo,
 * historial de pagos y tabla de amortización teórica.
 */
import type { Loan, LoanInput, LoanPayment, LoanScheduleRow } from '../../../shared/types';
import { api, ApiError } from '../api';
import { esc, money, num, pct, fmtDate, todayISO, currentYear } from '../format';
import {
  formModal,
  openModal,
  confirmDialog,
  toast,
  showError,
  field,
  input,
  moneyInput,
  emptyState,
  loadingState,
  progressBar,
  toNumber,
  on,
} from '../ui';
import { monthlyBars, destroyChart, COLORS } from '../charts';

const TIP = 'Los pagos a préstamos cuentan como salida de dinero en tu resumen mensual, separados de los gastos. El restante incluye los intereses mensuales generados hasta hoy.';

const STYLE = `<style>
  .v-loans .grid > .card { margin-top: 0; }
  .v-loans .v-loan-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .v-loans .v-loan-head h3 { overflow-wrap: anywhere; }
  .v-loans .v-loan-big { font-size: 1.65rem; font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .v-loans .v-loan-progress { margin-top: 12px; }
  .v-loans .v-loan-progress p { margin-top: 6px; }
  .v-loans .v-loan-kv { margin: 14px 0 0; }
  .v-loans .v-loan-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .v-loans-modal .v-loan-summary { margin-bottom: 14px; }
</style>`;

let view: HTMLElement | null = null;
let chartCanvas: HTMLCanvasElement | null = null;
let loans: Loan[] = [];

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
export async function render(root: HTMLElement): Promise<void> {
  const wrap = document.createElement('div');
  wrap.className = 'v-loans';
  wrap.innerHTML = STYLE + loadingState();
  root.innerHTML = '';
  root.appendChild(wrap);
  view = wrap;

  const actions = document.getElementById('topbar-actions');
  if (actions) {
    actions.innerHTML = '<button type="button" class="btn primary" data-action="new">+ Nuevo préstamo</button>';
    actions.querySelector('[data-action="new"]')?.addEventListener('click', () => openLoanForm());
  }

  on(wrap, 'click', '[data-action]', (el) => {
    void handleAction(el.dataset.action ?? '', Number(el.dataset.id));
  });

  await load();
}

export function destroy(): void {
  destroyChart(chartCanvas);
  chartCanvas = null;
  view = null;
  loans = [];
}

// ---------------------------------------------------------------------------
// Carga y pintado
// ---------------------------------------------------------------------------
async function load(): Promise<void> {
  const el = view;
  if (!el) return;
  destroyChart(chartCanvas);
  chartCanvas = null;
  el.innerHTML = STYLE + loadingState();
  try {
    const items = await api.get<Loan[]>('/api/loans');
    const lists = await Promise.all(items.map((l) => api.get<LoanPayment[]>(`/api/loans/${l.id}/payments`)));
    if (view !== el) return; // la vista cambió mientras cargaba
    loans = items;
    paint(el, items, lists.flat());
  } catch (err) {
    if (view !== el) return;
    showError(err);
    el.innerHTML =
      STYLE +
      `<div class="card">
        <p class="error-text">No se pudieron cargar los préstamos.</p>
        <p class="muted small">${esc(err instanceof Error ? err.message : '')}</p>
        <div class="mt"><button type="button" class="btn sm" data-action="reload">Reintentar</button></div>
      </div>`;
  }
}

function paint(el: HTMLElement, items: Loan[], payments: LoanPayment[]): void {
  if (items.length === 0) {
    el.innerHTML =
      STYLE +
      emptyState(
        '🏦',
        'Aún no tienes préstamos',
        'Registra un préstamo para dar seguimiento a tus pagos y a lo que falta por liquidar.',
        '<button type="button" class="btn primary" data-action="new">Agregar préstamo</button>',
      ) +
      `<div class="tip mt">${esc(TIP)}</div>`;
    return;
  }

  const totals = items.reduce(
    (acc, l) => {
      acc.remaining += l.remaining;
      acc.monthly += l.monthly_payment;
      acc.paid += l.paid_total;
      acc.interest += l.total_interest_estimate;
      acc.payments += l.payments_count;
      if (l.remaining > 0) acc.active += 1;
      return acc;
    },
    { remaining: 0, monthly: 0, paid: 0, interest: 0, payments: 0, active: 0 },
  );

  const year = currentYear();
  const byMonth: number[] = Array.from({ length: 12 }, () => 0);
  for (const p of payments) {
    if (!p.date.startsWith(`${year}-`)) continue;
    const m = Number(p.date.slice(5, 7));
    if (m >= 1 && m <= 12) byMonth[m - 1] += p.amount;
  }
  const hasPayments = byMonth.some((v) => v > 0);
  const yearTotal = byMonth.reduce((a, b) => a + b, 0);

  el.innerHTML =
    STYLE +
    `<div class="grid grid-4 stat-row-2">
      <div class="stat">
        <div class="stat-label">Deuda restante total</div>
        <div class="stat-value red">${money(totals.remaining)}</div>
        <div class="stat-foot">${totals.active === 1 ? '1 préstamo activo' : `${totals.active} préstamos activos`} de ${items.length}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Compromiso mensual</div>
        <div class="stat-value">${money(totals.monthly)}</div>
        <div class="stat-foot">Suma de los pagos mensuales</div>
      </div>
      <div class="stat">
        <div class="stat-label">Pagado en total</div>
        <div class="stat-value white">${money(totals.paid)}</div>
        <div class="stat-foot">${totals.payments === 1 ? '1 pago registrado' : `${totals.payments} pagos registrados`}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Interés estimado total</div>
        <div class="stat-value">${money(totals.interest)}</div>
        <div class="stat-foot">Según las tablas de amortización</div>
      </div>
    </div>

    <div class="card mt">
      <div class="card-head">
        <h2>Pagos a préstamos por mes <span class="sub">${year}</span></h2>
        ${hasPayments ? `<span class="chip"><span class="dot" style="background:${COLORS.loans}"></span>Total del año ${money(yearTotal)}</span>` : ''}
      </div>
      ${
        hasPayments
          ? '<div class="chart-box"><canvas id="v-loans-chart" role="img" aria-label="Pagos a préstamos por mes"></canvas></div>'
          : emptyState('📉', `Sin pagos en ${year}`, 'Registra un pago para ver la gráfica.')
      }
    </div>

    <div class="grid grid-auto mt">${items.map(loanCard).join('')}</div>

    <div class="tip mt">${esc(TIP)}</div>`;

  if (hasPayments) {
    chartCanvas = el.querySelector<HTMLCanvasElement>('#v-loans-chart');
    if (chartCanvas) {
      monthlyBars(chartCanvas, [{ label: 'Pagos', data: byMonth.map((v) => Math.round(v * 100) / 100), color: COLORS.loans }]);
    }
  }
}

function loanCard(l: Loan): string {
  const done = l.remaining <= 0;
  const pagos = l.payments_count === 1 ? '1 pago' : `${l.payments_count} pagos`;
  return `<div class="card">
    <div class="v-loan-head">
      <div>
        <h3>${esc(l.name)}</h3>
        <div class="muted small">${l.term_months} ${l.term_months === 1 ? 'mes' : 'meses'} · ${num(l.annual_rate)}% anual</div>
      </div>
      ${done ? '<span class="badge white">Liquidado</span>' : ''}
    </div>
    <div class="stat-label">Restante</div>
    <div class="v-loan-big ${done ? 'white' : 'red'}">${money(l.remaining)}</div>
    <div class="v-loan-progress">
      ${progressBar(l.progress, { white: done })}
      <p class="muted small">${pct(l.progress)} del capital pagado · ${pagos}</p>
    </div>
    <dl class="kv v-loan-kv">
      <dt>Monto original</dt><dd class="num">${money(l.principal)}</dd>
      <dt>Tasa anual</dt><dd class="num">${num(l.annual_rate)}%</dd>
      <dt>Intereses generados</dt><dd class="num">${l.interest_paid > 0 ? money(l.interest_paid) : '<span class="muted">—</span>'}</dd>
      <dt>Pago mensual</dt><dd class="num">${l.monthly_payment > 0 ? money(l.monthly_payment) : '<span class="muted">—</span>'}</dd>
      <dt>Inicio</dt><dd>${fmtDate(l.start_date)}</dd>
      <dt>Fin estimado</dt><dd>${fmtDate(l.end_date)}</dd>
      <dt>Meses restantes</dt><dd class="num">${l.estimated_months_left === null ? '<span class="muted">—</span>' : String(l.estimated_months_left)}</dd>
      <dt>Último pago</dt><dd>${l.last_payment_date ? fmtDate(l.last_payment_date) : '<span class="muted">—</span>'}</dd>
    </dl>
    <div class="v-loan-actions">
      <button type="button" class="btn primary sm" data-action="pay" data-id="${l.id}">Registrar pago</button>
      <button type="button" class="btn sm" data-action="history" data-id="${l.id}">Historial</button>
      <button type="button" class="btn sm" data-action="schedule" data-id="${l.id}">Amortización</button>
      <button type="button" class="btn ghost sm" data-action="edit" data-id="${l.id}">Editar</button>
      <button type="button" class="btn danger sm icon" data-action="delete" data-id="${l.id}" aria-label="Eliminar préstamo" title="Eliminar">🗑</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------
async function handleAction(action: string, id: number): Promise<void> {
  if (action === 'new') {
    openLoanForm();
    return;
  }
  if (action === 'reload') {
    await load();
    return;
  }
  const loan = loans.find((l) => l.id === id);
  if (!loan) return;
  switch (action) {
    case 'pay':
      openPaymentForm(loan);
      break;
    case 'history':
      await openHistory(loan);
      break;
    case 'schedule':
      await openSchedule(loan);
      break;
    case 'edit':
      openLoanForm(loan);
      break;
    case 'delete':
      await deleteLoan(loan);
      break;
  }
}

function openLoanForm(loan?: Loan): void {
  const isEdit = loan !== undefined;
  formModal({
    title: isEdit ? 'Editar préstamo' : 'Nuevo préstamo',
    submitLabel: isEdit ? 'Guardar cambios' : 'Crear préstamo',
    html: `<form class="form">
      ${field('Nombre', input('name', { value: loan?.name ?? '', placeholder: 'Ej. Crédito automotriz', required: true }))}
      <div class="form-row">
        ${field('Monto del préstamo', moneyInput('principal', loan?.principal ?? null))}
        ${field('Tasa anual (%)', input('annual_rate', { type: 'number', step: '0.01', min: 0, max: 500, value: loan?.annual_rate ?? 0, required: true }))}
      </div>
      <div class="form-row">
        ${field(
          'Pago mensual',
          input('monthly_payment', { type: 'number', step: '0.01', min: 0, value: loan?.monthly_payment ?? 0, placeholder: '0.00' }),
          'Si lo dejas en 0 se calcula con la tasa y el plazo',
        )}
        ${field('Plazo en meses', input('term_months', { type: 'number', step: '1', min: 1, max: 600, value: loan?.term_months ?? 12, required: true }))}
      </div>
      ${field(
        'Fecha de inicio',
        input('start_date', { type: 'date', value: loan?.start_date ?? todayISO(), required: true }),
        'Si ya llevas tiempo pagándolo, usa el saldo actual como monto y hoy como fecha de inicio, o registra tus pagos anteriores.',
      )}
    </form>`,
    onSubmit: async (v, _form, modal) => {
      const body: LoanInput = {
        name: (v.name ?? '').trim(),
        principal: toNumber(v.principal ?? '', 'monto'),
        annual_rate: toNumber(v.annual_rate || '0', 'tasa anual'),
        monthly_payment: toNumber(v.monthly_payment || '0', 'pago mensual'),
        start_date: v.start_date ?? '',
        term_months: Math.round(toNumber(v.term_months ?? '', 'plazo')),
      };
      if (isEdit) await api.put<Loan>(`/api/loans/${loan.id}`, body);
      else await api.post<Loan>('/api/loans', body);
      modal.close();
      toast(isEdit ? 'Préstamo actualizado' : 'Préstamo creado');
      await load();
    },
  });
}

function openPaymentForm(loan: Loan): void {
  let suggested: number | null;
  if (loan.remaining > 0) suggested = loan.monthly_payment > 0 ? Math.min(loan.monthly_payment, loan.remaining) : loan.remaining;
  else suggested = loan.monthly_payment > 0 ? loan.monthly_payment : null;
  if (suggested !== null) suggested = Math.round(suggested * 100) / 100;

  formModal({
    title: `Registrar pago · ${loan.name}`,
    submitLabel: 'Registrar pago',
    html: `<form class="form">
      ${
        loan.remaining > 0
          ? `<p class="text-2 small">Restante por pagar: <strong class="red num">${money(loan.remaining)}</strong></p>`
          : '<p class="text-2 small">Este préstamo ya está liquidado; el pago se registrará como adicional.</p>'
      }
      <div class="form-row">
        ${field('Monto', moneyInput('amount', suggested))}
        ${field('Fecha', input('date', { type: 'date', value: todayISO(), required: true }))}
      </div>
      ${field('Nota (opcional)', input('note', { placeholder: 'Ej. Mensualidad de septiembre' }))}
    </form>`,
    onSubmit: async (v, _form, modal) => {
      await api.post<LoanPayment>(`/api/loans/${loan.id}/payments`, {
        amount: toNumber(v.amount ?? '', 'monto'),
        date: v.date ?? '',
        note: (v.note ?? '').trim(),
      });
      modal.close();
      toast('Pago registrado');
      await load();
    },
  });
}

async function openHistory(loan: Loan): Promise<void> {
  const modal = openModal({ title: `Historial de pagos · ${loan.name}`, html: `<div class="v-loans-modal">${loadingState()}</div>`, wide: true });
  const box = modal.body.querySelector<HTMLElement>('.v-loans-modal') ?? modal.body;

  const paintHistory = async (): Promise<void> => {
    try {
      const payments = await api.get<LoanPayment[]>(`/api/loans/${loan.id}/payments`);
      if (payments.length === 0) {
        box.innerHTML = emptyState('🧾', 'Sin pagos registrados', 'Usa "Registrar pago" en la tarjeta del préstamo para agregar el primero.');
        return;
      }
      const total = payments.reduce((a, p) => a + p.amount, 0);
      box.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Nota</th><th class="amount">Monto</th><th></th></tr></thead>
        <tbody>${payments
          .map(
            (p) => `<tr>
              <td class="nowrap">${fmtDate(p.date)}</td>
              <td>${p.note ? esc(p.note) : '<span class="muted">—</span>'}</td>
              <td class="amount num">${money(p.amount)}</td>
              <td class="actions"><button type="button" class="btn ghost sm icon" data-del="${p.id}" aria-label="Eliminar pago" title="Eliminar pago">✕</button></td>
            </tr>`,
          )
          .join('')}</tbody>
        <tfoot><tr>
          <td colspan="2" class="muted small">${payments.length === 1 ? '1 pago' : `${payments.length} pagos`}</td>
          <td class="amount num white">${money(total)}</td>
          <td></td>
        </tr></tfoot>
      </table></div>`;
    } catch (err) {
      showError(err);
      box.innerHTML = '<p class="error-text">No se pudo cargar el historial.</p>';
    }
  };

  on(box, 'click', '[data-del]', (el) => {
    void (async () => {
      const ok = await confirmDialog('Se eliminará este pago del historial del préstamo.', { title: 'Eliminar pago' });
      if (!ok) return;
      try {
        await api.del(`/api/loans/${loan.id}/payments/${Number(el.dataset.del)}`);
        toast('Pago eliminado');
        await paintHistory();
        void load();
      } catch (err) {
        showError(err);
      }
    })();
  });

  await paintHistory();
}

async function openSchedule(loan: Loan): Promise<void> {
  const modal = openModal({ title: `Tabla de amortización · ${loan.name}`, html: `<div class="v-loans-modal">${loadingState()}</div>`, wide: true });
  const box = modal.body.querySelector<HTMLElement>('.v-loans-modal') ?? modal.body;
  try {
    const rows = await api.get<LoanScheduleRow[]>(`/api/loans/${loan.id}/schedule`);
    const interest = rows.reduce((a, r) => a + r.interest, 0);
    const total = rows.reduce((a, r) => a + r.payment, 0);
    const theoretical = loan.monthly_payment > 0 ? loan.monthly_payment : (rows[0]?.payment ?? 0);
    box.innerHTML = `
      <dl class="kv v-loan-summary">
        <dt>Pago mensual teórico</dt><dd class="num">${money(theoretical)}</dd>
        <dt>Interés total</dt><dd class="num red">${money(interest)}</dd>
        <dt>Total a pagar</dt><dd class="num">${money(total)}</dd>
      </dl>
      <p class="muted small" style="margin-bottom:12px">Sistema francés sobre el monto original (${money(loan.principal)} a ${num(loan.annual_rate)}% anual, ${rows.length} ${rows.length === 1 ? 'periodo' : 'periodos'}). No descuenta los pagos ya registrados.</p>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Periodo</th><th>Fecha</th><th class="amount">Pago</th><th class="amount">Interés</th><th class="amount">Capital</th><th class="amount">Saldo</th>
        </tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
              <td class="num">${r.period}</td>
              <td class="nowrap">${fmtDate(r.date)}</td>
              <td class="amount num">${money(r.payment)}</td>
              <td class="amount num red">${money(r.interest)}</td>
              <td class="amount num">${money(r.principal)}</td>
              <td class="amount num">${money(r.balance)}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>`;
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      box.innerHTML = `<div class="tip">${esc(err.message)}</div>`;
    } else {
      showError(err);
      box.innerHTML = '<p class="error-text">No se pudo calcular la tabla de amortización.</p>';
    }
  }
}

async function deleteLoan(loan: Loan): Promise<void> {
  const ok = await confirmDialog('Se eliminará el préstamo y todos sus pagos registrados.', { title: `Eliminar "${loan.name}"` });
  if (!ok) return;
  try {
    await api.del(`/api/loans/${loan.id}`);
    toast('Préstamo eliminado');
    await load();
  } catch (err) {
    showError(err);
  }
}
