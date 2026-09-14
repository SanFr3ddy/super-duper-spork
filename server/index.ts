import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ensureSchema } from './schema.js';
import { authRouter, requireAuth } from './auth.js';
import { errorHandler } from './util.js';
import type { AppConfig } from '../shared/types.js';
import { categoriesRouter } from './routes/categories.js';
import { transactionsRouter } from './routes/transactions.js';
import { cardsRouter } from './routes/cards.js';
import { loansRouter } from './routes/loans.js';
import { goalsRouter } from './routes/goals.js';
import { budgetsRouter } from './routes/budgets.js';
import { dashboardRouter } from './routes/dashboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1); // Render corre detrás de un proxy
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Cabeceras básicas de seguridad
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// --- API pública ---
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/config', (_req, res) => {
  const body: AppConfig = {
    currency: process.env.CURRENCY || 'MXN',
    locale: process.env.LOCALE || 'es-MX',
  };
  res.json(body);
});
app.use('/api/auth', authRouter);

// --- API protegida ---
app.use('/api', requireAuth);
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api/categories', categoriesRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/cards', cardsRouter);
app.use('/api/loans', loansRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use(errorHandler);

// --- Cliente estático (build de Vite en dist/client) ---
// Compilado: __dirname = dist/server/server  =>  ../../client = dist/client
// Con tsx:   __dirname = server              =>  ../dist/client
// Se elige la primera ruta que exista, así no depende de NODE_ENV.
const clientCandidates = [
  path.resolve(__dirname, '../../client'),
  path.resolve(__dirname, '../dist/client'),
  path.resolve(process.cwd(), 'dist/client'),
];
const clientDir = clientCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? clientCandidates[0];
// index.html nunca se cachea (así cada deploy se ve al instante); los assets con hash sí, por un año.
app.use(
  express.static(clientDir, {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }),
);
app.use((req, res) => {
  if (req.method !== 'GET') {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(clientDir, 'index.html'), (err) => {
    if (err) res.status(404).send('Cliente no construido. Ejecuta `npm run build` o usa `npm run dev`.');
  });
});

async function main(): Promise<void> {
  await ensureSchema();
  app.listen(PORT, () => {
    console.log(`[server] escuchando en http://localhost:${PORT} (${IS_PROD ? 'producción' : 'desarrollo'})`);
  });
}

main().catch((err) => {
  console.error('[server] no se pudo iniciar:', err);
  process.exit(1);
});
