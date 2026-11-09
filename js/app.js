import { createStore } from './store.js';
import * as C from './calc.js';

const H = 'households/main';
const txPath = (key) => `${H}/months/${key}/tx`;

const S = {
  store: null, user: null, ready: false, shell: false, error: '',
  settings: null, cats: [], debts: [], goals: [], priv: [], planned: [],
  tx: [], histTx: [], extra: {}, month: C.ym(), histMonth: C.ym(), view: 'home',
  loaded: new Set(),
};
let subs = [];
let histSub = null;
let extraSubs = {};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = C.money;
const round2 = (n) => Math.round(n * 100) / 100;
const byOrder = (a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.name).localeCompare(String(b.name), 'ru');
const nextOrder = (list) => list.reduce((m, x) => Math.max(m, x.order ?? 0), 0) + 1;

/* ---------- данные ---------- */

const myName = () => S.settings?.names?.[S.user?.uid] || '';
const nameOf = (uid) => S.settings?.names?.[uid] || '';
const catById = (id) => S.cats.find((c) => c.id === id);
const varCats = () => S.cats.filter((c) => c.kind !== 'fixed');
const fixedCats = () => S.cats.filter((c) => c.kind === 'fixed');
const paydays = () => (S.settings?.paydays?.length ? S.settings.paydays : [15, 30]);
const debtPayment = (d) => Math.max(d.plan || 0, d.minPay || 0);

function spentByCat(list) {
  const m = {};
  for (const t of list) if (t.type === 'expense') m[t.cat] = (m[t.cat] || 0) + t.amount;
  return m;
}
function paidByDebt(list) {
  const m = {};
  for (const t of list) if (t.type === 'debt') m[t.debtId] = (m[t.debtId] || 0) + t.amount;
  return m;
}

/* ---------- деньги сейчас ---------- */

// Остаток = что ввели при сверке + все записи после неё.
function cashNow() {
  const cash = S.settings?.cash;
  if (!cash?.accounts?.length) return null;
  let total = cash.accounts.reduce((s, a) => s + (a.amount || 0), 0);
  const lists = [S.tx, ...Object.values(S.extra)];
  for (const list of lists) {
    for (const t of list) {
      if (!(t.at > cash.at)) continue;
      total += t.type === 'income' ? t.amount : -t.amount;
    }
  }
  return total;
}

// Месяцы между сверкой и текущим — их записи тоже нужны для остатка.
function watchCashMonths() {
  const at = S.settings?.cash?.at;
  const need = new Set();
  if (at) {
    let key = C.ym(new Date(at));
    for (let i = 0; i < 6 && key < S.month; i++, key = C.ymShift(key, 1)) need.add(key);
  }
  for (const key of Object.keys(extraSubs)) {
    if (!need.has(key)) { extraSubs[key](); delete extraSubs[key]; delete S.extra[key]; }
  }
  for (const key of need) {
    if (extraSubs[key]) continue;
    extraSubs[key] = S.store.watchCol(txPath(key), (list) => { S.extra[key] = list; scheduleRender(); }, () => {});
  }
}

function dueDate(day, now = new Date()) {
  if (!day) return null;
  return new Date(now.getFullYear(), now.getMonth(), Math.min(day, C.daysInMonth(now.getFullYear(), now.getMonth())));
}

function parseIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Сколько можно тратить до зарплаты: деньги сейчас минус неоплаченное до неё.
// Ближайшая зарплата, которую ещё не получили. Сегодняшняя не в счёт: деньги уже пришли.
function nextPay(now = new Date()) {
  const today = C.startOfDay(now);
  const received = new Set(S.settings?.received || []);
  const far = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  return C.paydaysBetween(now, far, paydays()).find((d) => d > today && !received.has(C.isoDate(d))) || null;
}

function untilPayday(now = new Date()) {
  const cash = cashNow();
  if (cash == null) return null;
  const today = C.startOfDay(now);
  const pay = nextPay(now);
  // Платежи текущего месяца и следующих — до дня зарплаты.
  let items = paymentItems(now).filter((i) => !i.done);
  const noDate = items.filter((i) => !i.due).length;
  for (let k = 1; k <= 2 && pay; k++) {
    const first = new Date(now.getFullYear(), now.getMonth() + k, 1);
    if (first >= pay) break;
    items = items.concat(paymentItems(first, false).filter((i) => !i.done && i.due));
  }
  const due = items.filter((i) => i.due && (!pay || i.due < pay));
  const oblig = due.reduce((s, i) => s + Math.max(0, i.amount - i.paid), 0);
  const days = pay ? Math.max(1, Math.round((pay - today) / 864e5)) : C.daysLeftInMonth(now);
  return { cash, oblig, free: cash - oblig, pay, days, noDate, dueCount: due.length };
}

// Какой долг гасить первым: самый дорогой. Если ставки почти равны — самый маленький.
function firstDebtId() {
  const act = S.debts.filter((d) => !d.paused && d.balance > 0 && C.monthlyRate(d) > 0);
  if (!act.length) return null;
  const top = Math.max(...act.map(C.monthlyRate));
  const close = act.filter((d) => C.monthlyRate(d) >= top * 0.9);
  close.sort((a, b) => a.balance - b.balance);
  return close[0].id;
}

// Ставка в месяц: по процентам из выписки, иначе по годовой.
function rateOf(d) {
  if (d.interest > 0 && d.balance > 0) return d.interest / d.balance;
  if (d.ratePct > 0) return d.ratePct / 1200;
  return 0;
}

function save(path, data, merge = true) {
  return S.store.save(path, data, merge).catch(fail);
}
function remove(path) {
  return S.store.remove(path).catch(fail);
}
function fail(e) {
  console.error(e);
  toast(e?.code === 'permission-denied' ? 'Нет доступа к базе' : 'Не сохранилось: ' + (e?.message || e), 'bad');
}
function addTx(t) {
  const key = t.date.slice(0, 7);
  const id = S.store.newId(txPath(key));
  return save(`${txPath(key)}/${id}`, { ...t, by: S.user.uid, at: Date.now() }, false);
}

/* ---------- подписки ---------- */

function subscribe() {
  const st = S.store;
  const uid = S.user.uid;
  const onErr = (e) => {
    console.error(e);
    S.error = e?.code === 'permission-denied'
      ? 'Нет доступа к базе. Проверь, что твоя почта есть в правилах Firestore.'
      : 'Не получилось загрузить данные: ' + (e?.message || e);
    S.loaded.add('settings');
    scheduleRender();
  };
  const col = (path, key, after) => st.watchCol(path, (list) => {
    S[key] = after ? after(list) : list;
    S.loaded.add(key);
    scheduleRender();
  }, onErr);

  subs.push(st.watchDoc(H, (d) => { S.settings = d || {}; S.loaded.add('settings'); watchCashMonths(); scheduleRender(); }, onErr));
  subs.push(col(`${H}/planned`, 'planned', (l) => l.sort((a, b) => String(a.date).localeCompare(String(b.date)))));
  subs.push(col(`${H}/cats`, 'cats', (l) => l.sort(byOrder)));
  subs.push(col(`${H}/debts`, 'debts', (l) => l.sort(byOrder)));
  subs.push(col(`${H}/goals`, 'goals', (l) => l.sort(byOrder)));
  subs.push(col(`private/${uid}/goals`, 'priv', (l) => l.sort(byOrder)));
  subs.push(col(txPath(S.month), 'tx'));
  watchHistory();
}

function watchHistory() {
  if (histSub) histSub();
  histSub = null;
  S.histTx = [];
  if (S.histMonth === S.month) return;
  histSub = S.store.watchCol(txPath(S.histMonth), (list) => { S.histTx = list; scheduleRender(); }, () => {});
}

function teardown() {
  subs.forEach((u) => u && u());
  subs = [];
  if (histSub) histSub();
  histSub = null;
  Object.values(extraSubs).forEach((u) => u());
  extraSubs = {};
  Object.assign(S, { settings: null, cats: [], debts: [], goals: [], priv: [], planned: [], tx: [], histTx: [], extra: {}, error: '', loaded: new Set() });
}

// Если приложение висело открытым и сменился месяц — переподписаться.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.user) return;
  const now = C.ym();
  if (now !== S.month) {
    teardown();
    S.month = now; S.histMonth = now;
    subscribe();
  }
});

/* ---------- отрисовка ---------- */

let queued = false;
function scheduleRender() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; render(); });
}

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  history: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  goals: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  debts: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>',
  plan: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
};
const TABS = [['home', 'Главная'], ['history', 'История'], ['goals', 'Цели'], ['debts', 'Долги'], ['plan', 'План']];

