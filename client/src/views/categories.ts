/**
 * Vista "Categorías": listas de gasto e ingreso con alta, edición y borrado.
 */
import type { Category, CategoryInput, TxType } from '../../../shared/types';
import { api } from '../api';
import { esc } from '../format';
import { formModal, confirmDialog, toast, showError, field, input, emptyState, loadingState, on } from '../ui';

/** Rampa de la marca (rojos ordinales + neutros) para sugerir colores. */
const RAMP = ['#9e1220', '#c9192a', '#ec2d3c', '#f3646f', '#f79aa1', '#fbc8cc', '#e0e0e0', '#bdbdbd', '#8a8a8a', '#5e5e5e'];

let categories: Category[] = [];
let wrap: HTMLElement | null = null;

const STYLE = `<style>
  .v-cat .grid > .card { margin-top: 0; }
  .v-cat .list-item .acts { display: flex; gap: 2px; flex: none; }
  .v-cat .list-item .name { display: flex; align-items: center; gap: 8px; }
  .v-cat-form .v-cat-color-row { display: flex; align-items: center; gap: 10px; }
  .v-cat-form .v-cat-swatches { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .v-cat-form .v-cat-swatch { width: 26px; height: 26px; border-radius: 7px; border: 2px solid transparent; cursor: pointer; padding: 0; box-shadow: 0 0 0 1px var(--border-strong); }
  .v-cat-form .v-cat-swatch.active { border-color: var(--white); }
</style>`;

export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `${STYLE}<div class="v-cat">
    <div class="tip mb">Los colores de las categorías se usan en las gráficas del resumen y en los chips de la lista de movimientos. Elige tonos distintos para diferenciarlas de un vistazo.</div>
    <div class="grid grid-2">
      ${columnHtml('expense', 'Gastos')}
      ${columnHtml('income', 'Ingresos')}
    </div>
  </div>`;
  wrap = root.querySelector<HTMLElement>('.v-cat');
  if (!wrap) return;
  const view = wrap;

  mountTopbar();

  on(view, 'click', '[data-add]', (el) => openCatForm(undefined, el.dataset.add === 'income' ? 'income' : 'expense'));
  on(view, 'click', '[data-edit]', (el) => {
    const cat = categories.find((c) => c.id === Number(el.dataset.edit));
    if (cat) openCatForm(cat);
  });
  on(view, 'click', '[data-del]', (el) => void deleteCat(Number(el.dataset.del)));

  await load();
}

export function destroy(): void {
  wrap = null;
}

function columnHtml(type: TxType, title: string): string {
  return `<div class="card" data-col="${type}">
    <div class="card-head">
      <h2>${esc(title)} <span class="sub" data-count></span></h2>
      <button type="button" class="btn sm" data-add="${type}">+ Agregar</button>
    </div>
    <div data-list>${loadingState()}</div>
  </div>`;
}

function mountTopbar(): void {
  const actions = document.getElementById('topbar-actions');
  if (!actions) return;
  actions.innerHTML = `<button type="button" class="btn primary" data-new-cat>+ Nueva categoría</button>`;
  actions.querySelector('[data-new-cat]')!.addEventListener('click', () => openCatForm());
}

async function load(): Promise<void> {
  const view = wrap;
  if (!view) return;
  try {
    const list = await api.get<Category[]>('/api/categories');
    if (wrap !== view) return;
    categories = list;
    renderColumn(view, 'expense');
    renderColumn(view, 'income');
  } catch (err) {
    if (wrap !== view) return;
    showError(err);
    view.querySelectorAll<HTMLElement>('[data-list]').forEach((el) => {
      el.innerHTML = `<p class="error-text">No se pudieron cargar las categorías.</p>`;
    });
  }
}

function renderColumn(view: HTMLElement, type: TxType): void {
  const col = view.querySelector<HTMLElement>(`[data-col="${type}"]`);
  if (!col) return;
  const list = categories.filter((c) => c.type === type);
  const count = col.querySelector<HTMLElement>('[data-count]');
  if (count) count.textContent = String(list.length);
  const target = col.querySelector<HTMLElement>('[data-list]')!;
  if (!list.length) {
    target.innerHTML = emptyState(
      '🏷️',
      type === 'expense' ? 'Sin categorías de gasto' : 'Sin categorías de ingreso',
      'Crea una para clasificar tus movimientos.',
      `<button type="button" class="btn primary sm" data-add="${type}">+ Agregar</button>`,
    );
    return;
  }
  target.innerHTML = `<div class="list">${list.map(itemHtml).join('')}</div>`;
}

function itemHtml(c: Category): string {
  const color = esc(c.color);
  return `<div class="list-item">
    <div class="icon-box">${c.icon ? esc(c.icon) : `<span class="dot" style="background:${color}"></span>`}</div>
    <div class="grow">
      <div class="name">${esc(c.name)}</div>
      <div class="meta"><span class="chip"><span class="dot" style="background:${color}"></span>${color}</span></div>
    </div>
    <div class="acts">
      <button type="button" class="btn ghost sm icon" data-edit="${c.id}" aria-label="Editar" title="Editar">✎</button>
      <button type="button" class="btn ghost sm icon" data-del="${c.id}" aria-label="Eliminar" title="Eliminar">🗑</button>
    </div>
  </div>`;
}

