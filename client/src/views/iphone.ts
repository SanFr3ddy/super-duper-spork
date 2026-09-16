/**
 * Vista "iPhone y Atajos": registrar gastos desde el iPhone sin abrir la web.
 *  1. Tokens de la API rápida (crear, ver y revocar; el token completo se muestra UNA vez).
 *  2. Prueba del token contra /api/quick/summary (sin cookies, para probar el token de verdad).
 *  3. Receta paso a paso para la app Atajos de iOS (gasto y resumen diario), con valores copiables.
 *  4. Instalación como app (PWA: manifest.webmanifest + apple-touch-icon en client/public).
 * Contrato: sección "Registro rápido desde fuera de la web" de shared/types.ts.
 * API: /api/tokens (sesión) y /api/quick/* (token Bearer; también acepta sesión).
 * El token solo se guarda en este dispositivo si el usuario marca "Recordar en este dispositivo" (localStorage).
 */
import type { ApiToken, ApiTokenCreated, QuickOptions, QuickResult } from '../../../shared/types';
import { api } from '../api';
import { esc, settings } from '../format';
import { formModal, openModal, confirmDialog, toast, showError, field, emptyState, loadingState, on } from '../ui';

const STORAGE_KEY = 'fin_quick_token';
const TOKEN_PLACEHOLDER = 'TU_TOKEN';
/** Render gratis puede tardar hasta un minuto en despertar. */
const TEST_TIMEOUT_MS = 90_000;
/** Formato de los tokens que genera server/apiTokens.ts (solo para dar una pista si falla la prueba). */
const FULL_TOKEN_RE = /^fin_[A-Za-z0-9_-]{43}$/;
/** Máximo de nombres a mostrar por lista de opciones. */
const MAX_OPTION_CHIPS = 40;

let tokens: ApiToken[] = [];
/** Se incrementan en cada carga y en destroy(); una respuesta vieja no pinta sobre otra vista. */
let listSeq = 0;
let testSeq = 0;
let optionsSeq = 0;
let testAbort: AbortController | null = null;