function render() {
  const app = $('#app');
  if (!S.ready) { S.shell = false; app.innerHTML = '<div class="center muted">Загрузка…</div>'; return; }
  if (!S.user) { S.shell = false; app.innerHTML = loginView(); return; }
  if (!S.loaded.has('settings')) { S.shell = false; app.innerHTML = '<div class="center muted">Загрузка…</div>'; return; }
  if (!S.error && !myName()) { S.shell = false; app.innerHTML = nameView(); return; }

  if (!S.shell) {
    app.innerHTML = `
      <main id="view"></main>
      <button id="fab" class="fab" data-act="add" aria-label="Записать трату">+</button>
      <nav class="tabbar">${TABS.map(([id, label]) => `
        <button data-act="tab" data-tab="${id}" class="tab">
          <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg><span>${label}</span>
        </button>`).join('')}
      </nav>`;
    S.shell = true;
  }
  const views = { home: homeView, history: historyView, goals: goalsView, debts: debtsView, plan: planView };
  const err = S.error ? `<div class="banner bad">${esc(S.error)}</div>` : '';
  const demo = S.store.demo ? '<div class="banner">Демо-режим: данные хранятся только в этом браузере.</div>' : '';
  $('#view').innerHTML = err + demo + views[S.view]();
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.view));
  $('#fab').hidden = !['home', 'history'].includes(S.view);
}

/* ---------- вход ---------- */

function loginView() {
  if (S.store.demo) {
    return `<div class="auth">
      <h1>Наш бюджет</h1>
      <p class="muted">Демо-режим: общая база ещё не подключена, данные будут только в этом браузере.</p>
      <button class="btn primary" data-act="demo-login" data-name="Сэм">Войти как Сэм</button>
      <button class="btn" data-act="demo-login" data-name="Аня">Войти как Аня</button>
    </div>`;
  }
  let last = '';
  try { last = localStorage.getItem('budget-last-email') || ''; } catch { /* ничего */ }
  return `<form class="auth" data-form="login">
    <h1>Наш бюджет</h1>
    <p class="muted small">Вход запоминается — входить нужно один раз. На айфоне Safari и иконка на экране «Домой» помнят вход отдельно, поэтому в иконке тоже войди один раз.</p>
    <label>Почта<input name="email" type="email" autocomplete="username" value="${esc(last)}" required></label>
    <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary">Войти</button>
    <p class="muted small" id="login-err"></p>
  </form>`;
}

function nameView() {
  return `<form class="auth" data-form="name">
    <h1>Как тебя подписывать?</h1>
    <p class="muted">Имя будет видно у записей, чтобы было понятно, кто что потратил.</p>
    <label>Имя<input name="name" required maxlength="20" autocomplete="given-name"></label>
    <button class="btn primary">Готово</button>
  </form>`;
}

/* ---------- главная ---------- */

function homeView() {
  if (S.loaded.has('cats') && !S.cats.length) return onboardingView();
  const now = new Date();
  const spent = spentByCat(S.tx);
  const vc = varCats();
  let remaining = 0;
  const overs = [];
  for (const c of vc) {
    const s = spent[c.id] || 0;
    remaining += Math.max(0, (c.limit || 0) - s);
    if (c.limit > 0 && s > c.limit) overs.push(`${c.name} +${money(s - c.limit)}`);
  }
  const u = untilPayday(now);
  const payWhen = (pay, days) => {
    if (!pay) return '';
    const date = pay.getDate() + ' ' + C.MONTHS_GEN[pay.getMonth()];
    return `зарплата ${date}, через ${days} ${C.plural(days, 'день', 'дня', 'дней')}`;
  };
  const oversHtml = overs.length ? `<div class="hero-note">Перебор: ${esc(overs.join(', '))}</div>` : '';

  let hero;
  if (u) {
    const neg = u.free < 0;
    hero = `<section class="hero">
      <div class="hero-top"><span class="hero-label">Можно тратить до зарплаты</span>
        <button class="hero-link" data-act="cash">Сверить</button></div>
      <div class="hero-sum ${neg ? 'neg' : ''}">${neg ? '−' : ''}${money(Math.abs(u.free))}</div>
      <div class="hero-sub">${neg ? 'не хватает до зарплаты' : `≈ ${money(u.free / u.days)} в день`} · ${payWhen(u.pay, u.days)}</div>
      <div class="hero-stats">
        <div><span>На руках</span><b>${money(u.cash)}</b></div>
        <div><span>Оплатить до зарплаты</span><b>${money(u.oblig)}</b></div>
      </div>
      ${u.noDate ? `<div class="hero-note soft">У ${u.noDate} ${C.plural(u.noDate, 'платежа', 'платежей', 'платежей')} не указано число — они пока не вычтены</div>` : ''}
      ${oversHtml}
    </section>`;
  } else {
    hero = `<section class="hero">
      <div class="hero-label">Можно потратить до конца ${C.MONTHS_GEN[now.getMonth()]}</div>
      <div class="hero-sum">${money(remaining)}</div>
      <div class="hero-sub">≈ ${money(remaining / C.daysLeftInMonth(now))} в день по лимитам</div>
      <button class="hero-cta" data-act="cash">Внести, сколько денег сейчас</button>
      ${oversHtml}
    </section>`;
  }

  const limits = `<section class="card">
    <h2>Лимиты на ${C.MONTHS[now.getMonth()]} <span class="muted small">ост. ${money(remaining)}</span></h2>
    ${vc.map((c) => limitRow(c, spent[c.id] || 0)).join('') || '<p class="muted">Категорий пока нет. Добавь их во вкладке «План».</p>'}
  </section>`;

  const items = paymentItems(now);
  const left = items.filter((i) => !i.done).reduce((s, i) => s + Math.max(0, i.amount - i.paid), 0);
  const payments = items.length ? `<section class="card">
    <h2>Платежи месяца <span class="muted small">${left ? 'осталось ' + money(left) : 'всё оплачено'}</span></h2>
    ${items.map(paymentRow).join('')}
  </section>` : '';

  const goals = S.goals.length ? `<section class="card">
    <h2>Цели</h2>
    ${S.goals.map((g) => miniGoal(g)).join('')}
  </section>` : '';

  const totalDebt = S.debts.reduce((s, d) => s + Math.max(0, d.balance || 0), 0);
  const interest = S.debts.reduce((s, d) => s + (d.balance > 0 ? d.balance * C.monthlyRate(d) : 0), 0);
  const debts = S.debts.length ? `<section class="card link" data-act="tab" data-tab="debts">
    <h2>Долги <span class="muted small">›</span></h2>
    <div class="debt-line"><div><span>Всего</span><b>${money(totalDebt)}</b></div>
    <div><span>Проценты в месяц</span><b class="bad-text">≈ ${money(interest)}</b></div></div>
  </section>` : '';

  return hero + limits + payments + goals + debts;
}

function limitRow(c, s) {
  const lim = c.limit || 0;
  const pct = lim ? Math.min(100, (s / lim) * 100) : 0;
  const over = lim ? s - lim : 0;
  const cls = over > 0 ? 'over' : pct >= 85 ? 'warn' : '';
  const right = !lim ? 'без лимита' : over > 0 ? 'перебор ' + money(over) : 'ост. ' + money(lim - s);
  return `<button class="row limit ${cls}" data-act="add" data-cat="${esc(c.id)}">
    <span class="emo">${esc(c.emoji || '•')}</span>
    <span class="grow">
      <span class="line"><span class="name">${esc(c.name)}</span><span class="amt">${right}</span></span>
      <span class="bar"><i style="width:${pct}%"></i></span>
      <span class="sub">${money(s)}${lim ? ' из ' + money(lim) : ''}</span>
    </span>
  </button>`;
}

function paidByPlan(list) {
  const m = {};
  for (const t of list) if (t.planId) m[t.planId] = (m[t.planId] || 0) + t.amount;
  return m;
}

// Платежи текущего месяца: обязательные, кредиты и разовые траты (включая просроченные разовые).
const CHURCH = [['tithe', 'Десятина', '⛪'], ['offering', 'Пожертвования', '🤲']];
function churchPct() {
  const c = S.settings?.church;
  return { tithe: c?.tithe ?? 10, offering: c?.offering ?? 3 };
}

