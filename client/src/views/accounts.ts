/**
 * Vista "Mi dinero": dinero real por cuenta y por banco, con transferencias, ajustes de saldo,
 * Mis bancos (rendimiento anual con tope) y registro de rendimientos.
 * Contrato: secciones "Mi dinero" y "Mis bancos" de shared/types.ts.
 * API: /api/accounts (server/routes/accounts.ts) y /api/banks (server/routes/banks.ts).
 * Los saldos y rendimientos los calcula SIEMPRE el servidor (server/accountsData.ts, server/yields.ts);
 * aquí solo se muestran. La única cuenta local es la vista previa del formulario de banco.
 */
import { ACCOUNT_KIND_LABELS } from '../../../shared/types';
import type {
  Account,
  AccountAdjustInput,
  AccountInput,
  AccountKind,
  AccountMovement,
  AccountMovementSource,
  AccountsOverview,
  Bank,
  BankInput,
  BankTotal,
  Transfer,
  TransferInput,
  YieldInput,
  YieldSuggestion,
} from '../../../shared/types';
import { api, qs, ApiError } from '../api';
import { esc, money, moneySigned, pct, fmtDate, monthName, todayISO, currentYear, settings } from '../format';
import { formModal, openModal, confirmDialog, toast, showError, field, input, moneyInput, select, emptyState, loadingState, on, toNumber, progressBar } from '../ui';
import { monthlyBars, horizontalBars, legendHtml, COLORS, destroyChart } from '../charts';

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const DEFAULT_COLOR = '#e5202e';
const HEX_RE = /^#[0-9a-f]{6}$/i;
const KINDS = Object.keys(ACCOUNT_KIND_LABELS) as AccountKind[];
/** Solo nombres para autocompletar: las tasas NO se sugieren (cambian seguido; las escribe el usuario). */
const BANK_SUGGESTIONS = [
  'BBVA',
  'Banorte',
  'Santander',
  'Banamex',
  'HSBC',
  'Scotiabank',
  'Nu',
  'DiDi',
  'Revolut',
  'Mercado Pago',
  'Hey Banco',
  'Ualá',
  'Klar',
  'Stori',
  'Openbank',
  'Finsus',
  'Kubo Financiero',
  'Cetes Directo',
  'GBM',
  'Banco Azteca',
  'Inbursa',
  'Spin by OXXO',
];
/** Saldo de ejemplo para la vista previa de un banco sin cuentas. */
const EXAMPLE_BALANCE = 10_000;
/** Valores especiales del select de banco del formulario de cuenta. */
const NEW_BANK = '__new';
const KEEP_BANK = '__keep';
const MAX_SUGGESTIONS = 3;

const SOURCE_LABELS: Record<AccountMovementSource, string> = {
  opening: 'Saldo inicial',
  income: 'Ingreso',
  expense: 'Gasto',
  card_payment: 'Pago tarjeta',
  loan_payment: 'Pago préstamo',
  transfer_in: 'Transferencia',
  transfer_out: 'Transferencia',
  adjustment: 'Ajuste',
  yield: 'Rendimiento',
};
const SOURCE_LINKS: Partial<Record<AccountMovementSource, string>> = {
  income: '#/movimientos',
  expense: '#/movimientos',
  card_payment: '#/tarjetas',
  loan_payment: '#/prestamos',
};

const DELETE_ACCOUNT_MSG =
  'Se eliminará la cuenta. Los movimientos y pagos se conservarán sin cuenta; sus transferencias y ajustes se borrarán y el saldo de las otras cuentas puede cambiar. Si solo ya no la usas, mejor archívala.';
const TRANSFER_DISABLED_MSG = 'Necesitas al menos 2 cuentas activas para transferir';

let viewRoot: HTMLElement | null = null;
let data: AccountsOverview | null = null;
/** Año de la gráfica mensual (se conserva al volver a la vista). */
let year = currentYear();
let showArchived = false;
/** Se incrementa en cada carga y en destroy(); una respuesta vieja no pinta sobre otra vista. */
let loadToken = 0;
/** Hay una recarga completa pendiente (crear/editar/borrar): la siguiente respuesta repinta todo. */
let fullPending = false;
let bankCanvas: HTMLCanvasElement | null = null;
let monthCanvas: HTMLCanvasElement | null = null;
let yieldBankCanvas: HTMLCanvasElement | null = null;
let yieldMonthCanvas: HTMLCanvasElement | null = null;

