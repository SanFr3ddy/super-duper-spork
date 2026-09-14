# Finanzas · Hábitos

Aplicación web de finanzas personales para crear hábitos: registra ingresos y gastos, controla tarjetas de crédito y préstamos, define metas de ahorro y presupuestos mensuales, y revisa todo con gráficas por mes del año.

- **Frontend:** Vite + TypeScript + Chart.js (tema oscuro negro / blanco / rojo, responsive).
- **Backend:** Node 22 + Express 5 + TypeScript.
- **Base de datos:** PostgreSQL en [Neon](https://neon.tech) (driver `pg`). Las tablas se crean solas al arrancar.
- **Despliegue:** [Render](https://render.com) como Web Service (incluye `render.yaml`).

## Secciones

| Sección | Qué hace |
| --- | --- |
| Cartera (barra superior) | Visible en todas las pantallas: dinero total en tus cuentas y detalle por cartera. Se actualiza sola al guardar cualquier cambio. |
| Resumen | Totales del año, gráficas mensuales (ingresos vs gastos, salidas apiladas, flujo neto), gastos por categoría, Mi dinero por banco, tarjetas, préstamos y metas, hábitos del mes. |
| Mi dinero | Tus carteras y cuentas (nómina, ahorro, inversión, efectivo) por banco, saldos automáticos, transferencias, ajustes de saldo y gráficas por banco y por mes. |
| Mis bancos | Bancos con rendimiento anual y tope (p. ej. 15% hasta $10,000). Rendimiento estimado al día/mes/año, aviso de excedente sobre el tope con sugerencia de a dónde moverlo, y registro de rendimientos pagados. |
| Suscripciones | Cargos e ingresos fijos (cada día, semana, mes en un día concreto o año) que se registran solos en Movimientos con la cartera o tarjeta elegida; al abrir la app se ponen al día sin duplicar. |
| Movimientos | Ingresos y gastos con categoría, fecha, descripción y forma de pago (cartera o tarjeta de crédito, con compras a meses). Filtros por mes/año, tipo, categoría, cuenta y búsqueda. |
| Tarjetas | Tarjetas de crédito con límite, corte y fecha de pago. Deuda, pago del mes sin intereses, compras a meses (qué mensualidad toca y cuánto falta), pagos desde una cartera. Compras a meses con pagos iguales o desglose por tramos (p. ej. 5 × $400 + 6 × $500) y elección de la primera mensualidad. |
| Préstamos | Préstamos con tasa anual, pago mensual y plazo. Saldo restante con intereses mensuales, avance, pagos registrados y tabla de amortización. |
| Metas | Metas con monto objetivo y fecha límite. Aportes y retiros, aporte mensual sugerido, gráfica de ahorro por mes. |
| Presupuestos | Límite mensual por categoría de gasto comparado con lo gastado. Copia del mes anterior. |
| Categorías | Personaliza nombre, color e icono de las categorías de ingreso y gasto. |

### Reglas de flujo de efectivo

- **Ingresos** y **gastos** son los movimientos. Las compras con tarjeta de crédito cuentan como gasto en la fecha de la compra.
- Los **pagos a tarjetas** no cuentan como gasto (ya se contó la compra); solo reducen la deuda de la tarjeta.
- Los **pagos a préstamos** cuentan como salida, separados de los gastos.
- Los **aportes a metas** cuentan como ahorro.
- El **saldo de cada cartera** = saldo inicial + ingresos − gastos pagados con ella − pagos de tarjeta y préstamo hechos con ella ± transferencias ± ajustes.
- Las **compras a meses** cuentan como gasto completo el día de la compra; la primera mensualidad es el mes siguiente salvo que elijas otro. Con desglose, la suma de los tramos debe ser igual al total.
- El **rendimiento estimado** de un banco = min(saldo, tope) × tasa + excedente × tasa sobre el tope (interés simple, anual ÷ 12 al mes).
- Los **cargos recurrentes** se registran al arrancar el servidor, cada hora mientras está despierto y al usar la app (máx. cada 5 min).
- **Flujo neto del mes** = ingresos − gastos − préstamos − ahorro. **Tasa de ahorro** = ahorro / ingresos.

## Variables de entorno

Copia `.env.example` a `.env` y rellena:

| Variable | Descripción |
| --- | --- |
| `DATABASE_URL` | Cadena de conexión de Neon (con `-pooler` y `sslmode=require`). |
| `PORT` | Puerto local (Render lo define solo). |
| `NODE_ENV` | `development` o `production`. |
| `APP_PASSWORD` | Contraseña para entrar a la app. Si está vacía, la app queda abierta (solo para local). |
| `SESSION_SECRET` | Texto largo aleatorio para firmar la cookie de sesión. |
| `CURRENCY` | Moneda ISO 4217, por ejemplo `MXN`, `USD`, `COP`. |
| `LOCALE` | Formato de números y fechas, por ejemplo `es-MX`. |
| `TZ` | Zona horaria para calcular "hoy", el mes actual y las fechas de corte y pago. Render usa UTC; por defecto la app usa `America/Mexico_City`. |

`.env` está en `.gitignore`: nunca se sube al repositorio.

## Desarrollo local

```bash
npm install
cp .env.example .env   # y edita DATABASE_URL
npm run dev            # servidor en :3000 y Vite en :5173 (proxy a /api)
```

Abre `http://localhost:5173`.

Para probar el build de producción:

```bash
npm run build
npm start              # sirve dist/client desde Express en :3000
```

## Despliegue en Render

1. Sube el repositorio a GitHub.
2. En Render: **New → Blueprint** y elige el repositorio (usa `render.yaml`), o **New → Web Service** con:
   - Runtime: Node
   - Build command: `npm ci --include=dev && npm run build`
   - Start command: `npm start`
   - Health check path: `/api/health`
3. En **Environment** agrega:
   - `DATABASE_URL` = tu cadena de Neon
   - `APP_PASSWORD` = la contraseña con la que entrarás
   - `SESSION_SECRET` = un texto largo aleatorio (con el Blueprint se genera solo)
   - `NODE_ENV` = `production`
   - `CURRENCY` y `LOCALE` si quieres cambiar los valores por defecto (`MXN`, `es-MX`)
   - `TZ` = tu zona horaria (`America/Mexico_City` por defecto)
4. Deploy. Las tablas se crean automáticamente en el primer arranque.

## Scripts

| Script | Descripción |
| --- | --- |
| `npm run dev` | Servidor (tsx watch) + Vite con recarga en caliente. |
| `npm run build` | Compila servidor (`dist/server`) y cliente (`dist/client`). |
| `npm start` | Arranca el servidor compilado. |
| `npm run typecheck` | Verifica tipos de servidor y cliente. |

## Estructura

```
server/          Express + rutas de la API (/api/...)
  routes/        categories, transactions, cards, loans, goals, budgets, dashboard, accounts, banks, recurring
  accountsData.ts  saldos de carteras (fórmula única)
  yields.ts        rendimientos con tope (fórmula única)
  recurring.ts     calendario de cargos recurrentes; recurringPost.ts los registra
  installments.ts  compras a meses (fórmula única)
  schema.ts      DDL idempotente + categorías por defecto
client/          Vite (index.html, src/)
  src/views/     una vista por sección
  src/charts.ts  tema de Chart.js (negro / blanco / rojo)
shared/types.ts  contrato de la API compartido por servidor y cliente
render.yaml      blueprint de Render
```