// current = false — платежи будущего месяца: по ним ещё ничего не оплачено.
function paymentItems(now = new Date(), current = true) {
  const list = current ? S.tx : [];
  const spent = spentByCat(list);
  const paid = paidByDebt(list);
  const items = [];
  // Что по сроку было раньше первой сверки в этом месяце, уже сидит в остатке на картах.
  const at = S.settings?.cash?.at;
  const snap = at && current && C.ym(new Date(at)) === C.ym(now) ? C.startOfDay(new Date(at)) : null;
  const push = (item) => {
    if (!item.done && snap && item.due && item.due < snap) { item.done = true; item.assumed = true; }
    items.push(item);
  };
  for (const c of fixedCats()) {
    const p = spent[c.id] || 0;
    push({ kind: 'cat', id: c.id, name: c.name, emoji: c.emoji || '•', amount: c.limit || 0, due: dueDate(c.day, now), paid: p, done: p > 0 && p >= (c.limit || 0) * 0.9 });
  }
  for (const d of S.debts) {
    if (d.paused || !(d.minPay > 0) || !(d.balance > 0)) continue;
    const p = paid[d.id] || 0;
    push({ kind: 'debt', id: d.id, name: d.name, emoji: '💳', amount: debtPayment(d), due: dueDate(d.dueDay, now), paid: p, done: p >= d.minPay });
  }
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const planPaid = paidByPlan(list);
  for (const pl of S.planned) {
    if (!pl.date) continue;
    const due = parseIso(pl.date);
    if (due >= endOfMonth) continue;
    if ((pl.done || !current) && due < startOfMonth) continue;
    const p = planPaid[pl.id] || 0;
    push({ kind: 'plan', id: pl.id, name: pl.name, emoji: pl.emoji || '🎈', amount: pl.amount || 0, due, paid: p, done: !!pl.done, oneOff: true });
  }
  // Десятина и пожертвования: процент от всех доходов, внесённых в этом месяце. Отдать — сразу.
  if (current) {
    const income = list.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const pct = churchPct();
    for (const [key, name, emoji] of CHURCH) {
      if (!(pct[key] > 0)) continue;
      const owed = round2((income * pct[key]) / 100);
      const given = list.filter((t) => t.church === key).reduce((s, t) => s + t.amount, 0);
      if (!owed && !given) continue;
      push({ kind: 'church', id: key, name, emoji, amount: owed, due: C.startOfDay(now), paid: given, done: given >= owed - 0.5, whenText: `${pct[key]}% от доходов ${C.MONTHS_GEN[now.getMonth()]}` });
    }
  }
  return items.sort((a, b) => (a.due ? a.due.getTime() : 9e15) - (b.due ? b.due.getTime() : 9e15) || a.name.localeCompare(b.name, 'ru'));
}

function paymentRow(i) {
  const today = C.startOfDay(new Date());
  let when = 'без даты';
  if (i.whenText) when = i.whenText;
  else if (i.due) {
    const d = i.due.getDate() + ' ' + C.MONTHS_GEN[i.due.getMonth()];
    when = i.due < today && !i.done ? `<span class="bad-text">просрочено, было до ${d}</span>` : (i.oneOff ? d : `до ${d}`);
  }
  const sub = i.assumed ? `${money(i.amount)} · оплачено до сверки`
    : i.done ? 'оплачено ' + money(i.paid)
    : i.paid > 0 ? `оплачено ${money(i.paid)} из ${money(i.amount)}` : `<b>${money(i.amount)}</b> · ${when}`;
  const act = { cat: 'pay-cat', debt: 'pay-debt', plan: 'pay-plan', church: 'pay-church' }[i.kind];
  return `<div class="row pay ${i.done ? 'done' : ''}">
    <span class="emo">${esc(i.emoji)}</span>
    <span class="grow"><span class="name">${esc(i.name)}${i.oneOff ? ' <span class="pill">разово</span>' : ''}</span><span class="sub">${sub}</span></span>
    ${i.done ? '<span class="check" aria-label="Оплачено">✓</span>' : `<button class="btn small" data-act="${act}" data-id="${esc(i.id)}">${i.kind === 'church' ? 'Отдать' : 'Оплатить'}</button>`}
  </div>`;
}

function miniGoal(g) {
  const pct = g.target ? Math.min(100, ((g.saved || 0) / g.target) * 100) : 0;
  return `<div class="row mini" data-act="tab" data-tab="goals">
    <span class="emo">${esc(g.emoji || '🎯')}</span>
    <span class="grow">
      <span class="line"><span class="name">${esc(g.name)}</span><span class="amt">${Math.floor(pct)}%</span></span>
      <span class="bar good"><i style="width:${pct}%"></i></span>
      <span class="sub">${money(g.saved || 0)} из ${money(g.target || 0)}</span>
    </span>
  </div>`;
}

function onboardingView() {
  return `<section class="card">
    <h2>Давай начнём</h2>
    <p>Загрузи файл <b>seed.json</b>: в нём уже есть ваши категории, лимиты, кредиты и цели. Или начни с пустых категорий и заполни всё во вкладке «План».</p>
    <label class="btn primary">Загрузить файл<input type="file" accept=".json,application/json" data-import hidden></label>
    <button class="btn" data-act="start-empty">Начать с нуля</button>
  </section>`;
}

/* ---------- история ---------- */

function txTitle(t) {
  if (t.church) { const c = CHURCH.find((x) => x[0] === t.church); return [c?.[2] || '⛪', c?.[1] || 'Церковь']; }
  if (t.planId) { const p = S.planned.find((x) => x.id === t.planId); return [p?.emoji || '🎈', p?.name || t.title || 'Разовая трата']; }
  if (t.type === 'expense') { const c = catById(t.cat); return [c?.emoji || '•', c?.name || 'Без категории']; }
  if (t.type === 'income') return ['💰', t.source || 'Доход'];
  if (t.type === 'debt') return ['💳', S.debts.find((d) => d.id === t.debtId)?.name || 'Платёж по кредиту'];
  if (t.type === 'goal') { const g = S.goals.find((x) => x.id === t.goalId); return [g?.emoji || '🎯', 'Отложено: ' + (g?.name || 'цель')]; }
  return ['•', 'Запись'];
}

function historyView() {
  const key = S.histMonth;
  const list = (key === S.month ? S.tx : S.histTx).slice()
    .sort((a, b) => b.date.localeCompare(a.date) || (b.at || 0) - (a.at || 0));
  const sum = (type) => list.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);

  const groups = [];
  for (const t of list) {
    if (!groups.length || groups[groups.length - 1].date !== t.date) groups.push({ date: t.date, items: [] });
    groups[groups.length - 1].items.push(t);
  }
  const body = groups.map((g) => `<h3 class="day">${C.dayTitle(g.date)}</h3>` + g.items.map((t) => {
    const [emo, title] = txTitle(t);
    const sign = t.type === 'income' ? '+' : t.type === 'goal' ? '→ ' : '−';
    const who = nameOf(t.by);
    return `<div class="row tx ${t.type}">
      <span class="emo">${esc(emo)}</span>
      <span class="grow"><span class="name">${esc(title)}</span><span class="sub">${esc([t.note, who].filter(Boolean).join(' · '))}</span></span>
      <span class="amt">${sign}${money(t.amount)}</span>
      <button class="icon-btn" data-act="del-tx" data-id="${esc(t.id)}" aria-label="Удалить">✕</button>
    </div>`;
  }).join('')).join('');

  return `<section class="card">
    <div class="month-nav">
      <button class="icon-btn" data-act="hist-prev" aria-label="Предыдущий месяц">‹</button>
      <h2>${C.ymTitle(key)}</h2>
      <button class="icon-btn" data-act="hist-next" aria-label="Следующий месяц" ${key >= S.month ? 'disabled' : ''}>›</button>
    </div>
    <div class="totals">
      <div><span>Расходы</span><b>${money(sum('expense'))}</b></div>
      <div><span>Доходы</span><b class="good-text">${money(sum('income'))}</b></div>
      <div><span>Кредиты</span><b>${money(sum('debt'))}</b></div>
      <div><span>Отложено</span><b>${money(sum('goal'))}</b></div>
    </div>
  </section>
  <section class="card">${body || '<p class="muted">Записей пока нет.</p>'}</section>`;
}

/* ---------- цели ---------- */

function goalCard(g, priv) {
  const pct = g.target ? Math.min(100, ((g.saved || 0) / g.target) * 100) : 0;
  const p = C.goalPace(g, paydays());
  let pace;
  if (p.done) pace = '<span class="good-text">Собрано 🎉</span>';
  else if (!g.deadline) pace = `осталось ${money(p.left)} · без срока`;
  else if (p.late) pace = `<span class="bad-text">срок ${C.deadlineTitle(g.deadline)} прошёл, осталось ${money(p.left)}</span>`;
  else pace = `до ${C.deadlineTitle(g.deadline)} · <b>≈ ${money(p.perPayday)}</b> с каждой зарплаты (${p.count} ${C.plural(p.count, 'зарплата', 'зарплаты', 'зарплат')})`;
  const pv = priv ? '1' : '';
  return `<div class="goal">
    <div class="line"><span class="name">${esc(g.emoji || '🎯')} ${esc(g.name)}</span><span class="amt">${money(g.saved || 0)} / ${money(g.target || 0)}</span></div>
    <span class="bar good big"><i style="width:${pct}%"></i></span>
    <div class="sub">${pace}</div>
    <div class="actions">
      <button class="btn small primary" data-act="goal-add" data-id="${esc(g.id)}" data-priv="${pv}">+ Отложить</button>
      <button class="btn small" data-act="goal-edit" data-id="${esc(g.id)}" data-priv="${pv}">Изменить</button>
    </div>
  </div>`;
}