const STYLE = `<style>
.v-money .grid > .card { margin-top: 0; }
.v-money .card + .card { margin-top: 0; }
.v-money .v-money-title { margin-bottom: 0; }
.v-money .v-money-empty-lg .empty { padding: 56px 20px; }
.v-money .v-money-empty-lg .empty .big { font-size: 2.6rem; }
.v-money .v-money-empty-lg .empty p:not(.bold) { max-width: 520px; margin-left: auto; margin-right: auto; }
.v-money .v-money-empty-sm .empty { padding: 18px 12px; }
.v-money .v-money-empty-sm .empty .big { font-size: 1.5rem; margin-bottom: 4px; }
.v-money .v-money-banks .list { margin-top: 10px; }
.v-money .v-money-banks .list-item { padding: 9px 0; gap: 10px; }
.v-money .v-money-banks .total { font-weight: 600; white-space: nowrap; }
.v-money .v-money-banks .share { color: var(--muted); font-size: .8rem; min-width: 42px; text-align: right; }
.v-money .v-money-close { margin-top: 10px; font-size: .85rem; color: var(--text-2); }
.v-money .v-money-bank { display: flex; flex-direction: column; gap: 12px; }
.v-money .v-money-bank-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.v-money .v-money-bank-head h3 { min-width: 0; overflow-wrap: anywhere; }
.v-money .v-money-bank-head .total { font-weight: 700; font-size: 1.05rem; white-space: nowrap; }
.v-money .v-money-acc { border-top: 4px solid var(--acc-color, var(--red)); display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.v-money .v-money-acc-head { display: flex; align-items: center; justify-content: space-between; gap: 6px 8px; flex-wrap: wrap; min-width: 0; }
.v-money .v-money-acc-head h3 { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v-money .v-money-acc-balance { font-size: 1.6rem; font-weight: 800; letter-spacing: -.02em; line-height: 1.15; overflow-wrap: anywhere; }
.v-money .v-money-acc-actions { margin-top: auto; padding-top: 6px; gap: 8px; }
.v-money .v-money-acc.archived { opacity: .6; }
.v-money .v-money-archived { display: flex; flex-direction: column; gap: 12px; }
.v-money-check { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: .9rem; cursor: pointer; user-select: none; }
.v-money-check input { width: 16px; height: 16px; margin: 0; accent-color: var(--red); cursor: pointer; }
.v-money-adjust-now { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.v-money-delta { font-size: .88rem; color: var(--text-2); min-height: 1.4em; }
.v-money-mv-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.v-money-mv-balance { font-size: 1.4rem; font-weight: 800; letter-spacing: -.02em; }
.v-money-mv td.concept { min-width: 190px; }
.v-money-mv .v-money-mv-concept { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.v-money-mv .v-money-mv-desc { color: var(--text-2); font-size: .85rem; margin-top: 3px; overflow-wrap: anywhere; }
.v-money-mv tr.future td { color: var(--muted); }
.v-money .v-money-bank-rate { color: var(--text-2); font-weight: 600; }
.v-money .v-money-acc-yield { font-size: .85rem; color: var(--text-2); }
.v-money .v-money-mybanks .card-head .sub { flex: 1 1 auto; }
.v-money .v-money-bk-list { display: flex; flex-direction: column; }
.v-money .v-money-bk { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--border); min-width: 0; }
.v-money .v-money-bk:first-child { padding-top: 0; }
.v-money .v-money-bk:last-child { border-bottom: 0; padding-bottom: 0; }
.v-money .v-money-bk-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.v-money .v-money-bk-top .grow { flex: 1; min-width: 0; }
.v-money .v-money-bk-top .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v-money .v-money-bk-terms { color: var(--text-2); font-size: .85rem; overflow-wrap: anywhere; }
.v-money .v-money-bk-bal { flex: none; text-align: right; }
.v-money .v-money-bk-bal .total { font-weight: 700; white-space: nowrap; }
.v-money .v-money-cap-foot { display: flex; justify-content: space-between; align-items: baseline; gap: 2px 10px; flex-wrap: wrap; margin-top: 6px; font-size: .85rem; }
.v-money .v-money-cap-foot > span:first-child { overflow-wrap: anywhere; }
.v-money .v-money-bk-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px 10px; flex-wrap: wrap; font-size: .85rem; color: var(--text-2); }
.v-money .v-money-bk-foot .row { gap: 6px; }
.v-money .v-money-suggests { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.v-money .v-money-suggest { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; }
.v-money .v-money-suggest > span { flex: 1 1 220px; min-width: 0; overflow-wrap: anywhere; }
.v-money .v-money-yield-charts { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.v-money .v-money-yield-box { min-width: 0; }
.v-money .v-money-yield-box .card-head { margin-bottom: 10px; }
.v-money-preview { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; font-size: .9rem; color: var(--text-2); min-height: 1.4em; overflow-wrap: anywhere; }
.v-money-field-check { display: flex; flex-direction: column; gap: 4px; }
</style>`;

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
export async function render(root: HTMLElement): Promise<void> {
  viewRoot = root;
  data = null;
  fullPending = false;

  const actions = document.getElementById('topbar-actions');
  if (actions) {
    actions.innerHTML = `
      <button type="button" class="btn primary" id="money-new">+ Nueva cuenta</button>
      <span id="money-transfer-wrap" title="${esc(TRANSFER_DISABLED_MSG)}"><button type="button" class="btn" id="money-transfer" disabled>Transferir</button></span>
      <button type="button" class="btn" id="money-banks">Mis bancos</button>`;
    actions.querySelector('#money-new')?.addEventListener('click', () => openAccountForm());
    actions.querySelector('#money-transfer')?.addEventListener('click', () => openTransferForm());
    actions.querySelector('#money-banks')?.addEventListener('click', () => scrollToBanks());
  }

  root.innerHTML = loadingState('Cargando tu dinero…');
  await load('all', true);
}

export function destroy(): void {
  loadToken++;
  killCharts();
  viewRoot = null;
  data = null;
  fullPending = false;
}

function killCharts(): void {
  destroyChart(bankCanvas);
  destroyChart(monthCanvas);
  destroyChart(yieldBankCanvas);
  destroyChart(yieldMonthCanvas);
  bankCanvas = null;
  monthCanvas = null;
  yieldBankCanvas = null;
  yieldMonthCanvas = null;
}

