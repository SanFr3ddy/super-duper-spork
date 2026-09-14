/**
 * Vista "Ahorros": metas de ahorro con aportes/retiros, progreso y gráfica de ahorro mensual.
 */
import type { SavingsGoal, SavingsGoalInput, GoalContribution, GoalContributionInput } from '../../../shared/types';
import { api } from '../api';
import { esc, money, moneySigned, pct, fmtDate, daysUntil, todayISO, currentYear } from '../format';
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
  on,
  toNumber,
} from '../ui';
import { monthlyBars, destroyChart, hexToRgba, COLORS } from '../charts';

const DEFAULT_COLOR = '#e5202e';
const HEX_RE = /^#[0-9a-f]{6}$/i;

let viewRoot: HTMLElement | null = null;
let goals: SavingsGoal[] = [];
let chartCanvas: HTMLCanvasElement | null = null;
/** Se incrementa en cada pintado; las continuaciones async comprueban que siguen vigentes. */
let paintToken = 0;
/** Se incrementa en cada render/recarga y en destroy(); una respuesta vieja no pinta sobre otra vista. */
let loadToken = 0;

const STYLE = `<style>
  .v-goals .grid > .card { margin-top: 0; }
  .v-goals .v-goal { border-top: 3px solid var(--goal-color, var(--red)); display: flex; flex-direction: column; gap: 10px; }
  .v-goals .v-goal-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .v-goals .v-goal-head .grow { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .v-goals .v-goal-head h3 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .v-goals .v-goal-amount { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; overflow-wrap: anywhere; }
  .v-goals .v-goal-meter { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; }
  .v-goals .v-goal .kv { margin: 2px 0 0; }
  .v-goals .v-goal-actions { margin-top: auto; padding-top: 6px; }
  .v-goals .stat .progress { margin-top: 4px; }
  .v-goals .tip a { color: var(--white); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
  .v-goals-check { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 0.9rem; cursor: pointer; user-select: none; }
  .v-goals-check input { width: 16px; height: 16px; margin: 0; accent-color: var(--red); cursor: pointer; }
</style>`;

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
export async function render(root: HTMLElement): Promise<void> {
  viewRoot = root;

  const actions = document.getElementById('topbar-actions');
  if (actions) {
    actions.innerHTML = '<button type="button" class="btn primary" id="goals-new">+ Nueva meta</button>';
    actions.querySelector('#goals-new')?.addEventListener('click', () => openGoalForm());
  }

  root.innerHTML = loadingState('Cargando metas…');
  const my = ++loadToken;
  try {
    const data = await api.get<SavingsGoal[]>('/api/goals');
    if (my !== loadToken || viewRoot !== root) return;
    goals = data;
  } catch (err) {
    if (my !== loadToken || viewRoot !== root) return;
    showError(err);
    root.innerHTML = `<div class="card">
      <p class="error-text">No se pudieron cargar las metas de ahorro.</p>
      <p class="muted small">${esc(err instanceof Error ? err.message : '')}</p>
      <div class="form-actions"><button type="button" class="btn" data-retry>Reintentar</button></div>
    </div>`;
    root.querySelector('[data-retry]')?.addEventListener('click', () => void render(root));
    return;
  }
  paint();
}

export function destroy(): void {
  loadToken++;
  paintToken++;
  destroyChart(chartCanvas);
  chartCanvas = null;
  viewRoot = null;
  goals = [];
}