function goalsView() {
  const shared = `<section class="card">
    <h2>Общие цели</h2>
    ${S.goals.map((g) => goalCard(g, false)).join('') || '<p class="muted">Целей пока нет.</p>'}
    <button class="btn" data-act="goal-edit" data-id="">+ Новая цель</button>
  </section>`;
  let open = false;
  try { open = !!sessionStorage.getItem('budget-secret-open'); } catch { /* ничего */ }
  const priv = `<details class="card secret" ${open ? 'open' : ''}>
    <summary><h2>🔒 Скрытые цели</h2></summary>
    <p class="muted small">Видно только тебе. Эти деньги не попадают в общую историю, расходы и лимиты.</p>
    ${S.priv.map((g) => goalCard(g, true)).join('')}
    <button class="btn" data-act="goal-edit" data-id="" data-priv="1">+ Скрытая цель</button>
  </details>`;
  return shared + priv;
}

/* ---------- долги ---------- */

function debtsView() {
  const first = firstDebtId();
  const total = S.debts.reduce((s, d) => s + Math.max(0, d.balance || 0), 0);
  const interest = S.debts.reduce((s, d) => s + (d.balance > 0 ? d.balance * C.monthlyRate(d) : 0), 0);
  const cards = S.debts.map((d) => {
    const rate = C.monthlyRate(d);
    const rateText = rate ? `≈ ${money(d.balance * rate)} процентов в месяц (${(rate * 1200).toFixed(0)}% годовых${d.rateGuess ? ', примерно' : ''})` : 'ставка не указана';
    const est = (pay, label) => {
      if (!(pay > 0)) return '';
      const r = C.payoff(d.balance, rate, pay);
      if (r.never) return `<div class="kv"><span>${label} ${money(pay)}</span><b class="bad-text">не закроется: платёж меньше процентов</b></div>`;
      return `<div class="kv"><span>${label} ${money(pay)}</span><b>${C.monthsLabel(r.months)}, закроется ${C.dateAfterMonths(r.months)}${r.interest > 1 ? `, переплата ${money(r.interest)}` : ''}</b></div>`;
    };
    const plan = debtPayment(d);
    return `<div class="debt ${d.id === first ? 'first' : ''} ${d.paused ? 'paused' : ''}">
      <div class="line"><span class="name">${esc(d.name)}</span>
        ${d.id === first ? '<span class="tag">гасить первым</span>' : d.paused ? '<span class="tag gray">на паузе</span>' : ''}</div>
      <div class="debt-sum">${money(d.balance || 0)}</div>
      <div class="sub">${d.minPay ? `минимум ${money(d.minPay)} · ` : ''}${rateText}${d.dueDay ? ` · платёж до ${d.dueDay} числа` : ''}</div>
      ${d.balance > 0 ? est(d.minPay, 'Платить минимум') + (plan > (d.minPay || 0) ? est(plan, 'Платить по') : '') : '<div class="good-text">Закрыт 🎉</div>'}
      <div class="actions">
        <button class="btn small primary" data-act="pay-debt" data-id="${esc(d.id)}">Внести платёж</button>
        <button class="btn small" data-act="debt-edit" data-id="${esc(d.id)}">Обновить по выписке</button>
      </div>
    </div>`;
  }).join('');
  return `<section class="hero dark">
    <div class="hero-label">Всего долгов</div>
    <div class="hero-sum">${money(total)}</div>
    <div class="hero-sub">на проценты уходит ≈ ${money(interest)} в месяц</div>
  </section>
  <section class="card">
    ${cards || '<p class="muted">Долгов нет.</p>'}
    <button class="btn" data-act="debt-edit" data-id="">+ Добавить долг</button>
  </section>`;
}

/* ---------- план ---------- */