const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`;

const STYLE = `<style>
.v-ios .grid > .card, .v-ios .card + .card { margin-top: 0; }
.v-ios .card { min-width: 0; }
.v-ios .card-head h2 { gap: 10px; }
.v-ios .v-ios-lead { color: var(--text-2); font-size: .9rem; margin-bottom: 12px; }
.v-ios-step { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: var(--red); color: #fff; font-size: .88rem; font-weight: 800; flex: none; }
.v-ios-code { font-family: ${MONO}; font-size: .84em; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; color: var(--white); overflow-wrap: anywhere; }
.v-ios-mono { font-family: ${MONO}; }
.v-ios-copy { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; vertical-align: middle; margin: 2px 0; }
.v-ios-copy .v-ios-code { min-width: 0; }
.v-ios .v-ios-copy .btn.sm { padding: 3px 9px; font-size: .78rem; flex: none; }
.v-ios .btn.v-ios-copied, .v-ios-created .btn.v-ios-copied { border-color: var(--white); color: var(--white); background: var(--surface-3); }
.v-ios .list-item { gap: 10px; }
.v-ios .v-ios-tk .meta { overflow-wrap: anywhere; }
.v-ios .v-ios-tk .btn { flex: none; }
.v-ios-check { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: .9rem; cursor: pointer; user-select: none; }
.v-ios-check input { width: 16px; height: 16px; margin: 0; accent-color: var(--red); cursor: pointer; }
.v-ios-test { display: grid; gap: 12px; }
.v-ios-test .row { justify-content: space-between; }
.v-ios-result { margin-top: 14px; border: 1px solid var(--border); border-left: 3px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-2); padding: 12px 14px; font-size: .92rem; }
.v-ios-result.ok { border-left-color: var(--white); }
.v-ios-result.error { border-left-color: var(--red); }
.v-ios-result.loading { color: var(--muted); }
.v-ios-result-title { font-size: .8rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
.v-ios-result.error .v-ios-result-title { color: var(--red); }
.v-ios-result-text { white-space: pre-line; overflow-wrap: anywhere; color: var(--text); }
.v-ios-steps { list-style: none; counter-reset: ios; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 18px; }
.v-ios-steps > li { counter-increment: ios; position: relative; padding-left: 40px; min-width: 0; }
.v-ios-steps > li::before { content: counter(ios); position: absolute; left: 0; top: -1px; width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--red-border); background: var(--red-soft); color: var(--white); font-weight: 700; font-size: .85rem; display: grid; place-items: center; }
.v-ios-steps h3 { font-size: .98rem; line-height: 1.6; margin-bottom: 4px; }
.v-ios-steps h3 .badge { margin-left: 6px; vertical-align: 2px; }
.v-ios-steps p { color: var(--text-2); font-size: .9rem; }
.v-ios-steps p + p { margin-top: 6px; }
.v-ios-sub { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; color: var(--text-2); font-size: .9rem; }
.v-ios-sub li { min-width: 0; }
.v-ios-steps b, .v-ios-sub b, .v-ios-install b { color: var(--white); font-weight: 600; }
.v-ios-fields { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.v-ios-fields li { display: flex; align-items: center; gap: 4px 8px; flex-wrap: wrap; font-size: .88rem; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; min-width: 0; }
.v-ios-fields li > span:last-child { min-width: 0; overflow-wrap: anywhere; }
.v-ios-json-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 12px 0 6px; }
.v-ios-json { background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 12px 14px; margin: 0; overflow-x: auto; font-family: ${MONO}; font-size: .84rem; line-height: 1.55; color: var(--text); white-space: pre; }
.v-ios-opts { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.v-ios-opts .label { display: block; margin-bottom: 6px; }
.v-ios-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.v-ios .v-ios-chip { cursor: pointer; font: inherit; font-size: .8rem; white-space: normal; text-align: left; overflow-wrap: anywhere; max-width: 100%; }
.v-ios .v-ios-chip:hover { border-color: var(--border-strong); color: var(--text); }
.v-ios-tips { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
.v-ios-tip-red { border-left-color: var(--red); }
.v-ios-recipe { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--border); }
.v-ios-recipe > h3 { margin-bottom: 4px; }
.v-ios-recipe > p { color: var(--text-2); font-size: .9rem; margin-bottom: 14px; }
.v-ios-install { display: flex; flex-direction: column; gap: 12px; color: var(--text-2); font-size: .92rem; }
.v-ios-install .v-ios-platform { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; }
.v-ios-install .v-ios-platform h3 { color: var(--text); margin-bottom: 4px; font-size: .95rem; }
.v-ios-created { display: flex; flex-direction: column; gap: 12px; }
.v-ios-created .v-ios-warn { color: var(--red); font-weight: 700; }
.v-ios-created .v-ios-secret { font-family: ${MONO}; background: var(--bg); border: 1px dashed var(--red-border); border-radius: var(--radius-sm); padding: 12px 14px; word-break: break-all; user-select: all; -webkit-user-select: all; color: var(--white); font-size: .95rem; line-height: 1.5; }
.v-ios-created .v-ios-created-actions { justify-content: flex-end; }
.v-ios-created .v-ios-created-actions [data-copy-secret] { order: 2; } /* primero en el DOM: recibe el foco (Enter no cierra sin copiar) */
.v-ios-created .v-ios-code { font-family: ${MONO}; font-size: .84em; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; color: var(--white); }
@media (max-width: 480px) {
  .v-ios-steps > li { padding-left: 34px; }
  .v-ios-steps > li::before { width: 24px; height: 24px; font-size: .78rem; top: 1px; }
  .v-ios .v-ios-tk .icon-box { display: none; }
}
</style>`;

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
export async function render(root: HTMLElement): Promise<void> {
  tokens = [];
  const origin = location.origin;
  const remembered = normalizeToken(storedToken());

  root.innerHTML = `<div class="v-ios stack">${STYLE}
    <div class="tip">Registra un gasto en segundos desde tu iPhone —con Siri, un widget, el botón de Acción o el Centro de control— <b class="white">sin abrir la web</b>. Solo necesitas un token, probarlo y crear el Atajo.</div>
    <div class="grid grid-2">
      ${tokenSectionHtml()}
      ${testSectionHtml(remembered)}
    </div>
    ${shortcutSectionHtml(origin)}
    ${installSectionHtml(origin)}
  </div>`;

  const wrap = root.querySelector<HTMLElement>('.v-ios');
  if (!wrap) return;
  bind(wrap);
  syncBearer(wrap);
  void loadOptions(wrap);
  await loadTokens(wrap);
}

export function destroy(): void {
  listSeq++;
  testSeq++;
  optionsSeq++;
  testAbort?.abort();
  testAbort = null;
  tokens = [];
}

function bind(wrap: HTMLElement): void {
  on(wrap, 'click', '[data-create]', () => openCreateForm(wrap));
  on(wrap, 'click', '[data-revoke]', (el) => void revokeToken(wrap, Number(el.dataset.revoke)));
  on(wrap, 'click', '[data-retry-tokens]', () => {
    const box = wrap.querySelector<HTMLElement>('[data-tokens]');
    if (box) box.innerHTML = loadingState('Cargando tokens…');
    void loadTokens(wrap);
  });
  on(wrap, 'click', '[data-copy]', (el) => {
    const target = el.dataset.copySelect ? wrap.querySelector<HTMLElement>(`[data-copy-src="${el.dataset.copySelect}"]`) : null;
    const shown = target ?? el.closest('.v-ios-copy')?.querySelector<HTMLElement>('code') ?? el;
    void copyWithFeedback(el, el.dataset.copy ?? '', () => selectText(shown));
  });
  on(wrap, 'click', '[data-copy-bearer]', (el) => {
    const inp = testInput(wrap);
    const token = currentToken(wrap);
    const shown = el.closest('.v-ios-copy')?.querySelector<HTMLElement>('code') ?? el;
    void copyWithFeedback(el, `Bearer ${token || TOKEN_PLACEHOLDER}`, () => {
      if (token && inp) {
        // El texto visible va recortado: se selecciona el token completo del paso 2.
        inp.focus();
        inp.select();
      } else selectText(shown);
    });
  });

  const form = wrap.querySelector<HTMLFormElement>('[data-test-form]');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    void runTest(wrap);
  });
  const inp = testInput(wrap);
  inp?.addEventListener('input', () => syncBearer(wrap));
  inp?.addEventListener('change', () => {
    if (rememberBox(wrap)?.checked) storeToken(currentToken(wrap));
  });
  rememberBox(wrap)?.addEventListener('change', () => {
    const box = rememberBox(wrap);
    if (!box) return;
    if (box.checked) {
      const token = currentToken(wrap);
      if (token) {
        storeToken(token);
        toast('Token guardado solo en este dispositivo');
      }
    } else {
      storeToken('');
      toast('Token olvidado en este dispositivo');
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Tokens
// ---------------------------------------------------------------------------
function tokenSectionHtml(): string {
  return `<section class="card" aria-labelledby="v-ios-h1">
    <div class="card-head">
      <h2 id="v-ios-h1"><span class="v-ios-step">1</span>Tu token <span class="sub" data-token-count></span></h2>
      <button type="button" class="btn primary sm" data-create>+ Crear token</button>
    </div>
    <p class="v-ios-lead">El token es como una contraseña solo para el registro rápido: permite registrar movimientos y ver tu resumen, pero no abre el resto de la app. Crea uno por teléfono.</p>
    <div data-tokens>${loadingState('Cargando tokens…')}</div>
  </section>`;
}

async function loadTokens(wrap: HTMLElement): Promise<void> {
  const box = wrap.querySelector<HTMLElement>('[data-tokens]');
  if (!box) return;
  const my = ++listSeq;
  try {
    const list = await api.get<ApiToken[]>('/api/tokens');
    if (my !== listSeq || !wrap.isConnected) return;
    tokens = Array.isArray(list) ? list : [];
    box.innerHTML = tokensListHtml();
    const count = wrap.querySelector<HTMLElement>('[data-token-count]');
    if (count) count.textContent = tokens.length ? String(tokens.length) : '';
  } catch (err) {
    if (my !== listSeq || !wrap.isConnected) return;
    box.innerHTML = `<p class="error-text">No se pudieron cargar tus tokens.</p>
      <p class="muted small">${esc(err instanceof Error ? err.message : '')}</p>
      <div class="form-actions"><button type="button" class="btn sm" data-retry-tokens>Reintentar</button></div>`;
  }
}

function tokensListHtml(): string {
  if (!tokens.length) {
    return emptyState(
      '🔑',
      'Aún no tienes tokens',
      'Crea uno para conectar tu iPhone.',
      '<button type="button" class="btn primary sm" data-create>+ Crear token</button>',
    );
  }
  return `<div class="list">${tokens.map(tokenItemHtml).join('')}</div>`;
}

function tokenItemHtml(t: ApiToken): string {
  return `<div class="list-item v-ios-tk">
    <div class="icon-box" aria-hidden="true">🔑</div>
    <div class="grow">
      <div class="name">${esc(t.name)}</div>
      <div class="meta"><code class="v-ios-code">${esc(t.prefix)}…</code> · Creado ${esc(fmtStamp(t.created_at))}</div>
      <div class="meta">${t.last_used_at ? `Último uso: ${esc(fmtStamp(t.last_used_at))}` : 'Aún no se ha usado'}</div>
    </div>
    <button type="button" class="btn danger sm" data-revoke="${esc(t.id)}" aria-label="Revocar el token ${esc(t.name)}">Revocar</button>
  </div>`;
}

function openCreateForm(wrap: HTMLElement): void {
  formModal({
    title: 'Crear token',
    submitLabel: 'Crear token',
    html: `<form class="form">
      ${field(
        'Nombre',
        `<input type="text" name="name" value="iPhone" maxlength="80" required autocomplete="off" placeholder="p. ej. iPhone personal" />`,
        'Para reconocerlo en la lista (p. ej. el teléfono donde lo usarás).',
      )}
      <div class="tip">El token completo se mostrará una sola vez, justo después de crearlo.</div>
    </form>`,
    async onSubmit(values, _form, modal) {
      const name = (values.name ?? '').trim();
      if (!name) throw new Error('El nombre es obligatorio');
      if (name.length > 80) throw new Error('El nombre admite máximo 80 caracteres');
      const created = await api.post<ApiTokenCreated>('/api/tokens', { name });
      modal.close();
      showCreatedToken(created);
      if (wrap.isConnected) {
        // Queda listo en el paso 2 para probarlo (solo en memoria, salvo que "Recordar" esté marcado).
        const inp = testInput(wrap);
        if (inp && created.token) {
          inp.value = created.token;
          if (rememberBox(wrap)?.checked) storeToken(created.token);
          setTestResult(wrap, null);
          syncBearer(wrap);
        }
        await loadTokens(wrap);
      }
    },
  });
}

function showCreatedToken(created: ApiTokenCreated): void {
  const modal = openModal({
    title: 'Tu nuevo token',
    html: `<div class="v-ios-created">
      <p class="v-ios-warn">Guárdalo: no se volverá a mostrar.</p>
      <div class="v-ios-secret" data-secret>${esc(created.token)}</div>
      <div class="row v-ios-created-actions">
        <button type="button" class="btn primary" data-copy-secret>Copiar</button>
        <button type="button" class="btn ghost" data-close>Listo</button>
      </div>
      <p class="text-2 small">Pégalo en tu Atajo en el encabezado <b class="white">Authorization</b>, después de <code class="v-ios-code">Bearer</code> y un espacio. También quedó en la sección 2 (Prueba) para que lo pruebes.</p>
      <p class="muted small">Cualquiera con el token puede registrar movimientos: no lo compartas; revócalo si pierdes el teléfono.</p>
    </div>`,
  });
  const secret = modal.body.querySelector<HTMLElement>('[data-secret]');
  const btn = modal.body.querySelector<HTMLElement>('[data-copy-secret]');
  btn?.addEventListener('click', () => void copyWithFeedback(btn, created.token, () => secret && selectText(secret)));
}

async function revokeToken(wrap: HTMLElement, id: number): Promise<void> {
  const t = tokens.find((x) => x.id === id);
  if (!t) return;
  const ok = await confirmDialog(
    `¿Revocar el token "${t.name}" (${t.prefix}…)? Los Atajos que lo usen dejarán de funcionar al instante. No se puede deshacer.`,
    { title: 'Revocar token', okLabel: 'Revocar' },
  );
  if (!ok) return;
  try {
    await api.del(`/api/tokens/${id}`);
    toast('Token revocado');
    forgetIfMatches(wrap, t.prefix);
    if (wrap.isConnected) await loadTokens(wrap);
  } catch (err) {
    showError(err);
  }
}

/** Si el token de la prueba (o el recordado) es el que se revocó, se olvida. */
function forgetIfMatches(wrap: HTMLElement, prefix: string): void {
  if (!prefix || prefix.length < 6) return;
  if (normalizeToken(storedToken()).startsWith(prefix)) storeToken('');
  if (!wrap.isConnected) return;
  const inp = testInput(wrap);
  if (inp && currentToken(wrap).startsWith(prefix)) {
    inp.value = '';
    const box = rememberBox(wrap);
    if (box) box.checked = false;
    setTestResult(wrap, null);
    syncBearer(wrap);
  }
}

// ---------------------------------------------------------------------------
// 2. Prueba
// ---------------------------------------------------------------------------
function testSectionHtml(remembered: string): string {
  return `<section class="card" aria-labelledby="v-ios-h2">
    <div class="card-head"><h2 id="v-ios-h2"><span class="v-ios-step">2</span>Prueba</h2></div>
    <p class="v-ios-lead">Pega tu token y pruébalo: se consulta tu resumen igual que lo haría el Atajo. No se registra nada.</p>
    <form class="v-ios-test" data-test-form autocomplete="off" novalidate>
      <div class="field">
        <label for="v-ios-token">Token</label>
        <input type="text" id="v-ios-token" class="v-ios-mono" value="${esc(remembered)}" placeholder="Pega aquí tu token" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </div>
      <div class="row">
        <label class="v-ios-check"><input type="checkbox" data-remember ${remembered ? 'checked' : ''} /> Recordar en este dispositivo</label>
        <button type="submit" class="btn primary" data-test-btn>Probar</button>
      </div>
    </form>
    <div class="v-ios-result hidden" data-test-result aria-live="polite"></div>
  </section>`;
}

type TestState = { kind: 'ok' | 'error' | 'loading'; text: string; title?: string };

function setTestResult(wrap: HTMLElement, r: TestState | null): void {
  const el = wrap.querySelector<HTMLElement>('[data-test-result]');
  if (!el) return;
  if (!r) {
    el.className = 'v-ios-result hidden';
    el.innerHTML = '';
    return;
  }
  el.className = `v-ios-result ${r.kind}`;
  el.innerHTML = `${r.title ? `<div class="v-ios-result-title">${esc(r.title)}</div>` : ''}<div class="v-ios-result-text">${esc(r.text)}</div>`;
}

async function runTest(wrap: HTMLElement): Promise<void> {
  const inp = testInput(wrap);
  const btn = wrap.querySelector<HTMLButtonElement>('[data-test-btn]');
  if (!inp || !btn) return;
  const raw = inp.value;
  const token = normalizeToken(raw);
  if (!token) {
    setTestResult(wrap, { kind: 'error', text: 'Pega tu token para probar.' });
    inp.focus();
    return;
  }
  if (!isTokenLike(token)) {
    setTestResult(wrap, { kind: 'error', text: 'El token no lleva espacios ni acentos. Cópialo de nuevo, completo.' });
    inp.focus();
    return;
  }
  if (raw !== token) {
    inp.value = token;
    syncBearer(wrap);
  }
  if (rememberBox(wrap)?.checked) storeToken(token);

  const my = ++testSeq;
  testAbort?.abort();
  const ctrl = new AbortController();
  testAbort = ctrl;
  const timer = window.setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
  btn.disabled = true;
  setTestResult(wrap, { kind: 'loading', text: 'Probando… Si el servidor estaba dormido puede tardar hasta un minuto.' });

  try {
    // Sin cookies (credentials: 'omit'): así se prueba el token y no la sesión abierta en el navegador.
    // fetch directo (no api.ts) para que un 401 no cierre la sesión de la app.
    const res = await fetch('/api/quick/summary', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (my !== testSeq || !wrap.isConnected) return;

    if (!res.ok) {
      const body = data as { message?: unknown; error?: unknown } | null;
      const serverMsg = [body?.message, body?.error].find((v): v is string => typeof v === 'string' && v.trim() !== '');
      const msg = serverMsg ?? `Error ${res.status}`;
      const formatHint = FULL_TOKEN_RE.test(token) ? '' : 'Un token completo empieza con fin_ y tiene 47 caracteres.';
      // El mensaje del servidor ya indica qué hacer ("cópialo completo o crea uno nuevo"): solo se agrega lo que falte.
      const authHint = serverMsg
        ? formatHint
        : [formatHint, 'Revisa que lo copiaste completo; si lo revocaste o lo perdiste, crea uno nuevo.'].filter(Boolean).join(' ');
      const hint =
        res.status === 401 || res.status === 403
          ? authHint
          : res.status >= 500
            ? 'El servidor tuvo un problema. Vuelve a intentarlo en un momento.'
            : '';
      setTestResult(wrap, { kind: 'error', title: 'No funcionó', text: hint ? `${msg}\n${hint}` : msg });
      return;
    }
    const q = data as Partial<QuickResult> | null;
    if (!q || typeof q.message !== 'string') {
      setTestResult(wrap, { kind: 'error', title: 'No funcionó', text: 'Respuesta inesperada del servidor.' });
      return;
    }
    if (q.ok === false) {
      setTestResult(wrap, { kind: 'error', title: 'El servidor respondió', text: q.message });
      return;
    }
    setTestResult(wrap, { kind: 'ok', title: '✓ Funciona · así se verá la notificación', text: q.message });
  } catch (err) {
    if (my !== testSeq || !wrap.isConnected) return;
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    setTestResult(wrap, {
      kind: 'error',
      title: 'No funcionó',
      text: aborted
        ? 'Se agotó el tiempo de espera. Si el servidor estaba dormido, vuelve a intentarlo.'
        : 'No se pudo conectar con el servidor. Revisa tu conexión y vuelve a intentarlo.',
    });
  } finally {
    window.clearTimeout(timer);
    if (testAbort === ctrl) testAbort = null;
    if (my === testSeq) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 3. Receta para la app Atajos
// ---------------------------------------------------------------------------
function shortcutSectionHtml(origin: string): string {
  const optionsUrl = `${origin}/api/quick/options`;
  const txUrl = `${origin}/api/quick/transaction`;
  const summaryUrl = `${origin}/api/quick/summary`;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const authHeader = `${copyHtml('Authorization')} = ${bearerHtml()}`;

  return `<section class="card" aria-labelledby="v-ios-h3">
    <div class="card-head"><h2 id="v-ios-h3"><span class="v-ios-step">3</span>Crea el Atajo en tu iPhone</h2></div>
    <p class="v-ios-lead">Los nombres entre comillas son los de iOS en español; si tu iPhone muestra una variante (p. ej. «Añadir» en lugar de «Agregar»), busca la acción en el buscador de acciones por una palabra clave (p. ej. «entrada», «URL», «diccionario», «lista», «notificación»). Toca <b class="white">Copiar</b> para pegar cada valor en el Atajo.</p>
    ${local ? `<div class="tip v-ios-tip-red mb">Estás abriendo la app en <b class="white">${esc(location.host)}</b>: tu iPhone no puede llegar a esa dirección. Abre esta página desde la dirección pública (la de Render) para copiar las URL correctas.</div>` : ''}
    <div class="tip mb">Donde dice <code class="v-ios-code">Bearer TU_TOKEN</code> va la palabra Bearer, un espacio y tu token. Si pegas tu token en la sección 2 (Prueba), los botones Copiar de <b class="white">Authorization</b> ya lo incluyen completo.</div>

    <ol class="v-ios-steps">
      <li>
        <h3>Crea el atajo «Gasto»</h3>
        <p>Abre la app <b>Atajos</b> → toca <b>«+»</b> (Nuevo atajo) → toca el nombre de arriba y nómbralo ${copyHtml('Gasto')}.</p>
      </li>
      <li>
        <h3>Pregunta cuánto gastaste</h3>
        <p>Agrega la acción <b>«Solicitar entrada»</b>. Pregunta: ${copyHtml('¿Cuánto gastaste?')} · Tipo de entrada: <b>«Número»</b>.</p>
      </li>
      <li>
        <h3>Pregunta en qué <span class="badge gray">Opcional</span></h3>
        <p>Otra acción <b>«Solicitar entrada»</b>. Pregunta: ${copyHtml('¿En qué?')} · Tipo de entrada: <b>«Texto»</b>.</p>
      </li>
      <li>
        <h3>Elige con qué pagaste y la categoría <span class="badge gray">Opcional</span></h3>
        <ul class="v-ios-sub">
          <li>Acción <b>«Obtener contenido de URL»</b>: URL ${copyHtml(optionsUrl, 'URL de opciones')} · toca «Mostrar más» → Método <b>GET</b> → Encabezados: ${authHeader}.</li>
          <li>Acción <b>«Obtener valor del diccionario»</b>: clave ${copyHtml('payments')} (diccionario: «Contenido de URL»).</li>
          <li>Acción <b>«Seleccionar de la lista»</b>: Pregunta ${copyHtml('¿Con qué pagaste?')}.</li>
          <li>Otra <b>«Obtener valor del diccionario»</b> con la clave ${copyHtml('categories_expense')}. Ojo: iOS le pone como diccionario el «Elemento seleccionado» anterior; tócalo → «Seleccionar variable» → toca la acción «Obtener contenido de URL» de arriba.</li>
          <li>Otra <b>«Seleccionar de la lista»</b>: Pregunta ${copyHtml('¿Qué categoría?')}.</li>
        </ul>
        <p class="mt">Si casi siempre pagas igual, omite este paso y escribe el nombre fijo en <code class="v-ios-code">payment</code> (p. ej. Efectivo): el atajo será más rápido.</p>
      </li>
      <li>
        <h3>Registra el gasto</h3>
        <p>Acción <b>«Obtener contenido de URL»</b>: URL ${copyHtml(txUrl, 'URL para registrar')} (si iOS ya puso ahí una variable azul, bórrala y pega la dirección) · «Mostrar más» → Método <b>POST</b> → Encabezados: ${authHeader} → «Solicitar cuerpo» (cuerpo de la solicitud): <b>JSON</b>, y con «Agregar campo nuevo» crea estos campos (clave · tipo · valor):</p>
        <ul class="v-ios-fields">
          <li>${copyHtml('amount')}<span class="badge white">Número</span><span>→ «Entrada proporcionada» de «¿Cuánto gastaste?» (paso 2)</span></li>
          <li>${copyHtml('description')}<span class="badge gray">Texto</span><span>→ «Entrada proporcionada» de «¿En qué?» (paso 3); si no hiciste esa pregunta, no agregues este campo</span></li>
          <li>${copyHtml('category')}<span class="badge gray">Texto</span><span>→ «Elemento seleccionado» de la categoría, o un nombre fijo</span></li>
          <li>${copyHtml('payment')}<span class="badge gray">Texto</span><span>→ «Elemento seleccionado» de la forma de pago, o un nombre fijo</span></li>
        </ul>
        <p class="mt">Para elegir de qué acción sale cada variable, toca el valor → «Seleccionar variable» → toca la acción correcta.</p>
        <div data-options></div>
        <div class="v-ios-json-head">
          <span class="label">Ejemplo del JSON que se envía</span>
          <button type="button" class="btn sm" data-copy="${esc(JSON_EXAMPLE)}" data-copy-select="json" aria-label="Copiar ejemplo JSON">Copiar</button>
        </div>
        <pre class="v-ios-json" data-copy-src="json">${esc(JSON_EXAMPLE)}</pre>
        <p class="mt">Opcionales: <code class="v-ios-code">"type": "ingreso"</code> para registrar un ingreso (sus categorías vienen en <code class="v-ios-code">categories_income</code>; un ingreso no puede ir a una tarjeta) y <code class="v-ios-code">"date": "AAAA-MM-DD"</code> (por defecto hoy). El monto acepta 150, 150.50 o $1,250.00. Si la categoría no existe, se registra sin categoría.</p>
      </li>
      <li>
        <h3>Muestra la confirmación</h3>
        <p>Acción <b>«Obtener valor del diccionario»</b>: clave ${copyHtml('message')} (diccionario: el «Contenido de URL» del paso 5, que iOS pone solo) → acción <b>«Mostrar notificación»</b> con «Valor del diccionario».</p>
        <p>Si algo falla (p. ej. no encuentra la forma de pago), la notificación te dice qué pasó para que lo corrijas.</p>
      </li>
      <li>
        <h3>Úsalo sin abrir la web</h3>
        <ul class="v-ios-sub">
          <li><b>Pantalla de inicio:</b> en el atajo toca su nombre arriba → «Agregar a pantalla de inicio».</li>
          <li><b>Widget:</b> mantén presionada la pantalla de inicio → «Editar» → agrega el widget de <b>Atajos</b> y elige «Gasto». En iOS 18 también puedes poner el control de Atajos en la pantalla de bloqueo.</li>
          <li><b>Siri:</b> di «Oye Siri, Gasto».</li>
          <li><b>Botón de Acción</b> (iPhone 15 Pro o posterior): Configuración → Botón de acción → «Atajo» → Gasto.</li>
          <li><b>iOS 18:</b> abre el Centro de control → «+» → «Agregar un control» → Atajos → Gasto.</li>
        </ul>
      </li>
    </ol>

    <div class="v-ios-recipe">
      <h3>Receta 2: «Resumen» cada noche</h3>
      <p>Una notificación con tu dinero, lo que gastaste hoy y en el mes, sin abrir nada.</p>
      <ol class="v-ios-steps">
        <li>
          <h3>Crea el atajo «Resumen»</h3>
          <p>Nuevo atajo ${copyHtml('Resumen')} → acción <b>«Obtener contenido de URL»</b>: URL ${copyHtml(summaryUrl, 'URL del resumen')} · Método <b>GET</b> · Encabezados: ${authHeader}.</p>
        </li>
        <li>
          <h3>Muestra el resumen</h3>
          <p>Acción <b>«Obtener valor del diccionario»</b>: clave ${copyHtml('message')} → acción <b>«Mostrar notificación»</b>.</p>
        </li>
        <li>
          <h3>Automatízalo</h3>
          <p>En Atajos → pestaña <b>«Automatización»</b> → «+» → <b>«Hora del día»</b> (p. ej. 9:00 p. m., diariamente) → <b>«Ejecutar inmediatamente»</b> → «Siguiente» → elige «Resumen». Cada noche recibirás una notificación con tu dinero.</p>
        </li>
      </ol>
    </div>

    <div class="v-ios-tips">
      <div class="tip">Render gratis se duerme: la primera petición puede tardar hasta un minuto; si el atajo marca error de tiempo, vuelve a intentarlo.</div>
      <div class="tip v-ios-tip-red">Cualquiera con el token puede registrar movimientos: no lo compartas; revócalo si pierdes el teléfono.</div>
    </div>
  </section>`;
}

const JSON_EXAMPLE = `{
  "amount": 150.5,
  "description": "Tacos",
  "category": "Comida",
  "payment": "Efectivo"
}`;

/** Nombres que acepta la API rápida (con la sesión actual), para copiarlos tal cual en el Atajo. */
async function loadOptions(wrap: HTMLElement): Promise<void> {
  const my = ++optionsSeq;
  try {
    // fetch directo: si la API rápida no responde, esta ayuda simplemente no se muestra.
    const res = await fetch('/api/quick/options', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const data = (await res.json()) as Partial<QuickOptions> | null;
    if (my !== optionsSeq || !wrap.isConnected) return;
    const box = wrap.querySelector<HTMLElement>('[data-options]');
    if (!box) return;
    const payments = cleanList(data?.payments);
    const categories = cleanList(data?.categories_expense);
    if (!payments.length && !categories.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `<div class="v-ios-opts">
      ${payments.length ? optionChipsHtml('Formas de pago que acepta payment (toca para copiar)', payments) : ''}
      ${categories.length ? optionChipsHtml('Categorías de gasto que acepta category (toca para copiar)', categories) : ''}
    </div>`;
  } catch {
    // Ayuda opcional: sin mensaje de error.
  }
}

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

function optionChipsHtml(label: string, names: string[]): string {
  const shown = names.slice(0, MAX_OPTION_CHIPS);
  const extra = names.length - shown.length;
  return `<div>
    <span class="label">${esc(label)}</span>
    <div class="v-ios-chips">
      ${shown.map((n) => `<button type="button" class="chip v-ios-chip" data-copy="${esc(n)}" title="Copiar">${esc(n)}</button>`).join('')}
      ${extra > 0 ? `<span class="chip">y ${extra} más</span>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// 4. Instalar la app
// ---------------------------------------------------------------------------
function installSectionHtml(origin: string): string {
  const installed = isStandalone();
  return `<section class="card" aria-labelledby="v-ios-h4">
    <div class="card-head">
      <h2 id="v-ios-h4"><span class="v-ios-step">4</span>Instala la app</h2>
      ${installed ? '<span class="badge white">✓ Ya la usas como app</span>' : ''}
    </div>
    <div class="v-ios-install">
      <div class="v-ios-platform">
        <h3>iPhone</h3>
        <p>En <b>Safari</b> abre esta página ${copyHtml(`${origin}/`, 'dirección de la app')} → <b>Compartir</b> → <b>«Agregar a pantalla de inicio»</b>. Se abre como app, a pantalla completa y con su ícono.</p>
      </div>
      <div class="v-ios-platform">
        <h3>Android</h3>
        <p>En <b>Chrome</b> abre esta página → menú <b>⋮</b> → <b>«Instalar app»</b> o «Agregar a la pantalla principal».</p>
      </div>
      <p class="muted small">La app instalada guarda su propia sesión: la primera vez que la abras te pedirá tu contraseña. Los Atajos no la necesitan; usan el token.</p>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function testInput(wrap: HTMLElement): HTMLInputElement | null {
  return wrap.querySelector<HTMLInputElement>('#v-ios-token');
}

function rememberBox(wrap: HTMLElement): HTMLInputElement | null {
  return wrap.querySelector<HTMLInputElement>('[data-remember]');
}

/** Quita espacios y un "Bearer " pegado por error. */
function normalizeToken(raw: string): string {
  return raw.trim().replace(/^(?:bearer(?:\s+|$))+/i, '').trim();
}

/** Solo caracteres ASCII visibles (una cabecera HTTP no admite otros). */
function isTokenLike(token: string): boolean {
  return /^[\x21-\x7e]+$/.test(token);
}

/** Token válido del paso 2, o '' si está vacío o no parece un token. */
function currentToken(wrap: HTMLElement): string {
  const token = normalizeToken(testInput(wrap)?.value ?? '');
  return isTokenLike(token) ? token : '';
}

function storedToken(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string): void {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* sin almacenamiento disponible (modo privado): no pasa nada */
  }
}

function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** Fecha y hora local: "16 sep 2026, 9:05 p.m.". */
function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(settings.locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** Valor copiable: texto monoespaciado + botón Copiar. */
function copyHtml(value: string, label = value): string {
  return `<span class="v-ios-copy"><code class="v-ios-code">${esc(value)}</code><button type="button" class="btn sm" data-copy="${esc(value)}" aria-label="Copiar ${esc(label)}">Copiar</button></span>`;
}

/** "Bearer TU_TOKEN" copiable; si hay token en el paso 2, se copia con el token completo. */
function bearerHtml(): string {
  return `<span class="v-ios-copy"><code class="v-ios-code" data-bearer-text>Bearer ${TOKEN_PLACEHOLDER}</code><button type="button" class="btn sm" data-copy-bearer aria-label="Copiar valor del encabezado Authorization">Copiar</button></span>`;
}

function syncBearer(wrap: HTMLElement): void {
  const token = currentToken(wrap);
  // Solo se muestra el inicio del token; el botón copia el valor completo.
  const text = token ? `Bearer ${token.slice(0, 6)}…` : `Bearer ${TOKEN_PLACEHOLDER}`;
  wrap.querySelectorAll<HTMLElement>('[data-bearer-text]').forEach((el) => (el.textContent = text));
}

function selectText(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* sigue con el respaldo */
  }
  const active = document.activeElement as HTMLElement | null;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  } finally {
    active?.focus?.();
  }
}

async function copyWithFeedback(btn: HTMLElement, text: string, onFail: () => void): Promise<void> {
  if (!text) return;
  const ok = await copyText(text);
  if (!ok) {
    onFail();
    toast('No se pudo copiar automáticamente: el texto quedó seleccionado, cópialo a mano.', 'error', 5000);
    return;
  }
  if (btn.dataset.copyLabel === undefined) btn.dataset.copyLabel = btn.textContent ?? 'Copiar';
  const original = btn.dataset.copyLabel;
  btn.textContent = '✓ Copiado';
  btn.classList.add('v-ios-copied');
  window.clearTimeout(Number(btn.dataset.copyTimer) || undefined);
  btn.dataset.copyTimer = String(
    window.setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('v-ios-copied');
      delete btn.dataset.copyTimer;
    }, 1600),
  );
}