async function reload(): Promise<void> {
  const root = viewRoot;
  if (!root) return;
  const my = ++loadToken;
  try {
    const data = await api.get<SavingsGoal[]>('/api/goals');
    if (my !== loadToken || viewRoot !== root) return;
    goals = data;
    paint();
  } catch (err) {
    if (my !== loadToken || viewRoot !== root) return;
    showError(err);
  }
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------
function paint(): void {
  const root = viewRoot;
  if (!root) return;
  destroyChart(chartCanvas);
  chartCanvas = null;
  const token = ++paintToken;

  const totalSaved = goals.reduce((a, g) => a + g.saved_total, 0);
  const totalTarget = goals.reduce((a, g) => a + g.target_amount, 0);
  const globalProgress = totalTarget > 0 ? totalSaved / totalTarget : 0;
  const completedCount = goals.filter((g) => g.completed).length;
  const pendingCount = goals.length - completedCount;
  const year = currentYear();

  root.innerHTML = `${STYLE}<div class="v-goals stack">
    <div class="grid grid-4">
      <div class="stat">
        <div class="stat-label">Total ahorrado</div>
        <div class="stat-value white">${esc(money(totalSaved))}</div>
        <div class="stat-foot">${goals.length ? `en ${goals.length} meta${goals.length === 1 ? '' : 's'}` : 'Sin metas todavía'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Meta total</div>
        <div class="stat-value">${esc(money(totalTarget))}</div>
        <div class="stat-foot">Faltan ${esc(money(Math.max(0, totalTarget - totalSaved)))}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Progreso global</div>
        <div class="stat-value">${esc(pct(globalProgress))}</div>
        ${progressBar(globalProgress, { white: true })}
      </div>
      <div class="stat">
        <div class="stat-label">Metas completadas</div>
        <div class="stat-value">${completedCount} de ${goals.length}</div>
        <div class="stat-foot">${goals.length ? `${pendingCount} en curso` : '—'}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Ahorro por mes <span class="sub">${year}</span></h2></div>
      <div data-chart>${loadingState()}</div>
    </div>

    <div class="tip">Tus metas son objetivos de ahorro. Tu dinero real, y en qué banco está, lo ves en <a href="#/dinero">Mi dinero</a>. Los aportes a tus metas siguen contando como Ahorro en el resumen mensual.</div>

    ${
      goals.length
        ? `<div class="grid grid-auto">${goals.map(goalCard).join('')}</div>`
        : emptyState(
            '🎯',
            'Aún no tienes metas de ahorro',
            'Define un objetivo, ponle fecha y registra tus aportes para ver el avance.',
            '<button type="button" class="btn primary" data-new>Crear mi primera meta</button>',
          )
    }
  </div>`;

  const wrap = root.querySelector<HTMLElement>('.v-goals');
  if (!wrap) return;
  bind(wrap);
  const chartBox = wrap.querySelector<HTMLElement>('[data-chart]');
  if (chartBox) void paintChart(chartBox, year, token);
}

function goalCard(g: SavingsGoal): string {
  const color = HEX_RE.test(g.color) ? g.color : DEFAULT_COLOR;

  let deadlineHtml = '<span class="muted">—</span>';
  if (g.deadline) {
    const days = daysUntil(g.deadline);
    let hint = '';
    if (!g.completed) {
      if (days < 0) hint = ' <span class="red">· vencida</span>';
      else if (days === 0) hint = ' <span class="muted">· hoy</span>';
      else hint = ` <span class="muted">· en ${days} día${days === 1 ? '' : 's'}</span>`;
    }
    deadlineHtml = `<span class="nowrap">${esc(fmtDate(g.deadline))}</span>${hint}`;
  }

  return `<div class="card v-goal" style="--goal-color:${color}">
    <div class="v-goal-head">
      <div class="icon-box" style="border-color:${hexToRgba(color, 0.55)};background:${hexToRgba(color, 0.16)}">${esc(g.icon || '🎯')}</div>
      <div class="grow">
        <h3 title="${esc(g.name)}">${esc(g.name)}</h3>
        ${g.completed ? '<span class="badge white">Completada</span>' : ''}
      </div>
    </div>
    <div>
      <div class="v-goal-amount white num">${esc(money(g.saved_total))}</div>
      <div class="muted small">de ${esc(money(g.target_amount))}</div>
    </div>
    <div>
      ${progressBar(g.progress, { white: true, lg: true })}
      <div class="v-goal-meter small">
        <span class="white bold num">${esc(pct(g.progress))}</span>
        <span class="muted num">${g.completed ? 'Objetivo alcanzado' : `Faltan ${esc(money(g.remaining))}`}</span>
      </div>
    </div>
    <dl class="kv">
      <dt>Fecha límite</dt><dd>${deadlineHtml}</dd>
      <dt>Aporte mensual sugerido</dt><dd class="num">${g.monthly_needed !== null && g.monthly_needed !== undefined ? esc(money(g.monthly_needed)) : '<span class="muted">—</span>'}</dd>
      <dt>Aportes</dt><dd class="num">${g.contributions_count}</dd>
    </dl>
    <div class="row v-goal-actions">
      <button type="button" class="btn primary sm" data-contribute="${g.id}">Aportar</button>
      <button type="button" class="btn sm" data-history="${g.id}">Historial</button>
      <button type="button" class="btn ghost sm" data-edit="${g.id}">Editar</button>
      <button type="button" class="btn danger sm icon" data-delete="${g.id}" aria-label="Eliminar meta" title="Eliminar meta">🗑</button>
    </div>
  </div>`;
}

function bind(wrap: HTMLElement): void {
  on(wrap, 'click', '[data-new]', () => openGoalForm());
  on(wrap, 'click', '[data-contribute]', (el) => {
    const g = findGoal(el.dataset.contribute);
    if (g) openContributionForm(g);
  });
  on(wrap, 'click', '[data-history]', (el) => {
    const g = findGoal(el.dataset.history);
    if (g) void openHistory(g);
  });
  on(wrap, 'click', '[data-edit]', (el) => {
    const g = findGoal(el.dataset.edit);
    if (g) openGoalForm(g);
  });
  on(wrap, 'click', '[data-delete]', (el) => {
    const g = findGoal(el.dataset.delete);
    if (g) void deleteGoal(g);
  });
}

function findGoal(id: string | undefined): SavingsGoal | undefined {
  if (!id) return undefined;
  return goals.find((g) => String(g.id) === id);
}

// ---------------------------------------------------------------------------
// Gráfica: ahorro neto (aportes - retiros) por mes del año actual
// ---------------------------------------------------------------------------
async function paintChart(box: HTMLElement, year: number, token: number): Promise<void> {
  const noData = (): void => {
    box.innerHTML = emptyState('📈', `Sin aportes en ${year}`, 'Cuando registres aportes verás aquí tu ahorro mes a mes.');
  };
  if (!goals.length) {
    noData();
    return;
  }

  let lists: GoalContribution[][];
  try {
    lists = await Promise.all(goals.map((g) => api.get<GoalContribution[]>(`/api/goals/${g.id}/contributions`)));
  } catch (err) {
    if (token !== paintToken) return;
    showError(err);
    box.innerHTML = '<p class="error-text">No se pudo cargar el ahorro mensual.</p>';
    return;
  }
  if (token !== paintToken || !document.contains(box)) return;

  const prefix = `${year}-`;
  const totals: number[] = new Array<number>(12).fill(0);
  let count = 0;
  for (const list of lists) {
    for (const c of list) {
      if (!c.date.startsWith(prefix)) continue;
      const m = Number(c.date.slice(5, 7));
      if (m >= 1 && m <= 12) {
        totals[m - 1] += Number(c.amount) || 0;
        count++;
      }
    }
  }
  if (count === 0) {
    noData();
    return;
  }

  box.innerHTML = '<div class="chart-box"><canvas aria-label="Ahorro por mes"></canvas></div>';
  const canvas = box.querySelector('canvas');
  if (!canvas) return;
  chartCanvas = canvas;
  monthlyBars(canvas, [{ label: 'Ahorro', data: totals.map((v) => Math.round(v * 100) / 100), color: COLORS.savings }]);
}

// ---------------------------------------------------------------------------
// Formularios y acciones
// ---------------------------------------------------------------------------
function openGoalForm(g?: SavingsGoal): void {
  formModal({
    title: g ? 'Editar meta' : 'Nueva meta de ahorro',
    submitLabel: g ? 'Guardar cambios' : 'Crear meta',
    html: `<form class="form">
      ${field('Nombre', input('name', { value: g?.name ?? '', placeholder: 'Fondo de emergencia', required: true }))}
      <div class="form-row">
        ${field('Monto objetivo', moneyInput('target_amount', g?.target_amount ?? null))}
        ${field('Fecha límite', input('deadline', { type: 'date', value: g?.deadline ?? '' }), 'Opcional')}
      </div>
      <div class="form-row">
        ${field('Color', `<input type="color" name="color" value="${esc(HEX_RE.test(g?.color ?? '') ? g!.color : DEFAULT_COLOR)}" />`)}
        ${field('Icono', `<input type="text" name="icon" maxlength="32" value="${esc(g?.icon ?? '')}" placeholder="🎯" autocomplete="off" />`, 'Un emoji, opcional')}
      </div>
    </form>`,
    onSubmit: async (v, _form, modal) => {
      const name = (v.name ?? '').trim();
      if (!name) throw new Error('El nombre es obligatorio');
      const target = toNumber(v.target_amount ?? '', 'monto objetivo');
      if (!(target > 0)) throw new Error('El monto objetivo debe ser mayor a 0');
      const icon = (v.icon ?? '').trim();
      const body: SavingsGoalInput = {
        name,
        target_amount: target,
        deadline: v.deadline ? v.deadline : null,
        color: HEX_RE.test(v.color ?? '') ? v.color : DEFAULT_COLOR,
        icon: icon ? icon : null,
      };
      if (g) await api.put<SavingsGoal>(`/api/goals/${g.id}`, body);
      else await api.post<SavingsGoal>('/api/goals', body);
      modal.close();
      toast(g ? 'Meta actualizada' : 'Meta creada');
      await reload();
    },
  });
}

function openContributionForm(g: SavingsGoal): void {
  const suggested = g.monthly_needed !== null && g.monthly_needed !== undefined ? g.monthly_needed : null;
  formModal({
    title: `Aportar a ${g.name}`,
    submitLabel: 'Registrar',
    html: `<form class="form">
      <div class="form-row">
        ${field('Monto', moneyInput('amount', suggested), suggested !== null ? `Sugerido: ${money(suggested)} al mes` : undefined)}
        ${field('Fecha', input('date', { type: 'date', value: todayISO(), required: true }))}
      </div>
      ${field('Nota', input('note', { placeholder: 'Opcional' }))}
      <label class="v-goals-check"><input type="checkbox" name="withdraw" /> Es un retiro (resta de lo ahorrado)</label>
    </form>`,
    onSubmit: async (v, _form, modal) => {
      const raw = toNumber(v.amount ?? '', 'monto');
      if (!(raw > 0)) throw new Error('El monto debe ser mayor a 0');
      if (!v.date) throw new Error('La fecha es obligatoria');
      const withdraw = v.withdraw === 'on';
      const body: GoalContributionInput = {
        amount: withdraw ? -raw : raw,
        date: v.date,
        note: (v.note ?? '').trim(),
      };
      await api.post<GoalContribution>(`/api/goals/${g.id}/contributions`, body);
      modal.close();
      toast(withdraw ? 'Retiro registrado' : 'Aporte registrado');
      await reload();
    },
  });
}

async function openHistory(g: SavingsGoal): Promise<void> {
  const modal = openModal({ title: `Historial · ${g.name}`, html: loadingState(), wide: true });

  const paintHistory = async (): Promise<void> => {
    let items: GoalContribution[];
    try {
      items = await api.get<GoalContribution[]>(`/api/goals/${g.id}/contributions`);
    } catch (err) {
      showError(err);
      modal.body.innerHTML = '<p class="error-text">No se pudo cargar el historial.</p>';
      return;
    }
    if (!document.contains(modal.body)) return;
    if (items.length === 0) {
      modal.body.innerHTML = emptyState('💸', 'Sin aportes todavía', 'Registra tu primer aporte desde la tarjeta de la meta.');
      return;
    }
    const total = items.reduce((a, c) => a + (Number(c.amount) || 0), 0);
    modal.body.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Nota</th><th class="amount">Monto</th><th></th></tr></thead>
      <tbody>${items
        .map(
          (c) => `<tr>
            <td class="nowrap">${esc(fmtDate(c.date))}</td>
            <td>${c.note ? esc(c.note) : '<span class="muted">—</span>'}</td>
            <td class="amount ${c.amount < 0 ? 'expense' : 'income'}">${esc(moneySigned(c.amount))}</td>
            <td class="actions"><button type="button" class="btn ghost sm icon" data-del-contrib="${c.id}" aria-label="Eliminar movimiento" title="Eliminar">🗑</button></td>
          </tr>`,
        )
        .join('')}</tbody>
      <tfoot><tr>
        <td colspan="2" class="muted">Total ahorrado</td>
        <td class="amount white">${esc(money(total))}</td>
        <td></td>
      </tr></tfoot>
    </table></div>`;
  };

  on(modal.body, 'click', '[data-del-contrib]', async (el) => {
    const contributionId = el.dataset.delContrib;
    if (!contributionId) return;
    const ok = await confirmDialog('Se eliminará este movimiento de la meta.', { title: 'Eliminar movimiento' });
    if (!ok) return;
    try {
      await api.del(`/api/goals/${g.id}/contributions/${contributionId}`);
      toast('Movimiento eliminado');
      await paintHistory();
      await reload();
    } catch (err) {
      showError(err);
    }
  });

  await paintHistory();
}

async function deleteGoal(g: SavingsGoal): Promise<void> {
  const ok = await confirmDialog('Se eliminará la meta y todos sus aportes.', { title: `Eliminar "${g.name}"`, okLabel: 'Eliminar meta' });
  if (!ok) return;
  try {
    await api.del(`/api/goals/${g.id}`);
    toast('Meta eliminada');
    await reload();
  } catch (err) {
    showError(err);
  }
}
