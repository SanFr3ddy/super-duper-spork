/**
 * Vista "Tarjetas": tarjetas de crédito con deuda, utilización, fechas de corte/pago,
 * registro de pagos y consulta de movimientos (pagos y compras).
 */
import type { CreditCard, CreditCardInput, CardPayment, CardPaymentInput, Transaction } from '../../../shared/types';
import { api, qs } from '../api';
import { esc, money, pct, fmtDate, daysUntil, todayISO } from '../format';
import { formModal, openModal, confirmDialog, toast, showError, field, input, moneyInput, emptyState, loadingState, progressBar, on, toNumber } from '../ui';
import { hexToRgba, destroyDetachedCharts } from '../charts';

const DEFAULT_COLOR = '#e5202e';
const CHARGES_LIMIT = 50;

let wrap: HTMLElement | null = null;
let cards: CreditCard[] = [];

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
  .v-cards .v-card-util { display: flex; flex-direction: column; gap: 6px; }
  .v-cards .v-card .kv { margin: 0; }
  .v-cards .v-card .kv dd .muted { font-weight: 400; }
  .v-cards .v-card-actions { margin-top: auto; padding-top: 4px; }
  .v-cards .v-days { font-weight: 400; }
  .v-cards .v-stat-util .progress { margin-top: 4px; }
  .v-cards .v-tip { margin-top: 16px; }
  .v-cards .v-grid { margin-top: 16px; }
  .v-cards-modal .v-desc { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v-cards-modal .v-note { color: var(--text-2); }
  .v-cards-modal .v-panel-foot { margin-top: 12px; }
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

function statsHtml(list: CreditCard[]): string {
  const totalDebt = list.reduce((a, c) => a + c.balance, 0);
  const totalLimit = list.reduce((a, c) => a + c.credit_limit, 0);
  const util = totalLimit > 0 ? totalDebt / totalLimit : 0;
  const available = Math.max(0, totalLimit - totalDebt);
  const next = list
    .filter((c) => c.balance > 0)
    .sort((a, b) => a.next_payment_date.localeCompare(b.next_payment_date) || a.id - b.id)[0];
  const nextDays = next ? daysUntil(next.next_payment_date) : null;

  return `
    <div class="grid grid-4">
      <div class="stat">
        <div class="stat-label">Deuda total</div>
        <div class="stat-value red">${money(totalDebt)}</div>
        <div class="stat-foot">${list.length} tarjeta${list.length === 1 ? '' : 's'} · ${list.filter((c) => c.balance > 0).length} con deuda</div>
      </div>
      <div class="stat">
        <div class="stat-label">Límite total</div>
        <div class="stat-value">${money(totalLimit)}</div>
        <div class="stat-foot">${totalLimit > 0 ? `Disponible ${money(available)}` : 'Sin límites definidos'}</div>
      </div>
      <div class="stat v-stat-util">
        <div class="stat-label">Utilización global</div>
        <div class="stat-value ${util > 1 ? 'red' : ''}">${pct(util)}</div>
        ${progressBar(util)}
        <div class="stat-foot">${totalLimit > 0 ? (util > 1 ? 'Por encima del límite' : util >= 0.3 ? 'Recomendado: menos del 30%' : 'Dentro del rango recomendado') : 'Define límites para medirla'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Próximo pago</div>
        ${
          next
            ? `<div class="stat-value">${esc(next.name)}</div>
               <div class="stat-foot ${nextDays !== null && nextDays <= 3 ? 'red' : ''}">${esc(fmtDate(next.next_payment_date))} · ${esc(daysLabel(next.next_payment_date))} · ${money(next.balance)}</div>`
            : `<div class="stat-value muted">Sin pagos pendientes</div>
               <div class="stat-foot">Ninguna tarjeta tiene deuda</div>`
        }
      </div>
    </div>
    <div class="tip v-tip">Los pagos a la tarjeta no cuentan como gasto: el gasto ya se contó en el momento de la compra. Aquí solo reducen la deuda de la tarjeta.</div>`;
}

function cardHtml(c: CreditCard): string {
  const hasDebt = c.balance > 0;
  const available = c.credit_limit > 0 ? Math.max(0, c.credit_limit - c.balance) : null;
  const payDays = daysUntil(c.next_payment_date);
  const payUrgent = hasDebt && payDays <= 3;
  const glow = `background: linear-gradient(180deg, ${hexToRgba(c.color, 0.14)}, transparent 46%), var(--surface);`;

  return `
    <div class="card v-card" data-id="${c.id}" style="${glow}">
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
// Carga y render
// ---------------------------------------------------------------------------
async function load(): Promise<void> {
  const el = wrap;
  if (!el || !el.isConnected) return;
  try {
    const list = await api.get<CreditCard[]>('/api/cards');
    if (!el.isConnected) return;
    cards = list;
    el.innerHTML = STYLE + listHtml(cards);
  } catch (err) {
    if (!el.isConnected) return;
    showError(err);
    el.innerHTML = `${STYLE}<div class="card"><p class="error-text">No se pudieron cargar las tarjetas.</p><p class="muted small">${esc(err instanceof Error ? err.message : String(err))}</p><div class="mt"><button type="button" class="btn" data-action="reload">Reintentar</button></div></div>`;
  }
}

export async function render(root: HTMLElement): Promise<void> {
  const el = document.createElement('div');
  el.className = 'v-cards';
  el.innerHTML = STYLE + loadingState('Cargando tarjetas…');
  root.replaceChildren(el);
  wrap = el;

  const actions = document.getElementById('topbar-actions');
  if (actions) {
    actions.innerHTML = '<button type="button" class="btn primary" id="v-cards-new">+ Nueva tarjeta</button>';
    actions.querySelector('#v-cards-new')?.addEventListener('click', () => openCardForm());
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
function openPaymentForm(card: CreditCard): void {
  formModal({
    title: `Registrar pago · ${card.name}`,
    submitLabel: 'Registrar pago',
    html: `
      <form class="form">
        ${field('Monto', moneyInput('amount', card.balance > 0 ? card.balance : null), card.balance > 0 ? `Deuda actual: ${money(card.balance)}` : 'Esta tarjeta no tiene deuda registrada')}
        ${field('Fecha', input('date', { type: 'date', value: todayISO(), required: true }))}
        ${field('Nota', input('note', { placeholder: 'Opcional, p. ej. pago para no generar intereses' }))}
      </form>`,
    onSubmit: async (v, _form, modal) => {
      const body: CardPaymentInput = { amount: toNumber(v.amount, 'monto'), date: v.date, note: (v.note ?? '').trim() };
      await api.post<CardPayment>(`/api/cards/${card.id}/payments`, body);
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
        <thead><tr><th>Fecha</th><th>Nota</th><th class="amount">Monto</th><th></th></tr></thead>
        <tbody>
          ${items
            .map(
              (p) => `<tr data-payment-id="${p.id}">
                <td class="nowrap">${esc(fmtDate(p.date))}</td>
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
  const tip = '<div class="tip v-panel-foot">Las compras se registran en Movimientos eligiendo esta tarjeta como forma de pago.</div>';
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
              return `<tr>
                <td class="nowrap">${esc(fmtDate(t.date))}</td>
                <td><div class="v-desc" title="${esc(t.description)}">${main}</div>${sub}</td>
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
      panel('payments').innerHTML = paymentsTableHtml(items);
    } catch (err) {
      panel('payments').innerHTML = `<p class="error-text">No se pudieron cargar los pagos.</p>`;
      showError(err);
    }
  };
  const loadCharges = async (): Promise<void> => {
    try {
      const items = await api.get<Transaction[]>(`/api/cards/${card.id}/charges${qs({ limit: CHARGES_LIMIT })}`);
      panel('charges').innerHTML = chargesTableHtml(items);
    } catch (err) {
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
