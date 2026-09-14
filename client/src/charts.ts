/**
 * Chart.js con tema oscuro de la marca (negro / blanco / rojo).
 *
 * Reglas de la guía de visualización aplicadas aquí:
 *  - Marcas delgadas, extremos redondeados (4px) anclados a la línea base, huecos de 2px entre barras.
 *  - Una sola escala Y por gráfica (nunca doble eje).
 *  - Rejilla y ejes recesivos; texto en tinta de texto, nunca en el color de la serie.
 *  - Tooltip por defecto en todas las gráficas.
 *  - Colores (validados con el script de paleta sobre #141414: separación CVD y contraste en verde):
 *      ingresos = blanco, gastos = rojo, préstamos = gris medio, ahorro = gris claro.
 *    Los neutros son intencionales (marca negro/blanco/rojo); la identidad la dan rojo vs. luminosidad.
 *  - Categorías nominales: una sola serie en rojo (barras horizontales), nunca color por posición.
 */
import {
  Chart,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Filler,
  type ChartConfiguration,
  type ChartType,
  type ChartDataset,
  type TooltipItem,
} from 'chart.js';
import { money, moneyCompact, MONTHS_SHORT } from './format';

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, DoughnutController, ArcElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);

export const COLORS = {
  income: '#f2f2f2',
  expense: '#e5202e',
  savings: '#cfcfcf',
  loans: '#7a7a7a',
  cards: '#c9192a',
  // Mi dinero (validado: blanco vs gris ΔE 27.5 normal y CVD, contraste >= 3:1)
  moneyAvailable: '#f2f2f2',
  moneySaved: '#9a9a9a',
  // Compras a meses (una serie)
  installments: '#e5202e',
  net: '#ffffff',
  muted: '#7f7f7f',
  grid: '#2c2c2a',
  surface: '#141414',
  text: '#f5f5f5',
  text2: '#b9b9b9',
};

/** Rampa ordinal roja (validada en tema oscuro): de más intenso a más claro. Usar por orden de magnitud. */
export const RED_RAMP = ['#9e1220', '#c9192a', '#ec2d3c', '#f3646f', '#f79aa1', '#fbc8cc'];
/** Neutros para series adicionales o "Otros". */
export const NEUTRAL_RAMP = ['#e0e0e0', '#bdbdbd', '#8a8a8a', '#5e5e5e'];

/** Color para el índice i de una lista ordenada por magnitud: rampa roja y luego neutros. */
export function rampColor(i: number): string {
  const all = [...RED_RAMP, ...NEUTRAL_RAMP];
  return all[i] ?? NEUTRAL_RAMP[NEUTRAL_RAMP.length - 1];
}

Chart.defaults.font.family = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.color = COLORS.text2;
Chart.defaults.borderColor = COLORS.grid;
Chart.defaults.plugins.legend.display = false;
Chart.defaults.plugins.tooltip.backgroundColor = '#1f1f1f';
Chart.defaults.plugins.tooltip.titleColor = COLORS.text;
Chart.defaults.plugins.tooltip.bodyColor = COLORS.text2;
Chart.defaults.plugins.tooltip.borderColor = '#3a3a3a';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;
Chart.defaults.plugins.tooltip.displayColors = true;
Chart.defaults.plugins.tooltip.boxPadding = 4;
Chart.defaults.animation = { duration: 350 };
Chart.defaults.maintainAspectRatio = false;
Chart.defaults.responsive = true;

// Registro de instancias por canvas para destruirlas al re-renderizar (evita fugas y canvases "en uso").
const registry = new Map<HTMLCanvasElement, Chart>();

export function destroyChart(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  const existing = registry.get(canvas);
  if (existing) {
    existing.destroy();
    registry.delete(canvas);
  }
}

/** Destruye todas las gráficas cuyo canvas ya no esté en el documento (llamar al cambiar de vista). */
export function destroyDetachedCharts(): void {
  for (const [canvas, chart] of registry) {
    if (!document.contains(canvas)) {
      chart.destroy();
      registry.delete(canvas);
    }
  }
}

export function destroyAllCharts(): void {
  for (const [, chart] of registry) chart.destroy();
  registry.clear();
}

function mount<T extends ChartType>(canvas: HTMLCanvasElement, config: ChartConfiguration<T>): Chart {
  destroyChart(canvas);
  const chart = new Chart(canvas, config as ChartConfiguration);
  registry.set(canvas, chart);
  return chart;
}

const moneyTick = (v: string | number): string => moneyCompact(Number(v));
const moneyTooltip = (item: TooltipItem<'bar' | 'line'>): string => `${item.dataset.label ?? ''}: ${money(Number(item.parsed.y))}`;

export interface SeriesSpec {
  label: string;
  /** null = sin dato (p. ej. meses futuros): no se dibuja, en vez de aparentar un 0. */
  data: (number | null)[];
  color: string;
}

