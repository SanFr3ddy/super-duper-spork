/**
 * Carga .env y fija valores por defecto del entorno. Debe importarse antes que cualquier otro módulo.
 * TZ: Render corre en UTC; sin esto, después de las 18:00 en México "hoy" y el mes actual serían del día siguiente.
 */
import 'dotenv/config';

if (!process.env.TZ) process.env.TZ = 'America/Mexico_City';
