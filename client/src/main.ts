/**
 * Punto de entrada del cliente: carga config, verifica sesión, monta el layout y enruta por hash.
 * Cada vista exporta render(root) y destroy().
 */
import type { AppConfig, AuthStatus } from '../../shared/types';
import { api } from './api';
import { setConfig, esc } from './format';
import { toast, showError } from './ui';
import { destroyDetachedCharts } from './charts';
import * as dashboard from './views/dashboard';
import * as transactions from './views/transactions';
import * as cards from './views/cards';
import * as loans from './views/loans';
import * as goals from './views/goals';
import * as budgets from './views/budgets';
import * as categories from './views/categories';
import * as accounts from './views/accounts';

interface View {
  render: (root: HTMLElement) => Promise<void> | void;
  destroy?: () => void;
}
interface Route {
  path: string;
  title: string;
  subtitle: string;
  icon: string;
  view: View;
  nav: boolean;
  /** Etiqueta corta para la barra inferior en móvil. */
  short?: string;
}

export const ROUTES: Route[] = [
  { path: 'resumen', title: 'Resumen', subtitle: 'Tu año de un vistazo', icon: '📊', view: dashboard, nav: true },
  { path: 'dinero', title: 'Mi dinero', subtitle: 'Cuánto tienes y en qué banco está', icon: '💰', view: accounts, nav: true, short: 'Dinero' },
  { path: 'movimientos', title: 'Movimientos', subtitle: 'Ingresos y gastos', icon: '🧾', view: transactions, nav: true, short: 'Movim.' },
  { path: 'tarjetas', title: 'Tarjetas', subtitle: 'Tarjetas de crédito, pagos y compras a meses', icon: '💳', view: cards, nav: true },
  { path: 'prestamos', title: 'Préstamos', subtitle: 'Deudas y su avance', icon: '🏦', view: loans, nav: true },
  { path: 'ahorros', title: 'Metas', subtitle: 'Metas de ahorro y aportes', icon: '🎯', view: goals, nav: true },
  { path: 'presupuestos', title: 'Presupuestos', subtitle: 'Límites mensuales por categoría', icon: '📐', view: budgets, nav: true, short: 'Presup.' },
  { path: 'categorias', title: 'Categorías', subtitle: 'Personaliza tus categorías', icon: '🏷️', view: categories, nav: false },
];

const app = document.getElementById('app')!;
let current: Route | null = null;
let authState: AuthStatus = { required: false, authenticated: true };

function currentPath(): string {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  return raw || 'resumen';
}

export function navigate(path: string): void {
  location.hash = `#/${path}`;
}

function renderLayout(): void {
  app.innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-logo">F</div>
          <div><div class="brand-name">Finanzas</div><div class="brand-tag">Hábitos que suman</div></div>
        </div>
        <nav class="nav" aria-label="Secciones">
          ${ROUTES.filter((r) => r.nav)
            .map((r) => `<a href="#/${r.path}" data-route="${r.path}" title="${esc(r.title)}"><span class="ico">${r.icon}</span><span class="label-full">${esc(r.title)}</span><span class="label-short">${esc(r.short ?? r.title)}</span></a>`)
            .join('')}
        </nav>
        <div class="sidebar-foot">
          <a href="#/categorias" class="btn ghost sm" data-route="categorias">🏷️ Categorías</a>
          ${authState.required ? '<button type="button" class="btn ghost sm" data-logout>Cerrar sesión</button>' : ''}
        </div>
      </aside>
      <main class="main">
        <div class="mobile-links">
          <span class="mobile-brand"><span class="brand-logo">F</span>Finanzas</span>
          <span class="row">
            <a href="#/categorias" class="btn ghost sm" data-route="categorias">🏷️ Categorías</a>
            ${authState.required ? '<button type="button" class="btn ghost sm" data-logout>Salir</button>' : ''}
          </span>
        </div>
        <header class="topbar">
          <div class="title-block"><h1 id="page-title"></h1><div class="sub" id="page-subtitle"></div></div>
          <div class="topbar-actions" id="topbar-actions"></div>
        </header>
        <div id="view"></div>
      </main>
    </div>`;
  document.querySelectorAll('[data-logout]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api.post('/api/auth/logout');
        location.reload();
      } catch (err) {
        showError(err);
      }
    }),
  );
}

async function route(): Promise<void> {
  const path = currentPath();
  const next = ROUTES.find((r) => r.path === path) ?? ROUTES[0];
  if (!ROUTES.some((r) => r.path === path)) {
    navigate(next.path);
    return;
  }
  if (current?.view.destroy) {
    try {
      current.view.destroy();
    } catch {
      /* ignorar */
    }
  }
  current = next;
  document.title = `${next.title} · Finanzas`;
  document.getElementById('page-title')!.textContent = next.title;
  document.getElementById('page-subtitle')!.textContent = next.subtitle;
  document.getElementById('topbar-actions')!.innerHTML = '';
  document.querySelectorAll<HTMLAnchorElement>('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === next.path));
  const root = document.getElementById('view')!;
  root.innerHTML = '<div class="loading">Cargando…</div>';
  destroyDetachedCharts();
  try {
    await next.view.render(root);
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="card"><p class="error-text">No se pudo cargar esta sección.</p><p class="muted small">${esc(err instanceof Error ? err.message : String(err))}</p></div>`;
  }
  window.scrollTo({ top: 0 });
}

function renderLogin(): void {
  app.innerHTML = `
    <div class="login">
      <form class="login-card" id="login-form">
        <div class="brand-logo">F</div>
        <h1>Finanzas</h1>
        <p class="sub muted">Introduce tu contraseña para continuar</p>
        <div class="field">
          <label for="password">Contraseña</label>
          <input type="password" id="password" name="password" autocomplete="current-password" required autofocus />
        </div>
        <p class="error-text hidden" id="login-error"></p>
        <div class="form-actions"><button type="submit" class="btn primary block">Entrar</button></div>
      </form>
    </div>`;
  const form = document.getElementById('login-form') as HTMLFormElement;
  const errEl = document.getElementById('login-error')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;
    const btn = form.querySelector('button')!;
    btn.disabled = true;
    errEl.classList.add('hidden');
    try {
      await api.post('/api/auth/login', { password });
      authState = { required: true, authenticated: true };
      renderLayout();
      await route();
      toast('Bienvenido');
    } catch (err) {
      errEl.textContent = err instanceof Error ? err.message : 'Error al iniciar sesión';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
}

async function boot(): Promise<void> {
  try {
    const [cfg, auth] = await Promise.all([api.get<AppConfig>('/api/config'), api.get<AuthStatus>('/api/auth/status')]);
    setConfig(cfg);
    authState = auth;
  } catch (err) {
    app.innerHTML = `<div class="boot"><div><div class="boot-logo">F</div><p class="error-text">No se pudo conectar con el servidor.</p><p class="muted small">${esc(err instanceof Error ? err.message : '')}</p></div></div>`;
    return;
  }
  if (authState.required && !authState.authenticated) {
    renderLogin();
    return;
  }
  renderLayout();
  await route();
}

window.addEventListener('hashchange', () => {
  if (authState.required && !authState.authenticated) return;
  void route();
});
window.addEventListener('auth:required', () => {
  if (authState.required && !authState.authenticated) return;
  authState = { required: true, authenticated: false };
  toast('Tu sesión expiró. Vuelve a entrar.', 'error');
  renderLogin();
});

void boot();