/** Sugiere el primer color de la rampa que no use ninguna categoría del mismo tipo. */
function suggestColor(type: TxType): string {
  const same = categories.filter((c) => c.type === type);
  const used = new Set(same.map((c) => c.color.toLowerCase()));
  return RAMP.find((c) => !used.has(c)) ?? RAMP[same.length % RAMP.length];
}

function openCatForm(existing?: Category, presetType?: TxType): void {
  const type: TxType = existing?.type ?? presetType ?? 'expense';
  const initialColor = (existing?.color ?? suggestColor(type)).toLowerCase();
  const html = `<form class="form v-cat-form">
    ${field('Nombre', input('name', { value: existing?.name ?? '', placeholder: 'p. ej. Mascotas', required: true }))}
    <div class="field">
      <label>Tipo</label>
      <div class="segmented" data-seg role="group" aria-label="Tipo">
        <button type="button" data-type="expense" class="${type === 'expense' ? 'active expense' : ''}">Gasto</button>
        <button type="button" data-type="income" class="${type === 'income' ? 'active income' : ''}">Ingreso</button>
      </div>
      <input type="hidden" name="type" value="${type}" />
    </div>
    <div class="form-row">
      <div class="field">
        <label>Color</label>
        <div class="v-cat-color-row">
          <input type="color" name="color" value="${initialColor}" aria-label="Color" />
          <span class="muted small num" data-color-hex>${initialColor}</span>
        </div>
        <div class="v-cat-swatches" data-swatches>
          ${RAMP.map((c) => `<button type="button" class="v-cat-swatch ${c === initialColor ? 'active' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}" title="${c}"></button>`).join('')}
        </div>
      </div>
      ${field(
        'Icono',
        `<input type="text" name="icon" value="${esc(existing?.icon ?? '')}" placeholder="Emoji, p. ej. 🍔" maxlength="32" autocomplete="off" />`,
        'Opcional. Se muestra junto al nombre.',
      )}
    </div>
  </form>`;

  formModal({
    title: existing ? 'Editar categoría' : 'Nueva categoría',
    html,
    submitLabel: existing ? 'Guardar cambios' : 'Crear',
    onOpen(form) {
      const seg = form.querySelector<HTMLElement>('[data-seg]')!;
      const hidden = form.querySelector<HTMLInputElement>('input[name=type]')!;
      const colorInput = form.querySelector<HTMLInputElement>('input[name=color]')!;
      const hexLabel = form.querySelector<HTMLElement>('[data-color-hex]')!;
      const swatches = form.querySelector<HTMLElement>('[data-swatches]')!;
      let colorTouched = !!existing;

      const setColor = (hex: string): void => {
        const v = hex.toLowerCase();
        colorInput.value = v;
        hexLabel.textContent = v;
        swatches.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === v));
      };

      seg.querySelectorAll<HTMLButtonElement>('button[data-type]').forEach((b) =>
        b.addEventListener('click', () => {
          const t: TxType = b.dataset.type === 'income' ? 'income' : 'expense';
          if (hidden.value === t) return;
          hidden.value = t;
          seg.querySelectorAll<HTMLButtonElement>('button').forEach((x) => (x.className = x === b ? `active ${t}` : ''));
          if (!colorTouched) setColor(suggestColor(t));
        }),
      );
      swatches.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) =>
        b.addEventListener('click', () => {
          colorTouched = true;
          setColor(b.dataset.color ?? initialColor);
        }),
      );
      colorInput.addEventListener('input', () => {
        colorTouched = true;
        setColor(colorInput.value);
      });
    },
    async onSubmit(values, _form, modal) {
      const name = (values.name ?? '').trim();
      if (!name) throw new Error('El nombre es obligatorio');
      const body: CategoryInput = {
        name,
        type: values.type === 'income' ? 'income' : 'expense',
        color: (values.color ?? '').toLowerCase() || undefined,
        icon: (values.icon ?? '').trim() || null,
      };
      if (existing) await api.put<Category>(`/api/categories/${existing.id}`, body);
      else await api.post<Category>('/api/categories', body);
      modal.close();
      toast(existing ? 'Categoría actualizada' : 'Categoría creada');
      await load();
    },
  });
}

async function deleteCat(id: number): Promise<void> {
  const cat = categories.find((c) => c.id === id);
  if (!cat) return;
  const ok = await confirmDialog(
    `¿Eliminar la categoría "${cat.name}"? Los movimientos de esta categoría se conservarán sin categoría y sus presupuestos se eliminarán.`,
    { title: 'Eliminar categoría' },
  );
  if (!ok) return;
  try {
    await api.del(`/api/categories/${id}`);
    toast('Categoría eliminada');
    await load();
  } catch (err) {
    showError(err);
  }
}