/** Barras agrupadas por mes (p. ej. ingresos vs gastos). labels por defecto: meses abreviados. */
export function monthlyBars(canvas: HTMLCanvasElement, series: SeriesSpec[], opts: { labels?: string[]; stacked?: boolean } = {}): Chart {
  const stacked = !!opts.stacked;
  const datasets: ChartDataset<'bar'>[] = series.map((s) => ({
    label: s.label,
    data: s.data,
    backgroundColor: s.color,
    hoverBackgroundColor: s.color,
    borderRadius: 4,
    borderSkipped: 'bottom' as const,
    barPercentage: stacked ? 0.6 : 0.8,
    categoryPercentage: stacked ? 0.7 : 0.62,
    // Hueco de 2px en color de superficie entre segmentos apilados (no es un contorno).
    borderColor: COLORS.surface,
    borderWidth: stacked ? { top: 2, right: 0, bottom: 0, left: 0 } : 0,
    maxBarThickness: 24,
  }));
  return mount(canvas, {
    type: 'bar',
    data: { labels: opts.labels ?? MONTHS_SHORT, datasets },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked, grid: { display: false }, border: { color: '#383835' }, ticks: { color: COLORS.muted } },
        y: {
          stacked,
          beginAtZero: true,
          grid: { color: COLORS.grid, tickLength: 0 },
          border: { display: false },
          ticks: { color: COLORS.muted, callback: moneyTick, maxTicksLimit: 6 },
        },
      },
      plugins: { tooltip: { callbacks: { label: moneyTooltip } } },
    },
  });
}

/** Líneas por mes (p. ej. disponible acumulado). */
export function monthlyLines(canvas: HTMLCanvasElement, series: SeriesSpec[], opts: { labels?: string[]; fill?: boolean; zeroLine?: boolean } = {}): Chart {
  const datasets: ChartDataset<'line'>[] = series.map((s, i) => ({
    label: s.label,
    data: s.data,
    borderColor: s.color,
    backgroundColor: hexToRgba(s.color, 0.12),
    pointBackgroundColor: s.color,
    pointBorderColor: COLORS.surface,
    pointBorderWidth: 2,
    pointRadius: 4,
    pointHoverRadius: 6,
    borderWidth: 2,
    // monotone evita que la curva invente picos o valles que no existen en los datos
    cubicInterpolationMode: 'monotone' as const,
    spanGaps: false,
    fill: opts.fill && i === 0 ? 'origin' : false,
  }));
  return mount(canvas, {
    type: 'line',
    data: { labels: opts.labels ?? MONTHS_SHORT, datasets },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: '#383835' }, ticks: { color: COLORS.muted } },
        y: {
          beginAtZero: !opts.zeroLine,
          grid: {
            color: (ctx) => (opts.zeroLine && ctx.tick.value === 0 ? '#5a5a5a' : COLORS.grid),
            tickLength: 0,
          },
          border: { display: false },
          ticks: { color: COLORS.muted, callback: moneyTick, maxTicksLimit: 6 },
        },
      },
      plugins: { tooltip: { callbacks: { label: moneyTooltip } } },
    },
  });
}

/** Dona de participación (categorías). Los colores deben venir de rampColor(i) con datos ordenados desc. */
export function doughnut(canvas: HTMLCanvasElement, items: { label: string; value: number; color: string }[]): Chart {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  return mount(canvas, {
    type: 'doughnut',
    data: {
      labels: items.map((i) => i.label),
      datasets: [
        {
          data: items.map((i) => i.value),
          backgroundColor: items.map((i) => i.color),
          hoverBackgroundColor: items.map((i) => i.color),
          borderColor: COLORS.surface,
          borderWidth: 2,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      cutout: '68%',
      plugins: {
        tooltip: {
          callbacks: {
            label: (item) => {
              const v = Number(item.parsed);
              return ` ${money(v)} · ${((v / total) * 100).toFixed(1)}%`;
            },
          },
        },
      },
    },
  });
}

/** Barras horizontales (una sola serie, mismo color) para rankings por categoría. */
export function horizontalBars(canvas: HTMLCanvasElement, items: { label: string; value: number; color?: string; share?: number }[], color = COLORS.expense): Chart {
  return mount(canvas, {
    type: 'bar',
    data: {
      labels: items.map((i) => i.label),
      datasets: [
        {
          label: 'Total',
          data: items.map((i) => i.value),
          backgroundColor: items.map((i) => i.color ?? color),
          borderRadius: 4,
          borderSkipped: 'left' as const,
          barPercentage: 0.7,
          categoryPercentage: 0.7,
          maxBarThickness: 18,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: COLORS.grid, tickLength: 0 },
          border: { display: false },
          ticks: { color: COLORS.muted, callback: moneyTick, maxTicksLimit: 5 },
        },
        y: {
          grid: { display: false },
          border: { color: '#383835' },
          ticks: {
            color: COLORS.text2,
            // Etiquetas largas se recortan con elipsis para no aplastar las barras.
            callback(value) {
              const label = String(this.getLabelForValue(Number(value)));
              return label.length > 18 ? `${label.slice(0, 17)}…` : label;
            },
          },
        },
      },
      plugins: {
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (ctx) => items[ctx[0]?.dataIndex ?? 0]?.label ?? '',
            label: (item) => {
              const it = items[item.dataIndex];
              const share = it?.share !== undefined ? ` · ${(it.share * 100).toFixed(1)}%` : '';
              return `${money(Number(item.parsed.x))}${share}`;
            },
          },
        },
      },
    },
  });
}

/** Leyenda HTML (siempre presente cuando hay >= 2 series). */
export function legendHtml(series: { label: string; color: string }[]): string {
  return `<div class="legend">${series
    .map((s) => `<span class="legend-item"><span class="swatch" style="background:${s.color}"></span>${s.label}</span>`)
    .join('')}</div>`;
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
