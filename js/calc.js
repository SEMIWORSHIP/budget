// Расчёты: даты, зарплаты, погашение долгов, цели.

export const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function money(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
}

export function num(str) {
  const v = parseFloat(String(str ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
}

export function ym(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

export function ymShift(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return ym(new Date(y, m - 1 + delta, 1));
}

export function ymTitle(key) {
  const [y, m] = key.split('-').map(Number);
  const name = MONTHS[m - 1];
  return name[0].toUpperCase() + name.slice(1) + (y !== new Date().getFullYear() ? ' ' + y : '');
}

export function isoDate(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function dayTitle(iso) {
  const today = isoDate();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (iso === today) return 'Сегодня';
  if (iso === isoDate(y)) return 'Вчера';
  const [, m, d] = iso.split('-').map(Number);
  return d + ' ' + MONTHS_GEN[m - 1];
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function daysInMonth(y, m0) {
  return new Date(y, m0 + 1, 0).getDate();
}

// Все дни зарплаты начиная с from (включительно) и до to (не включая).
export function paydaysBetween(from, to, days) {
  const out = [];
  const sorted = [...days].sort((a, b) => a - b);
  let y = from.getFullYear(), m = from.getMonth();
  const start = startOfDay(from);
  for (let guard = 0; guard < 240; guard++) {
    const dim = daysInMonth(y, m);
    for (const d of sorted) {
      const date = new Date(y, m, Math.min(d, dim));
      if (date >= to) return out;
      if (date >= start) out.push(date);
    }
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

export function nextPayday(days, now = new Date()) {
  const far = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  return paydaysBetween(now, far, days)[0] || null;
}

export function daysLeftInMonth(now = new Date()) {
  return daysInMonth(now.getFullYear(), now.getMonth()) - now.getDate() + 1;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Месячная ставка. Запоминается при обновлении по выписке (проценты / остаток),
// чтобы платежи между выписками её не искажали.
export function monthlyRate(debt) {
  if (debt.rate > 0) return debt.rate;
  if (debt.interest > 0 && debt.balance > 0) return debt.interest / debt.balance;
  if (debt.ratePct > 0) return debt.ratePct / 100 / 12;
  return 0;
}

// Сколько месяцев гасить и сколько уйдёт на проценты при платеже payment в месяц.
export function payoff(balance, rate, payment) {
  if (balance <= 0) return { months: 0, interest: 0 };
  if (payment <= 0) return { never: true };
  if (payment <= balance * rate + 0.01) return { never: true };
  let b = balance, months = 0, interest = 0;
  while (b > 0.5 && months < 600) {
    const i = b * rate;
    interest += i;
    b = b + i - payment;
    months++;
  }
  return { months, interest };
}

export function monthsLabel(n) {
  if (n < 12) return n + ' ' + plural(n, 'месяц', 'месяца', 'месяцев');
  const y = Math.floor(n / 12), m = n % 12;
  return y + ' ' + plural(y, 'год', 'года', 'лет') + (m ? ' ' + m + ' мес.' : '');
}

export const MONTHS_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];

// «в апреле 2029»
export function dateAfterMonths(n, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() + n, 1);
  return 'в ' + MONTHS_PREP[d.getMonth()] + ' ' + d.getFullYear();
}

export function deadlineTitle(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return d + ' ' + MONTHS_GEN[m - 1] + ' ' + y;
}

// Сколько откладывать с каждой зарплаты, чтобы успеть к сроку.
export function goalPace(goal, paydays, now = new Date()) {
  const left = Math.max(0, (goal.target || 0) - (goal.saved || 0));
  if (!left) return { done: true };
  if (!goal.deadline) return { left };
  const [y, m, d] = goal.deadline.split('-').map(Number);
  const dl = new Date(y, m - 1, d);
  const count = paydaysBetween(now, dl, paydays).length;
  if (!count) return { left, late: true };
  return { left, count, perPayday: left / count };
}