function planView() {
  const incomes = S.settings?.incomes || [];
  const inc = incomes.reduce((s, i) => s + (i.amount || 0), 0);
  const fixed = fixedCats().reduce((s, c) => s + (c.limit || 0), 0);
  const debts = S.debts.filter((d) => !d.paused && d.balance > 0).reduce((s, d) => s + debtPayment(d), 0);
  const life = varCats().reduce((s, c) => s + (c.limit || 0), 0);
  const thisMonth = S.planned.filter((p) => !p.done && p.date && p.date.slice(0, 7) === S.month);
  const oneOff = thisMonth.reduce((s, p) => s + (p.amount || 0), 0);
  const pct = churchPct();
  const church = round2((inc * (pct.tithe + pct.offering)) / 100);
  const free = inc - church - fixed - debts - life - oneOff;
  const catRow = (c) => `<button class="row plain" data-act="cat-edit" data-id="${esc(c.id)}">
      <span class="emo">${esc(c.emoji || '•')}</span>
      <span class="grow name">${esc(c.name)}${c.kind === 'fixed' && c.day ? ` <span class="muted small">до ${c.day} числа</span>` : ''}</span>
      <span class="amt">${money(c.limit || 0)}</span></button>`;

  const cash = S.settings?.cash;
  const cashTotal = cashNow();
  const cashCard = `<section class="card">
    <h2>Деньги сейчас ${cashTotal != null ? `<span class="small">${money(cashTotal)}</span>` : ''}</h2>
    ${cash?.accounts?.length ? cash.accounts.map((a) => `<div class="row plain"><span class="emo">💳</span><span class="grow name">${esc(a.name)}</span><span class="amt">${money(a.amount || 0)}</span></div>`).join('')
      + `<p class="muted small">Сверено ${new Date(cash.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. Дальше остаток считается по записям.</p>`
      : '<p class="muted small">Внеси, сколько сейчас на картах и наличными, — от этого считается, сколько можно тратить до зарплаты.</p>'}
    <button class="btn small" data-act="cash">${cash?.accounts?.length ? 'Сверить с банком' : 'Внести остатки'}</button>
  </section>`;

  const plannedRows = S.planned.filter((p) => !p.done).map((p) => `<button class="row plain" data-act="plan-edit" data-id="${esc(p.id)}">
      <span class="emo">${esc(p.emoji || '🎈')}</span>
      <span class="grow name">${esc(p.name)} <span class="muted small">${p.date ? C.dayTitle(p.date).toLowerCase() : ''}</span></span>
      <span class="amt">${money(p.amount || 0)}</span></button>`).join('');
  const plannedCard = `<section class="card">
    <h2>Разовые траты</h2>
    ${plannedRows || '<p class="muted small">Праздники, ремонт, техосмотр — всё, что бывает не каждый месяц.</p>'}
    <button class="btn small" data-act="plan-edit" data-id="">+ Разовая трата</button>
  </section>`;

  return cashCard + `<section class="card">
    <h2>Деньги на месяц</h2>
    ${incomes.map((i) => `<button class="row plain" data-act="income-edit" data-id="${esc(i.id)}">
      <span class="emo">💰</span><span class="grow name">${esc(i.name)}</span><span class="amt good-text">+${money(i.amount || 0)}</span></button>`).join('')}
    <button class="btn small" data-act="income-edit" data-id="">+ Доход</button>
    <div class="sum-table">
      <div class="kv"><span>Доход в месяц</span><b>${money(inc)}</b></div>
      ${church ? `<div class="kv"><span>− Десятина и пожертвования, ${pct.tithe + pct.offering}%</span><b>${money(church)}</b></div>` : ''}
      <div class="kv"><span>− Обязательные платежи</span><b>${money(fixed)}</b></div>
      <div class="kv"><span>− Кредиты</span><b>${money(debts)}</b></div>
      <div class="kv"><span>− Лимиты на жизнь</span><b>${money(life)}</b></div>
      ${oneOff ? `<div class="kv"><span>− Разовые в ${C.MONTHS_PREP[Number(S.month.slice(5)) - 1]}</span><b>${money(oneOff)}</b></div>` : ''}
      <div class="kv total"><span>Свободно на цели и досрочку</span><b class="${free < 0 ? 'bad-text' : 'good-text'}">${money(free)}</b></div>
    </div>
    <p class="muted small">Подработку в план не закладываем: что пришло сверху, сразу в цели или в самый дорогой долг (после десятины и пожертвований с неё).</p>
  </section>
  <section class="card">
    <h2>Лимиты на жизнь <span class="muted small">${money(life)}</span></h2>
    ${varCats().map(catRow).join('')}
    <h2 class="mt">Обязательные платежи <span class="muted small">${money(fixed)}</span></h2>
    ${fixedCats().map(catRow).join('')}
    <button class="btn" data-act="cat-edit" data-id="">+ Категория</button>
  </section>
  ${plannedCard}
  <section class="card">
    <h2>Настройки</h2>
    <button class="row plain" data-act="paydays"><span class="emo">📅</span><span class="grow name">Дни зарплаты</span><span class="amt">${paydays().join(' и ')}</span></button>
    <button class="row plain" data-act="church"><span class="emo">⛪</span><span class="grow name">Десятина и пожертвования</span><span class="amt">${pct.tithe}% + ${pct.offering}%</span></button>
    <button class="row plain" data-act="ics"><span class="emo">🔔</span><span class="grow name">Напоминания в календарь телефона</span><span class="amt">›</span></button>
    <label class="row plain"><span class="emo">📥</span><span class="grow name">Загрузить данные из файла</span><span class="amt">›</span><input type="file" accept=".json,application/json" data-import hidden></label>
    <button class="row plain" data-act="logout"><span class="emo">👤</span><span class="grow name">${esc(myName())}</span><span class="amt muted">Выйти</span></button>
  </section>`;
}

/* ---------- шторки ---------- */

function openSheet(html) {
  const el = $('#sheet');
  el.innerHTML = `<div class="sheet-back" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  el.hidden = false;
  document.body.classList.add('locked');
}
function closeSheet() {
  const el = $('#sheet');
  el.hidden = true;
  el.innerHTML = '';
  document.body.classList.remove('locked');
}

function field(label, name, value = '', attrs = '') {
  return `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
}
const numAttrs = 'inputmode="decimal" autocomplete="off"';

function openAdd(opts = {}) {
  const mode = opts.mode || 'expense';
  const spent = spentByCat(S.tx);
  let chips = '';
  if (mode === 'expense') {
    const counts = {};
    for (const t of S.tx) if (t.type === 'expense') counts[t.cat] = (counts[t.cat] || 0) + 1;
    const list = varCats().sort((a, b) => (b.id === opts.cat) - (a.id === opts.cat) || (counts[b.id] || 0) - (counts[a.id] || 0) || byOrder(a, b));
    const chip = (c) => {
      const left = (c.limit || 0) - (spent[c.id] || 0);
      const hint = c.limit ? (left >= 0 ? 'ост. ' + money(left) : 'перебор ' + money(-left)) : '';
      return `<button type="button" class="chip ${c.id === opts.cat ? 'pre' : ''} ${c.limit && left <= 0 ? 'over' : ''}" data-act="save-tx" data-cat="${esc(c.id)}">
        <span>${esc(c.emoji || '•')} ${esc(c.name)}</span>${hint ? `<small>${hint}</small>` : ''}</button>`;
    };
    chips = `<div class="chips">${list.map(chip).join('')}</div>`;
    if (fixedCats().length) {
      chips += `<details class="more"><summary>Обязательные платежи</summary><div class="chips">${fixedCats().map(chip).join('')}</div></details>`;
    }
  } else {
    const names = [...new Set([...(S.settings?.incomes || []).map((i) => i.name), 'Подработка', 'Другой доход'])];
    chips = `<div class="chips">${names.map((n) => `<button type="button" class="chip" data-act="save-income" data-src="${esc(n)}"><span>💰 ${esc(n)}</span></button>`).join('')}</div>`;
  }
  openSheet(`
    <div class="seg">
      <button data-act="qa-mode" data-mode="expense" class="${mode === 'expense' ? 'on' : ''}">Расход</button>
      <button data-act="qa-mode" data-mode="income" class="${mode === 'income' ? 'on' : ''}">Доход</button>
    </div>
    <input id="qa-amt" class="amount" ${numAttrs} placeholder="0 ₽" value="${esc(opts.amt || '')}" aria-label="Сумма">
    <div class="qa-row">
      <input id="qa-note" placeholder="Комментарий" value="${esc(opts.note || '')}" autocomplete="off">
      <input id="qa-date" type="date" value="${esc(opts.date || C.isoDate())}" aria-label="Дата">
    </div>
    <p class="hint">${mode === 'expense' ? 'Введи сумму и нажми категорию — сразу запишется.' : 'Введи сумму и нажми, откуда деньги.'}</p>
    ${chips}`);
  $('#qa-amt').focus();
}

function readQuick() {
  const amount = round2(C.num($('#qa-amt').value));
  if (!(amount > 0)) {
    toast('Сначала введи сумму', 'bad');
    $('#qa-amt').focus();
    return null;
  }
  return { amount, note: $('#qa-note').value.trim(), date: $('#qa-date').value || C.isoDate() };
}

function saveExpense(catId) {
  const q = readQuick();
  if (!q) return;
  const c = catById(catId);
  if (!c) return;
  const sameMonth = q.date.slice(0, 7) === S.month;
  const s = sameMonth ? spentByCat(S.tx)[c.id] || 0 : 0;
  if (sameMonth && c.kind !== 'fixed' && c.limit > 0 && s + q.amount > c.limit) {
    if (!confirm(`Это выйдет за лимит «${c.name}» на ${money(s + q.amount - c.limit)}. Всё равно записать?`)) return;
  }
  addTx({ type: 'expense', cat: c.id, ...q });
  closeSheet();
  const left = c.limit ? c.limit - s - q.amount : null;
  toast(`−${money(q.amount)} · ${c.name}${left != null && sameMonth ? (left >= 0 ? `. Осталось ${money(left)}` : `. Перебор ${money(-left)}`) : ''}`, left != null && left < 0 ? 'bad' : '');
}

function saveIncome(src) {
  const q = readQuick();
  if (!q) return;
  addTx({ type: 'income', source: src, ...q });
  closeSheet();
  toast(`+${money(q.amount)} · ${src}`);
  const inc = (S.settings?.incomes || []).find((i) => i.name === src);
  if (inc) askPaydayReceived(inc.day);
}

// Зарплату дали раньше срока — дальше «можно тратить» считаем до следующей.
// day — число из названия дохода («Зарплата Сэма, 15-е»): тогда спрашиваем именно про него.
function askPaydayReceived(day) {
  const today = C.startOfDay(new Date());
  const received = S.settings?.received || [];
  const soon = C.paydaysBetween(today, new Date(today.getTime() + (day ? 25 : 11) * 864e5), paydays())
    .find((d) => !received.includes(C.isoDate(d)) && (!day || d.getDate() === Math.min(day, C.daysInMonth(d.getFullYear(), d.getMonth()))));
  if (!soon) return;
  const after = C.paydaysBetween(new Date(soon.getTime() + 864e5), new Date(soon.getFullYear(), soon.getMonth() + 3, 1), paydays())[0];
  const title = (d) => d.getDate() + ' ' + C.MONTHS_GEN[d.getMonth()];
  setTimeout(() => {
    if (confirm(`Это зарплата за ${title(soon)}? Тогда «можно тратить» буду считать до следующей${after ? ', ' + title(after) : ''}.`)) {
      save(H, { received: [...received, C.isoDate(soon)].slice(-24) });
    }
  }, 50);
}

function openPayCat(id) {
  const c = catById(id);
  if (!c) return;
  const paid = spentByCat(S.tx)[c.id] || 0;
  openSheet(`<form data-form="pay-cat" data-id="${esc(id)}">
    <h2>${esc(c.emoji || '')} ${esc(c.name)}</h2>
    ${field('Сумма', 'amount', Math.max(0, (c.limit || 0) - paid) || '', numAttrs + ' required')}
    ${field('Дата', 'date', C.isoDate(), 'type="date"')}
    <button class="btn primary">Записать оплату</button>
  </form>`);
}

function openPayDebt(id) {
  const d = S.debts.find((x) => x.id === id);
  if (!d) return;
  openSheet(`<form data-form="pay-debt" data-id="${esc(id)}">
    <h2>💳 ${esc(d.name)}</h2>
    <p class="muted small">Сейчас долг ${money(d.balance || 0)}${d.minPay ? `, минимум ${money(d.minPay)}` : ''}. Платёж уменьшит остаток.</p>
    ${field('Сумма платежа', 'amount', debtPayment(d) || '', numAttrs + ' required')}
    ${field('Дата', 'date', C.isoDate(), 'type="date"')}
    <button class="btn primary">Записать платёж</button>
  </form>`);
}

function openDebtEdit(id) {
  const d = S.debts.find((x) => x.id === id) || {};
  openSheet(`<form data-form="debt-edit" data-id="${esc(id || '')}">
    <h2>${id ? 'Обновить по выписке' : 'Новый долг'}</h2>
    ${field('Название', 'name', d.name || '', 'required')}
    ${field('Сколько осталось, ₽', 'balance', d.balance ?? '', numAttrs + ' required')}
    ${field('Минимальный платёж, ₽', 'minPay', d.minPay ?? '', numAttrs)}
    ${field('Начисленные проценты за месяц из выписки, ₽', 'interest', d.interest ?? '', numAttrs)}
    ${field('Или годовая ставка, %', 'ratePct', d.ratePct ?? '', numAttrs)}
    ${field('Сколько платим в месяц (план), ₽', 'plan', d.plan ?? '', numAttrs)}
    ${field('Платить до какого числа', 'dueDay', d.dueDay ?? '', 'inputmode="numeric"')}
    <label class="check-label"><input type="checkbox" name="paused" ${d.paused ? 'checked' : ''}> На паузе (пока не гасим)</label>
    <button class="btn primary">Сохранить</button>
    ${id ? '<button type="button" class="btn danger" data-act="debt-del" data-id="' + esc(id) + '">Удалить долг</button>' : ''}
  </form>`);
}

function goalList(priv) { return priv ? S.priv : S.goals; }
function goalPath(id, priv) { return priv ? `private/${S.user.uid}/goals/${id}` : `${H}/goals/${id}`; }

function openGoalAdd(id, priv) {
  const g = goalList(priv).find((x) => x.id === id);
  if (!g) return;
  openSheet(`<form data-form="goal-add" data-id="${esc(id)}" data-priv="${priv ? '1' : ''}">
    <h2>${esc(g.emoji || '🎯')} ${esc(g.name)}</h2>
    <p class="muted small">Собрано ${money(g.saved || 0)} из ${money(g.target || 0)}.${priv ? ' Это скрытая цель: запись не попадёт в общую историю.' : ''}</p>
    ${field('Сколько отложить, ₽', 'amount', '', numAttrs + ' required')}
    <button class="btn primary">Отложить</button>
  </form>`);
  document.querySelector('#sheet input[name=amount]').focus();
}

function openGoalEdit(id, priv) {
  const g = goalList(priv).find((x) => x.id === id) || {};
  openSheet(`<form data-form="goal-edit" data-id="${esc(id || '')}" data-priv="${priv ? '1' : ''}">
    <h2>${id ? 'Цель' : priv ? 'Новая скрытая цель' : 'Новая цель'}</h2>
    ${priv ? '<p class="muted small">🔒 Видно только тебе.</p>' : ''}
    <div class="two">${field('Значок', 'emoji', g.emoji || '🎯', 'maxlength="4" class="emoji-input"')}${field('Название', 'name', g.name || '', 'required')}</div>
    ${field('Сколько нужно, ₽', 'target', g.target ?? '', numAttrs + ' required')}
    ${field('Уже собрано, ₽', 'saved', g.saved ?? 0, numAttrs)}
    ${field('К какой дате (можно пусто)', 'deadline', g.deadline || '', 'type="date"')}
    <button class="btn primary">Сохранить</button>
    ${id ? `<button type="button" class="btn danger" data-act="goal-del" data-id="${esc(id)}" data-priv="${priv ? '1' : ''}">Удалить цель</button>` : ''}
  </form>`);
}

function openCatEdit(id) {
  const c = catById(id) || { kind: 'var' };
  openSheet(`<form data-form="cat-edit" data-id="${esc(id || '')}">
    <h2>${id ? 'Категория' : 'Новая категория'}</h2>
    <div class="two">${field('Значок', 'emoji', c.emoji || '•', 'maxlength="4" class="emoji-input"')}${field('Название', 'name', c.name || '', 'required')}</div>
    <label>Тип<select name="kind">
      <option value="var" ${c.kind !== 'fixed' ? 'selected' : ''}>Тратим в течение месяца (лимит)</option>
      <option value="fixed" ${c.kind === 'fixed' ? 'selected' : ''}>Обязательный платёж</option>
    </select></label>
    ${field('Сумма в месяц, ₽', 'limit', c.limit ?? '', numAttrs)}
    ${field('Для обязательных: платить до какого числа', 'day', c.day ?? '', 'inputmode="numeric"')}
    <button class="btn primary">Сохранить</button>
    ${id ? `<button type="button" class="btn danger" data-act="cat-del" data-id="${esc(id)}">Удалить категорию</button>` : ''}
  </form>`);
}

function openIncomeEdit(id) {
  const i = (S.settings?.incomes || []).find((x) => x.id === id) || {};
  openSheet(`<form data-form="income-edit" data-id="${esc(id || '')}">
    <h2>${id ? 'Доход' : 'Новый доход'}</h2>
    ${field('Название', 'name', i.name || '', 'required')}
    ${field('Сумма в месяц, ₽', 'amount', i.amount ?? '', numAttrs + ' required')}
    <button class="btn primary">Сохранить</button>
    ${id ? `<button type="button" class="btn danger" data-act="income-del" data-id="${esc(id)}">Удалить</button>` : ''}
  </form>`);
}

function cashRow(a = {}) {
  return `<div class="cash-row">
    <input name="acc-name" placeholder="Карта или наличные" value="${esc(a.name || '')}" autocomplete="off" aria-label="Название">
    <input name="acc-amount" placeholder="0" value="${a.amount != null ? esc(a.amount) : ''}" ${numAttrs} aria-label="Сумма">
  </div>`;
}

function openCash() {
  const accounts = S.settings?.cash?.accounts || [];
  const now = cashNow();
  openSheet(`<form data-form="cash">
    <h2>Сколько денег сейчас</h2>
    <p class="muted small">Открой банки и впиши, что на каждой карте и наличными.${now != null ? ` По записям сейчас должно быть ${money(now)}.` : ''}</p>
    <div id="cash-rows">${(accounts.length ? accounts : [{}, {}]).map(cashRow).join('')}</div>
    <button type="button" class="btn small" data-act="cash-add">+ Ещё счёт</button>
    <button class="btn primary">Сохранить</button>
  </form>`);
}

function openPlanEdit(id) {
  const p = S.planned.find((x) => x.id === id) || {};
  openSheet(`<form data-form="plan-edit" data-id="${esc(id || '')}">
    <h2>${id ? 'Разовая трата' : 'Новая разовая трата'}</h2>
    <div class="two">${field('Значок', 'emoji', p.emoji || '🎈', 'maxlength="4" class="emoji-input"')}${field('Что', 'name', p.name || '', 'required')}</div>
    ${field('Сколько, ₽', 'amount', p.amount ?? '', numAttrs + ' required')}
    ${field('Когда', 'date', p.date || C.isoDate(), 'type="date" required')}
    <p class="muted small">Сумма вычтется из «можно тратить до зарплаты», если дата раньше зарплаты, и не съест месячные лимиты.</p>
    <button class="btn primary">Сохранить</button>
    ${id ? `<button type="button" class="btn danger" data-act="plan-del" data-id="${esc(id)}">Удалить</button>` : ''}
  </form>`);
}

function openPayPlan(id) {
  const p = S.planned.find((x) => x.id === id);
  if (!p) return;
  openSheet(`<form data-form="pay-plan" data-id="${esc(id)}">
    <h2>${esc(p.emoji || '🎈')} ${esc(p.name)}</h2>
    <p class="muted small">Впиши, сколько вышло на самом деле.</p>
    ${field('Потратили, ₽', 'amount', p.amount || '', numAttrs + ' required')}
    ${field('Дата', 'date', C.isoDate(), 'type="date"')}
    <button class="btn primary">Записать</button>
  </form>`);
}

function openChurch() {
  const pct = churchPct();
  openSheet(`<form data-form="church">
    <h2>Десятина и пожертвования</h2>
    <p class="muted small">Считаются от каждого внесённого дохода, включая подработку. Сумма «к отдаче» появляется в платежах месяца сразу после записи дохода.</p>
    ${field('Десятина, %', 'tithe', pct.tithe, numAttrs)}
    ${field('Пожертвования, %', 'offering', pct.offering, numAttrs)}
    <button class="btn primary">Сохранить</button>
  </form>`);
}

function openPayChurch(key) {
  const item = paymentItems().find((i) => i.kind === 'church' && i.id === key);
  if (!item) return;
  openSheet(`<form data-form="pay-church" data-id="${esc(key)}">
    <h2>${esc(item.emoji)} ${esc(item.name)}</h2>
    <p class="muted small">${esc(item.whenText)}: ${money(item.amount)}${item.paid ? `, уже отдано ${money(item.paid)}` : ''}.</p>
    ${field('Сколько отдали, ₽', 'amount', Math.max(0, round2(item.amount - item.paid)) || '', numAttrs + ' required')}
    ${field('Дата', 'date', C.isoDate(), 'type="date"')}
    <button class="btn primary">Записать</button>
  </form>`);
}

function openPaydays() {
  openSheet(`<form data-form="paydays">
    <h2>Дни зарплаты</h2>
    ${field('Числа через запятую', 'days', paydays().join(', '), 'inputmode="numeric" required')}
    <p class="muted small">По ним считается, сколько откладывать с каждой зарплаты на цели.</p>
    <button class="btn primary">Сохранить</button>
  </form>`);
}

function openIcs() {
  openSheet(`<h2>Напоминания</h2>
    <p>Скачаю файл для календаря телефона. В нём ежемесячные напоминания в 10:00:</p>
    <ul class="small">
      <li>в дни зарплаты — записать доход и отложить на цели;</li>
      <li>обязательные платежи, у которых указано число;</li>
      <li>платежи по кредитам, у которых указано «платить до».</li>
    </ul>
    <p class="muted small">На айфоне открой файл и нажми «Добавить все». Если поменяете числа, скачай файл заново, а старые события удали.</p>
    <button class="btn primary" data-act="ics-download">Скачать напоминания</button>`);
}

/* ---------- формы ---------- */

const FORMS = {
  async login(f, fd) {
    const err = f.querySelector('#login-err');
    err.textContent = '';
    try {
      await S.store.signIn(fd.get('email'), fd.get('password'));
      try { localStorage.setItem('budget-last-email', String(fd.get('email')).trim()); } catch { /* ничего */ }
    } catch (e) {
      err.textContent = /invalid|wrong|not-found|credential/.test(e?.code || '') ? 'Неверная почта или пароль' : 'Не получилось войти: ' + (e?.code || e?.message || e);
    }
  },
  name(f, fd) {
    const name = String(fd.get('name')).trim();
    if (name) save(H, { names: { [S.user.uid]: name } });
  },
  'pay-cat'(f, fd) {
    const amount = round2(C.num(fd.get('amount')));
    if (!(amount > 0)) return toast('Сумма должна быть больше нуля', 'bad');
    const c = catById(f.dataset.id);
    addTx({ type: 'expense', cat: c.id, amount, note: '', date: fd.get('date') || C.isoDate() });
    closeSheet();
    toast(`${c.name}: оплачено ${money(amount)}`);
  },
  'pay-debt'(f, fd) {
    const amount = round2(C.num(fd.get('amount')));
    if (!(amount > 0)) return toast('Сумма должна быть больше нуля', 'bad');
    const d = S.debts.find((x) => x.id === f.dataset.id);
    addTx({ type: 'debt', debtId: d.id, amount, note: '', date: fd.get('date') || C.isoDate() });
    const balance = Math.max(0, round2((d.balance || 0) - amount));
    save(`${H}/debts/${d.id}`, { balance });
    closeSheet();
    toast(`${d.name}: осталось ${money(balance)}`);
  },
  'debt-edit'(f, fd) {
    const id = f.dataset.id || S.store.newId(`${H}/debts`);
    const n = (k) => round2(C.num(fd.get(k)));
    const data = {
      name: String(fd.get('name')).trim(),
      balance: n('balance'), minPay: n('minPay'), interest: n('interest'), ratePct: n('ratePct'),
      plan: n('plan'), dueDay: Math.min(31, Math.max(0, Math.round(n('dueDay')))) || null,
      paused: fd.get('paused') === 'on',
    };
    data.rate = rateOf(data);
    const old = S.debts.find((x) => x.id === f.dataset.id);
    data.rateGuess = !!(old?.rateGuess && old.ratePct === data.ratePct && !data.interest);
    if (!f.dataset.id) data.order = nextOrder(S.debts);
    save(`${H}/debts/${id}`, data);
    closeSheet();
  },
  'goal-add'(f, fd) {
    const priv = !!f.dataset.priv;
    const amount = round2(C.num(fd.get('amount')));
    if (!(amount > 0)) return toast('Сумма должна быть больше нуля', 'bad');
    const g = goalList(priv).find((x) => x.id === f.dataset.id);
    save(goalPath(g.id, priv), { saved: round2((g.saved || 0) + amount) });
    if (!priv) addTx({ type: 'goal', goalId: g.id, amount, note: '', date: C.isoDate() });
    closeSheet();
    toast(`${g.name}: +${money(amount)}`);
  },
  'goal-edit'(f, fd) {
    const priv = !!f.dataset.priv;
    const base = priv ? `private/${S.user.uid}/goals` : `${H}/goals`;
    const id = f.dataset.id || S.store.newId(base);
    const data = {
      emoji: String(fd.get('emoji')).trim() || '🎯',
      name: String(fd.get('name')).trim(),
      target: round2(C.num(fd.get('target'))),
      saved: round2(C.num(fd.get('saved'))),
      deadline: fd.get('deadline') || '',
    };
    if (!f.dataset.id) data.order = nextOrder(goalList(priv));
    save(`${base}/${id}`, data);
    closeSheet();
  },
  'cat-edit'(f, fd) {
    const id = f.dataset.id || S.store.newId(`${H}/cats`);
    const kind = fd.get('kind') === 'fixed' ? 'fixed' : 'var';
    const data = {
      emoji: String(fd.get('emoji')).trim() || '•',
      name: String(fd.get('name')).trim(),
      kind,
      limit: round2(C.num(fd.get('limit'))),
      day: kind === 'fixed' ? Math.min(31, Math.max(0, Math.round(C.num(fd.get('day'))))) || null : null,
    };
    if (!f.dataset.id) data.order = nextOrder(S.cats);
    save(`${H}/cats/${id}`, data);
    closeSheet();
  },
  'income-edit'(f, fd) {
    const list = [...(S.settings?.incomes || [])];
    const item = { id: f.dataset.id || 'i' + Date.now().toString(36), name: String(fd.get('name')).trim(), amount: round2(C.num(fd.get('amount'))) };
    const idx = list.findIndex((x) => x.id === item.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...item }; else list.push(item);
    save(H, { incomes: list });
    closeSheet();
  },
  cash(f, fd) {
    const names = fd.getAll('acc-name');
    const amounts = fd.getAll('acc-amount');
    const accounts = names.map((n, i) => ({ name: String(n).trim(), amount: round2(C.num(amounts[i])) }))
      .filter((a) => a.name || a.amount)
      .map((a, i) => ({ id: 'a' + (i + 1), name: a.name || 'Счёт ' + (i + 1), amount: a.amount }));
    if (!accounts.length) return toast('Впиши хотя бы один счёт', 'bad');
    save(H, { cash: { accounts, at: Date.now() } }, true);
    closeSheet();
    toast('Сохранено: ' + money(accounts.reduce((s, a) => s + a.amount, 0)));
  },
  'plan-edit'(f, fd) {
    const id = f.dataset.id || S.store.newId(`${H}/planned`);
    save(`${H}/planned/${id}`, {
      emoji: String(fd.get('emoji')).trim() || '🎈',
      name: String(fd.get('name')).trim(),
      amount: round2(C.num(fd.get('amount'))),
      date: fd.get('date') || C.isoDate(),
      done: false,
    });
    closeSheet();
  },
  'pay-plan'(f, fd) {
    const amount = round2(C.num(fd.get('amount')));
    if (!(amount > 0)) return toast('Сумма должна быть больше нуля', 'bad');
    const p = S.planned.find((x) => x.id === f.dataset.id);
    addTx({ type: 'expense', cat: null, planId: p.id, title: p.name, amount, note: '', date: fd.get('date') || C.isoDate() });
    save(`${H}/planned/${p.id}`, { done: true });
    closeSheet();
    toast(`${p.name}: −${money(amount)}`);
  },
  church(f, fd) {
    const clamp = (v) => Math.min(100, Math.max(0, round2(C.num(v))));
    save(H, { church: { tithe: clamp(fd.get('tithe')), offering: clamp(fd.get('offering')) } });
    closeSheet();
  },
  'pay-church'(f, fd) {
    const amount = round2(C.num(fd.get('amount')));
    if (!(amount > 0)) return toast('Сумма должна быть больше нуля', 'bad');
    const key = f.dataset.id;
    addTx({ type: 'expense', cat: null, church: key, amount, note: '', date: fd.get('date') || C.isoDate() });
    closeSheet();
    toast(`${CHURCH.find((x) => x[0] === key)?.[1]}: ${money(amount)}`);
  },
  paydays(f, fd) {
    const days = [...new Set(String(fd.get('days')).split(/[^\d]+/).map(Number).filter((d) => d >= 1 && d <= 31))].sort((a, b) => a - b);
    if (!days.length) return toast('Укажи хотя бы одно число', 'bad');
    save(H, { paydays: days });
    closeSheet();
  },
};

/* ---------- действия ---------- */

const ACTIONS = {
  tab(el) {
    S.view = el.dataset.tab;
    scheduleRender();
    window.scrollTo(0, 0);
  },
  close: closeSheet,
  add(el) { openAdd({ cat: el.dataset.cat }); },
  'qa-mode'(el) {
    openAdd({ mode: el.dataset.mode, amt: $('#qa-amt').value, note: $('#qa-note').value, date: $('#qa-date').value });
  },
  'save-tx'(el) { saveExpense(el.dataset.cat); },
  'save-income'(el) { saveIncome(el.dataset.src); },
  'pay-cat'(el) { openPayCat(el.dataset.id); },
  'pay-debt'(el) { openPayDebt(el.dataset.id); },
  'debt-edit'(el) { openDebtEdit(el.dataset.id); },
  'debt-del'(el) {
    const d = S.debts.find((x) => x.id === el.dataset.id);
    if (d && confirm(`Удалить «${d.name}»?`)) { remove(`${H}/debts/${d.id}`); closeSheet(); }
  },
  'goal-add'(el) { openGoalAdd(el.dataset.id, !!el.dataset.priv); },
  'goal-edit'(el) { openGoalEdit(el.dataset.id, !!el.dataset.priv); },
  'goal-del'(el) {
    const priv = !!el.dataset.priv;
    const g = goalList(priv).find((x) => x.id === el.dataset.id);
    if (g && confirm(`Удалить цель «${g.name}»?`)) { remove(goalPath(g.id, priv)); closeSheet(); }
  },
  'cat-edit'(el) { openCatEdit(el.dataset.id); },
  'cat-del'(el) {
    const c = catById(el.dataset.id);
    if (c && confirm(`Удалить категорию «${c.name}»? Старые записи останутся, но будут без категории.`)) { remove(`${H}/cats/${c.id}`); closeSheet(); }
  },
  'income-edit'(el) { openIncomeEdit(el.dataset.id); },
  'income-del'(el) {
    save(H, { incomes: (S.settings?.incomes || []).filter((x) => x.id !== el.dataset.id) });
    closeSheet();
  },
  paydays: openPaydays,
  church: openChurch,
  'pay-church'(el) { openPayChurch(el.dataset.id); },
  cash: openCash,
  'cash-add'() {
    $('#cash-rows').insertAdjacentHTML('beforeend', cashRow());
    const inputs = document.querySelectorAll('#cash-rows input[name="acc-name"]');
    inputs[inputs.length - 1].focus();
  },
  'plan-edit'(el) { openPlanEdit(el.dataset.id); },
  'pay-plan'(el) { openPayPlan(el.dataset.id); },
  'plan-del'(el) {
    const p = S.planned.find((x) => x.id === el.dataset.id);
    if (p && confirm(`Удалить «${p.name}»?`)) { remove(`${H}/planned/${p.id}`); closeSheet(); }
  },
  ics: openIcs,
  'ics-download'() { downloadIcs(); closeSheet(); },
  'del-tx'(el) { deleteTx(el.dataset.id); },
  'hist-prev'() { S.histMonth = C.ymShift(S.histMonth, -1); watchHistory(); scheduleRender(); },
  'hist-next'() {
    if (S.histMonth >= S.month) return;
    S.histMonth = C.ymShift(S.histMonth, 1); watchHistory(); scheduleRender();
  },
  'demo-login'(el) {
    const name = el.dataset.name;
    S.store.signIn(name).then(() => save(H, { names: { ['demo-' + name]: name } }));
  },
  logout() {
    if (confirm('Выйти из аккаунта?')) S.store.signOut();
  },
  'start-empty'() { startEmpty(); },
};

function deleteTx(id) {
  const key = S.histMonth;
  const list = key === S.month ? S.tx : S.histTx;
  const t = list.find((x) => x.id === id);
  if (!t) return;
  const [, title] = txTitle(t);
  if (!confirm(`Удалить «${title}» на ${money(t.amount)}?`)) return;
  remove(`${txPath(key)}/${id}`);
  if (t.planId && S.planned.some((x) => x.id === t.planId)) save(`${H}/planned/${t.planId}`, { done: false });
  if (t.type === 'goal') {
    const g = S.goals.find((x) => x.id === t.goalId);
    if (g) save(`${H}/goals/${g.id}`, { saved: Math.max(0, round2((g.saved || 0) - t.amount)) });
  }
  if (t.type === 'debt') {
    const d = S.debts.find((x) => x.id === t.debtId);
    if (d) save(`${H}/debts/${d.id}`, { balance: round2((d.balance || 0) + t.amount) });
  }
}

function startEmpty() {
  const cats = [
    ['🛒', 'Продукты'], ['🍔', 'Кафе и доставка'], ['🧴', 'Дом и аптека'], ['👕', 'Одежда и личное'],
    ['🎉', 'Развлечения'], ['🎁', 'Подарки'], ['📦', 'Другое'],
  ];
  cats.forEach(([emoji, name], i) => save(`${H}/cats/${S.store.newId(`${H}/cats`)}`, { emoji, name, kind: 'var', limit: 0, order: i + 1 }));
  save(H, { paydays: paydays(), incomes: S.settings?.incomes || [] });
  S.view = 'plan';
  scheduleRender();
}

async function importFile(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch { toast('Это не файл с данными', 'bad'); return; }
  // Файл может быть полным (seed.json) или частичным: меняется только то, что в нём есть.
  const parts = [];
  if (d.settings?.paydays) parts.push('дни зарплаты');
  if (d.settings?.incomes) parts.push('доходы');
  if (d.settings?.church) parts.push('десятина');
  if (d.cash?.accounts?.length) parts.push('остатки на картах');
  const names = { cats: 'категории', debts: 'долги', goals: 'цели', planned: 'разовые траты' };
  for (const k of Object.keys(names)) if (d[k]?.length) parts.push(names[k]);
  if (!parts.length) { toast('В файле нечего загружать', 'bad'); return; }
  if (!confirm(`Загрузить из файла: ${parts.join(', ')}? Остальное не изменится.`)) return;

  const settings = {};
  for (const k of ['paydays', 'incomes', 'church']) if (d.settings?.[k]) settings[k] = d.settings[k];
  if (d.cash?.accounts?.length) settings.cash = { accounts: d.cash.accounts, at: Date.now() };
  if (Object.keys(settings).length) save(H, settings);

  for (const kind of Object.keys(names)) {
    const current = { cats: S.cats, debts: S.debts, goals: S.goals, planned: S.planned }[kind];
    let order = nextOrder(current);
    for (const item of d[kind] || []) {
      const { id, ...rest } = item;
      const old = id && current.find((x) => x.id === id);
      if (!old && rest.order == null) rest.order = order++;
      if (kind === 'debts') rest.rate = rateOf({ ...(old || {}), ...rest });
      save(`${H}/${kind}/${id || S.store.newId(`${H}/${kind}`)}`, rest);
    }
  }
  toast('Загружено: ' + parts.join(', '));
}

/* ---------- календарь ---------- */

function downloadIcs() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const events = [];
  const add = (key, day, title, text) => {
    // Первое срабатывание — ближайшее такое число, начиная с сегодня.
    let first = null;
    for (let k = 0; k < 13 && !first; k++) {
      const y = now.getFullYear(), m = now.getMonth() + k;
      const dt = new Date(y, m, day);
      if (dt.getDate() === day && dt >= C.startOfDay(now)) first = dt;
    }
    if (!first) return;
    const d = `${first.getFullYear()}${pad(first.getMonth() + 1)}${pad(first.getDate())}`;
    events.push([
      'BEGIN:VEVENT',
      `UID:budget-${key}@nash-budget`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${d}T100000`,
      'DURATION:PT15M',
      `RRULE:FREQ=MONTHLY;BYMONTHDAY=${day}`,
      `SUMMARY:${icsText(title)}`,
      `DESCRIPTION:${icsText(text)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0S', `DESCRIPTION:${icsText(title)}`, 'END:VALARM',
      'END:VEVENT',
    ].join('\r\n'));
  };
  for (const day of paydays()) add(`payday-${day}`, day, 'Зарплата: записать доход и отложить на цели', 'Открой «Наш бюджет», запиши доход и отложи на цели.');
  for (const c of fixedCats()) if (c.day) add(`cat-${c.id}`, c.day, `Оплатить: ${c.name} — ${money(c.limit || 0)}`, 'После оплаты отметь в приложении.');
  for (const d of S.debts) if (d.dueDay && !d.paused) add(`debt-${d.id}`, d.dueDay, `Платёж: ${d.name} — ${money(debtPayment(d))}`, `Минимум ${money(d.minPay || 0)}. После оплаты отметь в приложении.`);
  if (!events.length) { toast('Нет дат для напоминаний', 'bad'); return; }
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//nash-budget//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR'].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'napominaniya-budget.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------- уведомления ---------- */

let toastTimer;
function toast(text, kind = '') {
  const el = $('#toast');
  el.textContent = text;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast ' + kind; }, 3200);
}

/* ---------- события ---------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el);
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  FORMS[f.dataset.form]?.(f, new FormData(f));
});

document.addEventListener('change', (e) => {
  if (e.target.matches('input[data-import]') && e.target.files[0]) {
    importFile(e.target.files[0]);
    e.target.value = '';
  }
});

document.addEventListener('toggle', (e) => {
  if (e.target.matches?.('details.secret')) {
    try {
      if (e.target.open) sessionStorage.setItem('budget-secret-open', '1');
      else sessionStorage.removeItem('budget-secret-open');
    } catch { /* ничего */ }
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
});

/* ---------- старт ---------- */

(async function boot() {
  try {
    S.store = await createStore();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = '<div class="center">Не загрузилась база. Проверь интернет (или VPN) и обнови страницу.</div>';
    return;
  }
  S.store.onAuth((user) => {
    teardown();
    S.user = user;
    S.ready = true;
    S.view = 'home';
    S.month = C.ym();
    S.histMonth = S.month;
    if (user) subscribe();
    scheduleRender();
  });
})();
