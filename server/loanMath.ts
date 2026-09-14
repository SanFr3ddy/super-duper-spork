/**
 * Cálculos de préstamos compartidos por /api/loans y /api/dashboard.
 *
 * Saldo real: se parte del monto original y, en orden cronológico, cada mes (en la fecha
 * start_date + k meses, hasta hoy) se suma el interés del periodo sobre el saldo y cada pago
 * registrado lo reduce. Así el "restante" incluye intereses y coincide con lo que se debe de verdad.
 * Con tasa 0 equivale a monto original − pagado.
 */
import { HttpError, round2 } from './util.js';
import type { LoanScheduleRow } from '../shared/types.js';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Suma meses a una fecha 'YYYY-MM-DD'; si el día no existe en el mes destino, usa el último día. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12; // 0..11
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad2(nm + 1)}-${pad2(Math.min(d, lastDay))}`;
}

export interface LoanTerms {
  principal: number;
  annual_rate: number; // porcentaje anual
  monthly_payment: number;
  start_date: string;
  term_months: number;
}

export interface LoanPaymentLite {
  amount: number;
  date: string;
}

export interface LoanStatus {
  remaining: number; // saldo actual con intereses (mínimo 0)
  interest_paid: number; // intereses generados hasta hoy
  principal_paid: number; // capital amortizado (0..principal)
  progress: number; // principal_paid / principal (0..1)
  estimated_months_left: number | null;
}

/** Tasa mensual efectiva a partir del porcentaje anual. */
function monthlyRate(annualRate: number): number {
  return (Number(annualRate) || 0) / 100 / 12;
}

/**
 * Saldo del préstamo a la fecha `today` aplicando intereses mensuales y pagos registrados.
 * Los pagos con fecha futura también se descuentan (no generan interés adicional).
 */
export function loanStatus(terms: LoanTerms, payments: LoanPaymentLite[], today: string): LoanStatus {
  const P = round2(Number(terms.principal) || 0);
  const r = monthlyRate(terms.annual_rate);
  const pmt = Number(terms.monthly_payment) || 0;

  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  let balance = P;
  let interest = 0;
  let k = 1;
  let nextAccrual = addMonths(terms.start_date, k);

  const accrueUntil = (limit: string): void => {
    // Máximo 1200 periodos (100 años) para no ciclar con datos absurdos.
    while (nextAccrual <= limit && k <= 1200) {
      if (r > 0 && balance > 0) {
        const i = round2(balance * r);
        balance = round2(balance + i);
        interest = round2(interest + i);
      }
      k += 1;
      nextAccrual = addMonths(terms.start_date, k);
    }
  };

  for (const p of sorted) {
    // El interés del periodo se genera en su fecha; un pago del mismo día lo cubre.
    accrueUntil(p.date < today ? p.date : today);
    balance = Math.max(0, round2(balance - (Number(p.amount) || 0)));
  }
  accrueUntil(today);

  const remaining = Math.max(0, round2(balance));
  const principalPaid = Math.min(P, Math.max(0, round2(P - remaining)));
  const progress = P > 0 ? Math.round((principalPaid / P) * 10_000) / 10_000 : 0;

  let monthsLeft: number | null;
  if (remaining <= 0) monthsLeft = 0;
  else if (pmt <= 0) monthsLeft = null;
  else if (r === 0) monthsLeft = Math.ceil(remaining / pmt);
  else if (pmt <= remaining * r) monthsLeft = null; // el pago no cubre ni los intereses
  else monthsLeft = Math.ceil(-Math.log(1 - (remaining * r) / pmt) / Math.log(1 + r));

  return { remaining, interest_paid: interest, principal_paid: principalPaid, progress, estimated_months_left: monthsLeft };
}

/**
 * Tabla de amortización (sistema francés) a partir del monto original.
 *  - Pago teórico = monthly_payment si > 0; si no, P·r/(1-(1+r)^-n) (o P/n si r = 0).
 *  - Lanza HttpError(400) si el pago no cubre los intereses de un periodo.
 *  - En el último periodo (o cuando el saldo se agotaría) el pago se ajusta para dejar el saldo en 0.
 */
export function buildSchedule(loan: LoanTerms): LoanScheduleRow[] {
  const P = round2(Number(loan.principal));
  const n = Math.max(1, Math.floor(Number(loan.term_months)));
  const r = monthlyRate(loan.annual_rate);

  let payment: number;
  if (Number(loan.monthly_payment) > 0) payment = round2(Number(loan.monthly_payment));
  else if (r > 0) payment = round2((P * r) / (1 - Math.pow(1 + r, -n)));
  else payment = round2(P / n);
  if (payment < 0.01) payment = 0.01;

  const rows: LoanScheduleRow[] = [];
  let balance = P;
  for (let period = 1; period <= n && balance > 0; period++) {
    const interest = round2(balance * r);
    let principal = round2(payment - interest);
    if (principal <= 0) throw new HttpError(400, 'El pago mensual no cubre los intereses');
    let pay = payment;
    if (period === n || principal >= balance) {
      principal = balance;
      pay = round2(principal + interest);
      balance = 0;
    } else {
      balance = round2(balance - principal);
    }
    rows.push({ period, date: addMonths(loan.start_date, period), payment: pay, interest, principal, balance });
  }
  return rows;
}

/** Interés total estimado según la tabla teórica (0 si el pago no cubre intereses). */
export function interestEstimate(loan: LoanTerms): number {
  try {
    return round2(buildSchedule(loan).reduce((acc, row) => acc + row.interest, 0));
  } catch {
    return 0;
  }
}
