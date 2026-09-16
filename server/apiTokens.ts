import type { Request, Response, NextFunction } from 'express';

// PENDIENTE (workflow): tokens de API para Atajos de iPhone según shared/types.ts
export async function quickAuth(_req: Request, res: Response, _next: NextFunction): Promise<void> {
  res.status(501).json({ error: 'Pendiente' });
}