/** Botón "Mis bancos" de la barra superior: lleva a la sección (o abre el alta si aún no carga la vista). */
function scrollToBanks(): void {
  const el = viewRoot?.querySelector<HTMLElement>('[data-mybanks]');
  if (!el) {
    if (data) openBankForm();
    return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------------
async function load(kind: 'all' | 'year', initial = false): Promise<void> {
  const root = viewRoot;
  if (!root) return;
  if (kind === 'all') fullPending = true;
  const my = ++loadToken;
  try {
    const d = await api.get<AccountsOverview>(`/api/accounts${qs({ year })}`);
    if (my !== loadToken || viewRoot !== root) return;
    data = d;
    const partial = kind === 'year' && !fullPending && !!root.querySelector('[data-monthly]');
    fullPending = false;
    if (partial) {
      paintMonthly();
      paintRegistered();
    } else paint();
  } catch (err) {
    if (my !== loadToken || viewRoot !== root) return;
    showError(err);
    if (initial || !data) {
      root.innerHTML = `<div class="card">
        <p class="error-text">No se pudo cargar tu dinero.</p>
        <p class="muted small">${esc(err instanceof Error ? err.message : '')}</p>
        <div class="form-actions"><button type="button" class="btn" data-retry>Reintentar</button></div>
      </div>`;
      root.querySelector('[data-retry]')?.addEventListener('click', () => {
        root.innerHTML = loadingState('Cargando tu dinero…');
        void load('all', true);
      });
    } else if (kind === 'year') {
      // Regresa el selector al año que sí está cargado.
      year = data.year;
      paintMonthly();
      paintRegistered();
    }
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** Misma etiqueta que bankLabel() del servidor (solo para agrupar en pantalla). */
function bankLabel(a: Pick<Account, 'bank' | 'kind'>): string {
  const b = (a.bank ?? '').trim();
  if (b) return b;
  return a.kind === 'efectivo' ? 'Efectivo' : 'Sin banco';
}
const bankKey = (label: string): string => label.toLocaleLowerCase('es');

function activeAccounts(): Account[] {
  return (data?.items ?? []).filter((a) => !a.archived);
}

function findAccount(id: string | undefined): Account | undefined {
  if (!id) return undefined;
  return data?.items.find((a) => String(a.id) === id);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const fmtCache = new Map<string, Intl.NumberFormat>();
function numberFormat(opts: Intl.NumberFormatOptions): Intl.NumberFormat | null {
  const key = `${settings.locale}|${settings.currency}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(settings.locale, opts);
    } catch {
      return null; // locale o moneda inválidos: quien llama usa el formato general
    }
    fmtCache.set(key, f);
  }
  return f;
}

/** Monto sin centavos cuando es entero ("$10,000"); con centavos si los tiene. */
function moneyRound(n: number | null | undefined): string {
  const v = round2(Number(n) || 0);
  if (!Number.isInteger(v)) return money(v);
  const f = numberFormat({ style: 'currency', currency: settings.currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return f ? f.format(v) : money(v);
}

/** Tasa anual en porcentaje: 15 -> "15%", 10.25 -> "10.25%". */
function rateText(r: number | null | undefined): string {
  const v = Number(r) || 0;
  const f = numberFormat({ maximumFractionDigits: 3 });
  return `${f ? f.format(v) : String(v)}%`;
}

function bankById(id: number | null | undefined): Bank | undefined {
  if (id === null || id === undefined) return undefined;
  return data?.banks.find((b) => b.id === id);
}

function bankByName(name: string): Bank | undefined {
  const k = bankKey(name.trim());
  if (!k) return undefined;
  return data?.banks.find((b) => bankKey(b.name) === k);
}

type BankTermsLike = Pick<Bank, 'annual_rate' | 'yield_cap' | 'rate_above_cap'>;

function bankEarns(b: BankTermsLike): boolean {
  return b.annual_rate > 0 || (b.yield_cap !== null && b.rate_above_cap > 0);
}

/** "15% anual hasta $10,000 (después 0%)", "9% anual sin tope" o "Sin rendimiento". */
function bankTermsText(b: BankTermsLike): string {
  if (!bankEarns(b)) return 'Sin rendimiento';
  if (b.yield_cap === null) return `${rateText(b.annual_rate)} anual sin tope`;
  return `${rateText(b.annual_rate)} anual hasta ${moneyRound(b.yield_cap)} (después ${rateText(b.rate_above_cap)})`;
}

/**
 * Solo para la vista previa del formulario de banco (el cálculo real vive en server/yields.ts):
 * (min(saldo, tope) * tasa + excedente * tasa_excedente) / 100 / 12.
 */
function previewMonthly(balance: number, rate: number, cap: number | null, above: number): number {
  const b = Math.max(0, balance);
  if (cap === null) return round2((b * rate) / 100 / 12);
  const within = Math.min(b, cap);
  const over = Math.max(0, b - cap);
  return round2((within * rate + over * above) / 100 / 12);
}

/** Cuentas sugeridas para mover dinero de un banco a otro: origen = la de mayor saldo que rinde; destino = una activa del banco destino. */
function suggestionPlan(s: YieldSuggestion): { from?: Account; to?: Account } {
  const active = activeAccounts();
  const byBalance = (a: Account, b: Account): number => b.balance - a.balance || a.id - b.id;
  const from = active.filter((a) => a.bank_id === s.from_bank_id && a.earns_yield && a.balance > 0).sort(byBalance)[0];
  const to = active
    .filter((a) => a.bank_id === s.to_bank_id)
    .sort((a, b) => Number(b.earns_yield) - Number(a.earns_yield) || byBalance(a, b))[0];
  return { from, to };
}

function syncTopbar(activeCount: number): void {
  const btn = document.getElementById('money-transfer') as HTMLButtonElement | null;
  const wrap = document.getElementById('money-transfer-wrap');
  const enough = activeCount >= 2;
  if (btn) {
    btn.disabled = !enough;
    if (enough) btn.removeAttribute('title');
    else btn.title = TRANSFER_DISABLED_MSG;
  }
  if (wrap) {
    if (enough) wrap.removeAttribute('title');
    else wrap.title = TRANSFER_DISABLED_MSG;
  }
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------
function paint(): void {
  const root = viewRoot;
  const d = data;
  if (!root || !d) return;
  killCharts();

  const active = d.items.filter((a) => !a.archived);
  const archived = d.items.filter((a) => a.archived);
  syncTopbar(active.length);

  const body =
    active.length === 0
      ? `<div class="v-money-empty-lg">${emptyState(
          '💰',
          'Agrega tus cuentas',
          'Registra dónde tienes tu dinero: nómina, ahorro, inversión o efectivo. Así sabrás cuánto tienes disponible y en qué banco está.',
          '<button type="button" class="btn primary" data-new>+ Agregar mi primera cuenta</button>',
        )}</div>
        <div class="tip">Tus metas de ahorro son objetivos; aquí ves tu dinero real y en qué banco está.</div>
        ${myBanksHtml(d)}`
      : `${statsHtml(d)}
        <div class="grid grid-2">
          ${banksCardHtml(d)}
          <div class="card" data-monthly></div>
        </div>
        ${myBanksHtml(d)}
        ${accountsHtml(d, active)}`;

  root.innerHTML = `<div class="v-money stack">${STYLE}${body}${archivedHtml(archived, active.length)}</div>`;
  const wrap = root.querySelector<HTMLElement>('.v-money');
  if (!wrap) return;
  bind(wrap);

  const banks = wrap.querySelector<HTMLCanvasElement>('[data-chart="banks"]');
  if (banks) {
    horizontalBars(
      banks,
      d.by_bank.map((b) => ({ label: b.bank, value: Math.max(0, b.total), share: b.share })),
      COLORS.expense,
    );
    bankCanvas = banks;
  }
  const yieldBanks = wrap.querySelector<HTMLCanvasElement>('[data-chart="yield-banks"]');
  if (yieldBanks) {
    const items = yieldBankItems(d);
    const total = items.reduce((acc, b) => acc + b.est_yield_month, 0);
    horizontalBars(
      yieldBanks,
      items.map((b) => ({ label: b.name, value: b.est_yield_month, share: total > 0 ? b.est_yield_month / total : 0 })),
      COLORS.moneyAvailable,
    );
    yieldBankCanvas = yieldBanks;
  }
  paintMonthly();
  paintRegistered();
}

function statTile(label: string, value: string, cls: string, foot: string): string {
  return `<div class="stat">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value ${cls}">${esc(value)}</div>
    <div class="stat-foot">${esc(foot)}</div>
  </div>`;
}

function statsHtml(d: AccountsOverview): string {
  const t = d.totals;
  const y = d.yields;
  const yieldFoot = y.est_year > 0 ? `${money(y.est_year)} al año · ${rateText(y.effective_rate)} promedio` : 'Configura la tasa de tus bancos';
  return `<div class="grid grid-4">
    ${statTile('Dinero total', money(t.total), t.total < 0 ? 'red' : 'white', `${plural(t.accounts, 'cuenta', 'cuentas')} en ${plural(d.by_bank.length, 'banco', 'bancos')}`)}
    ${statTile('Disponible', money(t.disponible), t.disponible < 0 ? 'red' : 'white', 'Débito, nómina y efectivo')}
    ${statTile('Guardado', money(t.guardado), t.guardado < 0 ? 'red' : '', `Ahorro ${money(t.ahorro)} · Inversión ${money(t.inversion)}`)}
    ${statTile('Rinde al mes', money(y.est_month), 'white', yieldFoot)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Mis bancos
// ---------------------------------------------------------------------------
function yieldBankItems(d: AccountsOverview): Bank[] {
  return d.banks.filter((b) => b.est_yield_month > 0).sort((a, b) => b.est_yield_month - a.est_yield_month || a.name.localeCompare(b.name, 'es'));
}

function myBanksHtml(d: AccountsOverview): string {
  const head = `<div class="card-head">
      <h2>Mis bancos</h2>
      <span class="sub">Rendimiento estimado a hoy</span>
      <button type="button" class="btn sm" data-bank-new>+ Nuevo banco</button>
    </div>`;
  if (d.banks.length === 0) {
    return `<div class="card v-money-mybanks" data-mybanks>
      ${head}
      <div class="v-money-empty-sm">${emptyState(
        '🏦',
        'Agrega tus bancos para calcular cuánto te rinde tu dinero',
        'Escribe la tasa anual y el tope que te da cada banco (revísalos en su app: cambian seguido).',
        '<button type="button" class="btn primary sm" data-bank-new>+ Agregar banco</button>',
      )}</div>
    </div>`;
  }

  const items = yieldBankItems(d);
  const height = Math.max(160, items.length * 34 + 40);
  const estChart =
    items.length > 0
      ? `<div class="chart-box" style="height:${height}px"><canvas data-chart="yield-banks" role="img" aria-label="Rendimiento estimado al mes por banco"></canvas></div>`
      : `<div class="v-money-empty-sm">${emptyState('📈', 'Aún no hay rendimiento estimado', 'Configura la tasa de tus bancos y elige el banco en tus cuentas.')}</div>`;

  return `<div class="card v-money-mybanks" data-mybanks>
    ${head}
    <div class="v-money-bk-list">${d.banks.map(bankRowHtml).join('')}</div>
    ${suggestionsHtml(d)}
    <div class="grid grid-2 v-money-yield-charts">
      <div class="v-money-yield-box">
        <div class="card-head"><h3>Rendimiento estimado al mes por banco</h3></div>
        ${estChart}
      </div>
      <div class="v-money-yield-box" data-registered></div>
    </div>
  </div>`;
}

function bankRowHtml(b: Bank): string {
  const color = HEX_RE.test(b.color) ? b.color : DEFAULT_COLOR;
  const earns = bankEarns(b);
  let capHtml = '';
  if (b.yield_cap !== null && b.annual_rate > 0) {
    const cap = b.yield_cap;
    const ratio = cap > 0 ? b.yield_balance / cap : b.yield_balance > 0 ? 2 : 0;
    let status: string;
    if (b.over_cap > 0) {
      const after = b.rate_above_cap > 0 ? ` (rinde ${rateText(b.rate_above_cap)})` : '';
      status = `<span class="red">Excedes el tope por ${esc(money(b.over_cap))}: ese dinero ya no rinde ${esc(rateText(b.annual_rate))}${esc(after)}</span>`;
    } else if ((b.cap_room ?? 0) > 0) {
      status = `<span class="muted">Te quedan <span class="white num">${esc(money(b.cap_room))}</span> para llegar al tope</span>`;
    } else {
      status = '<span class="muted">Estás justo en el tope</span>';
    }
    capHtml = `<div>
      ${progressBar(ratio)}
      <div class="v-money-cap-foot">${status}<span class="muted num nowrap">${esc(moneyRound(b.yield_balance))} de ${esc(moneyRound(cap))}</span></div>
    </div>`;
  }
  const accountsText = b.accounts_count > 0 ? plural(b.accounts_count, 'cuenta', 'cuentas') : 'Sin cuentas';
  const info: string[] = [];
  if (earns) info.push(`Rinde ~<span class="white num">${esc(money(b.est_yield_month))}</span>/mes`);
  if (earns || b.yield_registered_year > 0) info.push(`Registrado este año: <span class="white num">${esc(money(b.yield_registered_year))}</span>`);
  return `<div class="v-money-bk">
    <div class="v-money-bk-top">
      <span class="dot" style="background:${esc(color)}"></span>
      <div class="grow">
        <div class="name" title="${esc(b.name)}">${esc(b.name)}</div>
        <div class="v-money-bk-terms">${esc(bankTermsText(b))}</div>
      </div>
      <div class="v-money-bk-bal">
        <div class="total num ${b.balance < 0 ? 'red' : 'white'}">${esc(money(b.balance))}</div>
        <div class="muted tiny">${esc(accountsText)}</div>
      </div>
    </div>
    ${capHtml}
    <div class="v-money-bk-foot">
      <span>${info.join(' · ') || '<span class="muted">No genera rendimiento</span>'}</span>
      <span class="row">
        <button type="button" class="btn ghost sm" data-bank-edit="${b.id}">Editar</button>
        <button type="button" class="btn danger sm icon" data-bank-delete="${b.id}" aria-label="Eliminar banco ${esc(b.name)}" title="Eliminar banco">🗑</button>
      </span>
    </div>
  </div>`;
}

function suggestionsHtml(d: AccountsOverview): string {
  const list = d.yields.suggestions.slice(0, MAX_SUGGESTIONS);
  if (list.length === 0) return '';
  const tips = list
    .map((s, i) => {
      const plan = suggestionPlan(s);
      let action = '';
      if (!plan.to) {
        action = `<button type="button" class="btn sm" data-suggest-create="${s.to_bank_id}">Crea una cuenta en ${esc(s.to_bank)}</button>`;
      } else if (plan.from && plan.from.id !== plan.to.id) {
        action = `<button type="button" class="btn sm" data-suggest="${i}">Transferir</button>`;
      }
      return `<div class="tip v-money-suggest">
        <span>Mueve <strong class="white num">${esc(money(s.amount))}</strong> de ${esc(s.from_bank)} a ${esc(s.to_bank)}: ganarías ~<strong class="white num">${esc(money(s.extra_year))}</strong> más al año</span>
        ${action}
      </div>`;
    })
    .join('');
  return `<div class="v-money-suggests">${tips}</div>`;
}

/** "Rendimientos registrados por mes" del año seleccionado (se repinta al cambiar de año). */
function paintRegistered(): void {
  const d = data;
  const box = viewRoot?.querySelector<HTMLElement>('[data-registered]');
  if (!box || !d) return;
  destroyChart(yieldMonthCanvas);
  yieldMonthCanvas = null;

  const byMonth = new Map(d.yields.monthly_registered.map((r) => [r.month, Number(r.amount) || 0]));
  const values = Array.from({ length: 12 }, (_, i) => round2(byMonth.get(i + 1) ?? 0));
  const any = values.some((v) => Math.abs(v) >= 0.005);
  box.innerHTML = `
    <div class="card-head">
      <h3>Rendimientos registrados por mes</h3>
      <span class="sub">${esc(d.year)} · <span class="num">${esc(money(d.yields.registered_year))}</span></span>
    </div>
    ${
      any
        ? `<div class="chart-box sm"><canvas data-chart="yield-monthly" role="img" aria-label="Rendimientos registrados por mes en ${esc(d.year)}"></canvas></div>`
        : `<div class="v-money-empty-sm">${emptyState('🪙', `Sin rendimientos registrados en ${d.year}`, "Registra lo que te paga tu banco con 'Registrar rendimiento'")}</div>`
    }`;

  const canvas = box.querySelector<HTMLCanvasElement>('[data-chart="yield-monthly"]');
  if (!canvas) return;
  monthlyBars(canvas, [{ label: 'Rendimientos', data: values, color: COLORS.moneySaved }]);
  yieldMonthCanvas = canvas;
}

function banksCardHtml(d: AccountsOverview): string {
  const anyPositive = d.by_bank.some((b) => b.total > 0);
  const height = Math.max(160, d.by_bank.length * 34 + 40);
  const chart = anyPositive
    ? `<div class="chart-box" style="height:${height}px"><canvas data-chart="banks" role="img" aria-label="Dinero por banco"></canvas></div>`
    : `<div class="v-money-empty-sm">${emptyState('🏦', 'Aún no hay saldo en tus cuentas', 'Usa "Ajustar saldo" para registrar lo que tienes en cada banco.')}</div>`;
  return `<div class="card v-money-banks">
    <div class="card-head"><h2>¿Dónde está tu dinero?</h2><span class="sub">Por banco, a hoy</span></div>
    ${chart}
    <div class="list">${d.by_bank.map(bankItemHtml).join('')}</div>
  </div>`;
}

function bankItemHtml(b: BankTotal): string {
  const meta = `${plural(b.accounts, 'cuenta', 'cuentas')} · Disponible ${money(b.disponible)} · Guardado ${money(b.guardado)}`;
  return `<div class="list-item">
    <div class="grow">
      <div class="name" title="${esc(b.bank)}">${esc(b.bank)}</div>
      <div class="meta">${esc(meta)}</div>
    </div>
    <span class="total num ${b.total < 0 ? 'red' : 'white'}">${esc(money(b.total))}</span>
    <span class="share num">${esc(pct(b.share))}</span>
  </div>`;
}

/** Tarjeta "Disponible y guardado por mes" (se repinta sola al cambiar de año). */
function paintMonthly(): void {
  const root = viewRoot;
  const d = data;
  const box = root?.querySelector<HTMLElement>('[data-monthly]');
  if (!box || !d) return;
  destroyChart(monthCanvas);
  monthCanvas = null;

  const years = Array.from(new Set([...d.available_years, d.year, year])).sort((a, b) => b - a);
  let last = -1;
  d.monthly.forEach((m, i) => {
    if (m.total !== null) last = i;
  });
  const hasData = last >= 0;

  let closing = '';
  if (hasData) {
    const m = d.monthly[last];
    const today = todayISO();
    const isCurrent = d.year === Number(today.slice(0, 4)) && m.month === Number(today.slice(5, 7));
    closing = `<p class="v-money-close">Cierre de ${esc(monthName(m.month))}${isCurrent ? ' (a hoy)' : ''}: <strong class="num ${Number(m.total) < 0 ? 'red' : 'white'}">${esc(money(m.total))}</strong></p>`;
  }

  box.innerHTML = `
    <div class="card-head">
      <h2>Disponible y guardado por mes</h2>
      <div class="period" aria-label="Año de la gráfica">
        <button type="button" class="btn icon" data-year-prev aria-label="Año anterior" ${year <= MIN_YEAR ? 'disabled' : ''}>‹</button>
        <select data-year-select aria-label="Año">${years.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <button type="button" class="btn icon" data-year-next aria-label="Año siguiente" ${year >= MAX_YEAR ? 'disabled' : ''}>›</button>
      </div>
    </div>
    ${
      hasData
        ? `<div class="chart-box"><canvas data-chart="monthly" role="img" aria-label="Disponible y guardado por mes en ${d.year}"></canvas></div>
          ${legendHtml([
            { label: 'Disponible', color: COLORS.moneyAvailable },
            { label: 'Guardado', color: COLORS.moneySaved },
          ])}
          ${closing}`
        : `<div class="v-money-empty-sm">${emptyState('📅', `Sin saldos en ${d.year}`, 'Tus cuentas aún no estaban abiertas en ese año o el año todavía no empieza.')}</div>`
    }`;

  const canvas = box.querySelector<HTMLCanvasElement>('[data-chart="monthly"]');
  if (!canvas) return;
  monthlyBars(
    canvas,
    [
      { label: 'Disponible', data: d.monthly.map((m) => m.disponible), color: COLORS.moneyAvailable },
      { label: 'Guardado', data: d.monthly.map((m) => m.guardado), color: COLORS.moneySaved },
    ],
    { stacked: true },
  );
  monthCanvas = canvas;
}

function accountsHtml(d: AccountsOverview, active: Account[]): string {
  const canTransfer = active.length >= 2;
  const groups = new Map<string, { label: string; total: number | null; accounts: Account[] }>();
  for (const b of d.by_bank) groups.set(bankKey(b.bank), { label: b.bank, total: b.total, accounts: [] });
  for (const a of active) {
    const label = bankLabel(a);
    const key = bankKey(label);
    let g = groups.get(key);
    if (!g) {
      g = { label, total: null, accounts: [] };
      groups.set(key, g);
    }
    g.accounts.push(a);
  }
  const sections = [...groups.values()]
    .filter((g) => g.accounts.length > 0)
    .map((g) => {
      const total = g.total ?? round2(g.accounts.reduce((acc, a) => acc + a.balance, 0));
      const bank = bankByName(g.label);
      const rate = bank && bank.annual_rate > 0 ? ` <span class="small v-money-bank-rate">· ${esc(rateText(bank.annual_rate))} anual</span>` : '';
      return `<section class="v-money-bank">
        <div class="v-money-bank-head">
          <h3>${esc(g.label)} <span class="muted small">· ${esc(plural(g.accounts.length, 'cuenta', 'cuentas'))}</span>${rate}</h3>
          <span class="total num ${total < 0 ? 'red' : 'white'}">${esc(money(total))}</span>
        </div>
        <div class="grid grid-auto">${g.accounts.map((a) => accountCardHtml(a, canTransfer)).join('')}</div>
      </section>`;
    })
    .join('');
  return `<div class="card-head v-money-title"><h2>Tus cuentas</h2><span class="sub">Agrupadas por banco</span></div>${sections}`;
}

function accountCardHtml(a: Account, canTransfer: boolean): string {
  const color = HEX_RE.test(a.color) ? a.color : DEFAULT_COLOR;
  const last = a.last_movement_date ? `Último movimiento: ${fmtDate(a.last_movement_date)}` : 'Sin movimientos';
  const bank = bankById(a.bank_id);
  const canRegisterYield = !a.archived && !!bank && bank.annual_rate > 0;
  let yieldLine = '';
  if (!a.archived && a.est_yield_month > 0) {
    yieldLine = `<div class="v-money-acc-yield">Rinde ~<span class="white num">${esc(money(a.est_yield_month))}</span>/mes</div>`;
  } else if (canRegisterYield && !a.earns_yield) {
    yieldLine = '<div class="v-money-acc-yield muted">No cuenta para el rendimiento de su banco</div>';
  }
  const actions = a.archived
    ? `<button type="button" class="btn sm" data-restore="${a.id}">Restaurar</button>
       <button type="button" class="btn ghost sm" data-movements="${a.id}">Movimientos</button>
       <button type="button" class="btn ghost sm" data-edit="${a.id}">Editar</button>
       <button type="button" class="btn danger sm icon" data-delete="${a.id}" aria-label="Eliminar cuenta" title="Eliminar cuenta">🗑</button>`
    : `<button type="button" class="btn primary sm" data-adjust="${a.id}">Ajustar saldo</button>
       <button type="button" class="btn sm" data-movements="${a.id}">Movimientos</button>
       ${canTransfer ? `<button type="button" class="btn sm" data-transfer="${a.id}">Transferir</button>` : ''}
       ${canRegisterYield ? `<button type="button" class="btn sm" data-yield="${a.id}">Registrar rendimiento</button>` : ''}
       <button type="button" class="btn ghost sm" data-edit="${a.id}">Editar</button>
       <button type="button" class="btn danger sm icon" data-delete="${a.id}" aria-label="Eliminar cuenta" title="Eliminar cuenta">🗑</button>`;
  return `<div class="card v-money-acc ${a.archived ? 'archived' : ''}" style="--acc-color:${color}">
    <div class="v-money-acc-head">
      <h3 title="${esc(a.name)}">${esc(a.name)}</h3>
      <span class="badge gray">${esc(ACCOUNT_KIND_LABELS[a.kind] ?? a.kind)}</span>
    </div>
    ${a.archived ? `<div class="muted small">${esc(bankLabel(a))} · Archivada</div>` : ''}
    <div class="v-money-acc-balance num ${a.balance < 0 ? 'red' : 'white'}">${esc(money(a.balance))}</div>
    ${yieldLine}
    <div class="small muted">Este mes: <span class="white num">+${esc(money(a.inflow_this_month))}</span> / <span class="num ${a.outflow_this_month > 0 ? 'red' : ''}">−${esc(money(a.outflow_this_month))}</span></div>
    <div class="small muted">${esc(last)}</div>
    <div class="row v-money-acc-actions">${actions}</div>
  </div>`;
}

function archivedHtml(archived: Account[], activeCount: number): string {
  if (archived.length === 0) return '';
  return `<div class="v-money-archived">
    <label class="v-money-check"><input type="checkbox" data-toggle-archived ${showArchived ? 'checked' : ''} /> Mostrar archivadas (${archived.length})</label>
    <div class="grid grid-auto ${showArchived ? '' : 'hidden'}" data-archived>${archived.map((a) => accountCardHtml(a, activeCount >= 2)).join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function bind(wrap: HTMLElement): void {
  on(wrap, 'click', '[data-new]', () => openAccountForm());
  on(wrap, 'click', '[data-adjust]', (el) => {
    const a = findAccount(el.dataset.adjust);
    if (a) openAdjustForm(a);
  });
  on(wrap, 'click', '[data-movements]', (el) => {
    const a = findAccount(el.dataset.movements);
    if (a) void openMovements(a);
  });
  on(wrap, 'click', '[data-transfer]', (el) => {
    const a = findAccount(el.dataset.transfer);
    if (a) openTransferForm({ fromId: a.id });
  });
  on(wrap, 'click', '[data-yield]', (el) => {
    const a = findAccount(el.dataset.yield);
    if (a) openYieldForm(a);
  });
  on(wrap, 'click', '[data-bank-new]', () => openBankForm());
  on(wrap, 'click', '[data-bank-edit]', (el) => {
    const b = bankById(Number(el.dataset.bankEdit));
    if (b) openBankForm(b);
  });
  on(wrap, 'click', '[data-bank-delete]', (el) => {
    const b = bankById(Number(el.dataset.bankDelete));
    if (b) void deleteBank(b);
  });
  on(wrap, 'click', '[data-suggest]', (el) => {
    const s = data?.yields.suggestions.slice(0, MAX_SUGGESTIONS)[Number(el.dataset.suggest)];
    if (s) openSuggestedTransfer(s);
  });
  on(wrap, 'click', '[data-suggest-create]', (el) => {
    const b = bankById(Number(el.dataset.suggestCreate));
    if (b) openAccountForm(undefined, { bankId: b.id });
  });
  on(wrap, 'click', '[data-edit]', (el) => {
    const a = findAccount(el.dataset.edit);
    if (a) openAccountForm(a);
  });
  on(wrap, 'click', '[data-delete]', (el) => {
    const a = findAccount(el.dataset.delete);
    if (a) void deleteAccount(a);
  });
  on(wrap, 'click', '[data-restore]', (el) => {
    const a = findAccount(el.dataset.restore);
    if (a) void restoreAccount(a);
  });
  on(wrap, 'change', '[data-toggle-archived]', (el) => {
    showArchived = (el as HTMLInputElement).checked;
    wrap.querySelector('[data-archived]')?.classList.toggle('hidden', !showArchived);
  });
  on(wrap, 'click', '[data-year-prev]', () => setYear(year - 1));
  on(wrap, 'click', '[data-year-next]', () => setYear(year + 1));
  on(wrap, 'change', '[data-year-select]', (el) => setYear(Number((el as HTMLSelectElement).value)));
}

function setYear(y: number): void {
  if (!Number.isInteger(y) || y < MIN_YEAR || y > MAX_YEAR || y === year) return;
  year = y;
  void load('year');
}

// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------
/** Opciones del select de banco: sin banco, los bancos, el banco escrito a mano (si no está vinculado) y "+ Nuevo banco…". */
function bankOptionsHtml(banks: Bank[], selected: string, legacyName: string): string {
  const opt = (value: string, label: string): string => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  return [
    opt('', 'Sin banco (efectivo)'),
    legacyName ? opt(KEEP_BANK, `${legacyName} (sin configurar)`) : '',
    ...banks.map((b) => opt(String(b.id), b.annual_rate > 0 ? `${b.name} · ${rateText(b.annual_rate)} anual` : b.name)),
    opt(NEW_BANK, '+ Nuevo banco…'),
  ].join('');
}

function openAccountForm(acc?: Account, preset: { bankId?: number } = {}): void {
  const color = acc && HEX_RE.test(acc.color) ? acc.color : DEFAULT_COLOR;
  const kind: AccountKind = acc?.kind ?? 'disponible';
  const banks = data?.banks ?? [];
  // Cuenta con banco escrito a mano que no quedó vinculado: se conserva tal cual salvo que el usuario elija otro.
  const typed = acc && acc.bank_id === null ? acc.bank.trim() : '';
  const typedMatch = typed ? bankByName(typed) : undefined;
  const legacyName = typed && !typedMatch ? typed : '';
  let selectedBank = '';
  if (acc) selectedBank = acc.bank_id !== null ? String(acc.bank_id) : typedMatch ? String(typedMatch.id) : legacyName ? KEEP_BANK : '';
  else if (preset.bankId !== undefined && banks.some((b) => b.id === preset.bankId)) selectedBank = String(preset.bankId);
  const earns = acc ? acc.earns_yield : true;

  formModal({
    title: acc ? 'Editar cuenta' : 'Nueva cuenta',
    submitLabel: acc ? 'Guardar cambios' : 'Crear cuenta',
    html: `<form class="form">
      ${field('Nombre', input('name', { value: acc?.name ?? '', placeholder: 'Nómina, Ahorro, Cartera…', required: true }))}
      <div class="form-row">
        ${field('Banco', `<select name="bank_id" data-bank-select>${bankOptionsHtml(banks, selectedBank, legacyName)}</select>`)}
        ${field('Tipo', select('kind', KINDS.map((k) => ({ value: k, label: ACCOUNT_KIND_LABELS[k], selected: k === kind }))))}
      </div>
      <div class="v-money-field-check">
        <label class="v-money-check"><input type="checkbox" name="earns_yield" ${earns ? 'checked' : ''} /> Genera rendimiento</label>
        <span class="help">Desmárcalo si esta cuenta no gana intereses</span>
      </div>
      <div class="form-row">
        ${field(
          acc ? 'Saldo inicial' : 'Saldo actual',
          input('opening_balance', { type: 'number', step: '0.01', value: acc ? acc.opening_balance : '', placeholder: '0.00', required: true }),
          acc ? 'Saldo al inicio de la fecha de apertura. Para cuadrar con tu banco usa Ajustar saldo.' : 'Puede ser negativo si estás en sobregiro',
        )}
        ${field('Fecha de apertura', input('opening_date', { type: 'date', value: acc?.opening_date ?? todayISO(), required: true }), 'Solo cuentan los movimientos desde esta fecha')}
      </div>
      ${field('Color', `<input type="color" name="color" value="${esc(color)}" />`)}
      ${acc ? `<label class="v-money-check"><input type="checkbox" name="archived" ${acc.archived ? 'checked' : ''} /> Archivar cuenta (ya no la uso)</label>` : ''}
    </form>`,
    onSubmit: async (v, _form, modal) => {
      const name = (v.name ?? '').trim();
      if (!name) throw new Error('El nombre es obligatorio');
      const rawBalance = (v.opening_balance ?? '').trim();
      if (rawBalance === '') throw new Error(acc ? 'Escribe el saldo inicial' : 'Escribe el saldo actual');
      const opening = toNumber(rawBalance, 'saldo');
      if (!v.opening_date) throw new Error('La fecha de apertura es obligatoria');
      const k = KINDS.includes(v.kind as AccountKind) ? (v.kind as AccountKind) : 'disponible';
      const body: AccountInput = {
        name,
        bank: (v.bank ?? '').trim(),
        kind: k,
        opening_balance: round2(opening),
        opening_date: v.opening_date,
        color: HEX_RE.test(v.color ?? '') ? v.color : DEFAULT_COLOR,
      };
      let msg = 'Cuenta creada';
      if (acc) {
        body.archived = v.archived === 'on';
        await api.put<Account>(`/api/accounts/${acc.id}`, body);
        msg = body.archived !== acc.archived ? (body.archived ? 'Cuenta archivada' : 'Cuenta restaurada') : 'Cuenta actualizada';
      } else {
        await api.post<Account>('/api/accounts', body);
      }
      modal.close();
      toast(msg);
      await load('all');
    },
  });
}

function openAdjustForm(acc: Account): void {
  const today = todayISO();
  formModal({
    title: `Ajustar saldo · ${acc.name}`,
    submitLabel: 'Ajustar saldo',
    html: `<form class="form">
      <div class="v-money-adjust-now"><span class="muted">Saldo en la app:</span><strong class="num ${acc.balance < 0 ? 'red' : 'white'}">${esc(money(acc.balance))}</strong></div>
      ${field('Saldo real en tu banco', input('balance', { type: 'number', step: '0.01', value: acc.balance, required: true }), 'Lo que marca tu banco (o lo que traes en la cartera)')}
      <div class="form-row">
        ${field('Fecha', input('date', { type: 'date', value: today, required: true, min: acc.opening_date }))}
        ${field('Nota', input('note', { placeholder: 'Opcional' }))}
      </div>
      <p class="v-money-delta" data-delta aria-live="polite"></p>
    </form>`,
    onOpen: (form) => {
      const bal = form.querySelector<HTMLInputElement>('input[name="balance"]');
      const date = form.querySelector<HTMLInputElement>('input[name="date"]');
      const out = form.querySelector<HTMLElement>('[data-delta]');
      const update = (): void => {
        if (!out || !bal) return;
        const raw = bal.value.trim();
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) {
          out.textContent = 'Escribe el saldo que marca tu banco.';
          return;
        }
        const when = date?.value || today;
        if (when !== today) {
          out.textContent = `El ajuste se calculará contra el saldo que la app tenía el ${fmtDate(when)}.`;
          return;
        }
        const delta = round2(n - acc.balance);
        if (Math.abs(delta) < 0.01) {
          out.textContent = 'Sin cambios';
          return;
        }
        out.innerHTML = `Se registrará un ajuste de <strong class="num ${delta < 0 ? 'red' : 'white'}">${esc(moneySigned(delta))}</strong>`;
      };
      bal?.addEventListener('input', update);
      date?.addEventListener('input', update);
      date?.addEventListener('change', update);
      update();
    },
    onSubmit: async (v, _form, modal) => {
      const raw = (v.balance ?? '').trim();
      if (raw === '') throw new Error('Escribe el saldo real de tu banco');
      const real = toNumber(raw, 'saldo real');
      const date = v.date || today;
      if (date < acc.opening_date) throw new Error(`La fecha no puede ser anterior a la apertura de la cuenta (${fmtDate(acc.opening_date)})`);
      const body: AccountAdjustInput = { balance: round2(real), date, note: (v.note ?? '').trim() };
      const updated = await api.post<Account>(`/api/accounts/${acc.id}/adjust`, body);
      modal.close();
      toast(Math.abs(updated.balance - acc.balance) < 0.005 ? 'El saldo ya coincidía; no se registró ningún ajuste' : 'Saldo ajustado');
      await load('all');
    },
  });
}

function openTransferForm(fromId?: number): void {
  const active = activeAccounts();
  if (active.length < 2) {
    toast(TRANSFER_DISABLED_MSG, 'error');
    return;
  }
  const from = active.find((a) => a.id === fromId) ?? active[0];
  const to = active.find((a) => a.id !== from.id) ?? active[1];
  const options = (selectedId: number) =>
    active.map((a) => ({ value: a.id, label: `${a.name} · ${bankLabel(a)} (${money(a.balance)})`, selected: a.id === selectedId }));
  formModal({
    title: 'Transferir entre cuentas',
    submitLabel: 'Transferir',
    html: `<form class="form">
      <div class="form-row">
        ${field('Desde', select('from_account_id', options(from.id)))}
        ${field('Hacia', select('to_account_id', options(to.id)))}
      </div>
      <div class="form-row">
        ${field('Monto', moneyInput('amount'))}
        ${field('Fecha', input('date', { type: 'date', value: todayISO(), required: true }))}
      </div>
      ${field('Nota', input('note', { placeholder: 'Opcional' }))}
    </form>`,
    onSubmit: async (v, _form, modal) => {
      const src = active.find((a) => String(a.id) === v.from_account_id);
      const dst = active.find((a) => String(a.id) === v.to_account_id);
      if (!src || !dst) throw new Error('Elige la cuenta de origen y la de destino');
      if (src.id === dst.id) throw new Error('Elige dos cuentas distintas');
      const amount = toNumber(v.amount ?? '', 'monto');
      if (!(amount > 0)) throw new Error('El monto debe ser mayor a 0');
      if (!v.date) throw new Error('La fecha es obligatoria');
      for (const a of [src, dst]) {
        if (v.date < a.opening_date) {
          throw new Error(`La fecha es anterior a la apertura de ${a.name} (${fmtDate(a.opening_date)}); no contaría en su saldo`);
        }
      }
      const body: TransferInput = {
        from_account_id: src.id,
        to_account_id: dst.id,
        amount: round2(amount),
        date: v.date,
        note: (v.note ?? '').trim(),
      };
      await api.post<Transfer>('/api/accounts/transfers', body);
      modal.close();
      toast('Transferencia registrada');
      await load('all');
    },
  });
}

// ---------------------------------------------------------------------------
// Movimientos de una cuenta
// ---------------------------------------------------------------------------
function movementRowHtml(m: AccountMovement): string {
  const label = SOURCE_LABELS[m.source] ?? m.source;
  const desc = m.description && m.description !== label ? `<div class="v-money-mv-desc">${esc(m.description)}</div>` : '';
  let action = '';
  if (m.ref_id !== null && m.source === 'adjustment') {
    action = `<button type="button" class="btn ghost sm icon" data-del-adjust="${m.ref_id}" aria-label="Eliminar ajuste" title="Eliminar ajuste">🗑</button>`;
  } else if (m.ref_id !== null && (m.source === 'transfer_in' || m.source === 'transfer_out')) {
    action = `<button type="button" class="btn ghost sm icon" data-del-transfer="${m.ref_id}" aria-label="Eliminar transferencia" title="Eliminar transferencia">🗑</button>`;
  } else if (SOURCE_LINKS[m.source]) {
    action = `<a class="btn ghost sm" href="${SOURCE_LINKS[m.source]}" data-goto>Ver</a>`;
  }
  return `<tr class="${m.future ? 'future' : ''}">
    <td class="nowrap">${esc(fmtDate(m.date))}</td>
    <td class="concept">
      <div class="v-money-mv-concept"><span class="chip">${esc(label)}</span>${m.future ? '<span class="badge gray">Programado</span>' : ''}</div>
      ${desc}
    </td>
    <td class="amount ${m.amount < 0 ? 'expense' : 'income'}">${esc(moneySigned(m.amount))}</td>
    <td class="num right nowrap ${m.running_balance < 0 ? 'red' : ''}">${esc(money(m.running_balance))}</td>
    <td class="actions">${action}</td>
  </tr>`;
}

async function openMovements(acc: Account): Promise<void> {
  const modal = openModal({ title: `Movimientos · ${acc.name}`, html: loadingState('Cargando movimientos…'), wide: true });
  let seq = 0;

  const paintList = async (): Promise<void> => {
    const my = ++seq;
    let items: AccountMovement[];
    try {
      items = await api.get<AccountMovement[]>(`/api/accounts/${acc.id}/movements`);
    } catch (err) {
      if (my !== seq || !document.contains(modal.body)) return;
      showError(err);
      modal.body.innerHTML = '<p class="error-text">No se pudieron cargar los movimientos.</p>';
      return;
    }
    if (my !== seq || !document.contains(modal.body)) return;
    const current = items.find((m) => !m.future);
    const balance = current ? current.running_balance : acc.balance;
    const futureCount = items.filter((m) => m.future).length;
    modal.body.innerHTML = `<div class="v-money-mv">
      <div class="v-money-mv-head">
        <div>
          <div class="stat-label">Saldo a hoy</div>
          <div class="v-money-mv-balance num ${balance < 0 ? 'red' : 'white'}">${esc(money(balance))}</div>
        </div>
        <div class="muted small right">${esc(bankLabel(acc))} · ${esc(ACCOUNT_KIND_LABELS[acc.kind] ?? acc.kind)}<br />Desde ${esc(fmtDate(acc.opening_date))}</div>
      </div>
      ${futureCount > 0 ? `<p class="tip mb">${esc(plural(futureCount, 'movimiento programado', 'movimientos programados'))} con fecha futura: aún no cuenta${futureCount === 1 ? '' : 'n'} en el saldo.</p>` : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Concepto</th><th class="amount">Monto</th><th class="right">Saldo</th><th></th></tr></thead>
        <tbody>${items.map(movementRowHtml).join('')}</tbody>
      </table></div>
      ${items.length <= 1 ? '<p class="muted small mt">Aún no hay movimientos con esta cuenta. Elige la cuenta al registrar ingresos, gastos o pagos, o usa Transferir y Ajustar saldo.</p>' : ''}
    </div>`;
  };

  const afterDelete = async (msg: string): Promise<void> => {
    toast(msg);
    await Promise.all([paintList(), load('all')]);
  };

  on(modal.body, 'click', '[data-goto]', (el, ev) => {
    ev.preventDefault();
    const href = el.getAttribute('href');
    modal.close();
    if (href) location.hash = href;
  });
  on(modal.body, 'click', '[data-del-adjust]', async (el) => {
    const id = el.dataset.delAdjust;
    if (!id) return;
    const ok = await confirmDialog('Se eliminará este ajuste de saldo y el saldo de la cuenta cambiará.', { title: 'Eliminar ajuste', okLabel: 'Eliminar ajuste' });
    if (!ok) return;
    try {
      await api.del(`/api/accounts/${acc.id}/adjustments/${id}`);
      await afterDelete('Ajuste eliminado');
    } catch (err) {
      showError(err);
    }
  });
  on(modal.body, 'click', '[data-del-transfer]', async (el) => {
    const id = el.dataset.delTransfer;
    if (!id) return;
    const ok = await confirmDialog('Se eliminará la transferencia de ambas cuentas y sus saldos cambiarán.', { title: 'Eliminar transferencia', okLabel: 'Eliminar transferencia' });
    if (!ok) return;
    try {
      await api.del(`/api/accounts/transfers/${id}`);
      await afterDelete('Transferencia eliminada');
    } catch (err) {
      showError(err);
    }
  });

  await paintList();
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------
async function deleteAccount(acc: Account): Promise<void> {
  const ok = await confirmDialog(DELETE_ACCOUNT_MSG, { title: `Eliminar "${acc.name}"`, okLabel: 'Eliminar cuenta' });
  if (!ok) return;
  try {
    await api.del(`/api/accounts/${acc.id}`);
    toast('Cuenta eliminada');
    await load('all');
  } catch (err) {
    showError(err);
  }
}

async function restoreAccount(acc: Account): Promise<void> {
  try {
    const body: Partial<AccountInput> = { archived: false };
    await api.put<Account>(`/api/accounts/${acc.id}`, body);
    toast('Cuenta restaurada');
    await load('all');
  } catch (err) {
    showError(err);
  }
}
