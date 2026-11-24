// node tests.mjs — checks the calculation core from index.html
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const code = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const { calc, scaleTax, slices, depositInterest, defaultKeyRate, RULES, compareOffers, forecast, applyKeyMax, parseMoney } =
  new Function(code + "; return { calc, scaleTax, slices, depositInterest, defaultKeyRate, RULES, compareOffers, forecast, applyKeyMax, parseMoney };")();
const { summarizeKey } = await import("./scripts/sources/cbr.mjs");
const { parseBill } = await import("./scripts/sources/news.mjs");
const { parseCards } = await import("./scripts/sources/banks.mjs");

let fails = 0, n = 0;
function eq(name, got, want, eps = 0.005) {
  n++;
  if (Math.abs(got - want) > eps) { fails++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
}
const dep = (interest) => [{ manual: String(interest) }];

// threshold: 1 mln × max key rate; from 2027 — previous year's rate
eq("free 2025", calc({ year: 2025, deposits: dep(0) }).free, 210000);
eq("free 2026", calc({ year: 2026, deposits: dep(0) }).free, 160000);
eq("free 2027 uses 2026 rate", calc({ year: 2027, deposits: dep(0) }).free, 160000);
eq("free manual key", calc({ year: 2028, keyRate: "12", deposits: dep(0) }).free, 120000);

// 2025: 300 000 of interest → (300 000 − 210 000) × 13% = 11 700
eq("2025 basic", calc({ year: 2025, deposits: dep(300000) }).tax, 11700);
// rounding п. 6 ст. 52: 83 335.02 × 13% = 10 833.55 → 10 834
eq("2025 rounding", calc({ year: 2025, deposits: dep(293335.02) }).tax, 10834);
// 2025–2026: salary does not affect interest
eq("2026 salary ignored", calc({ year: 2026, other: 9e6, deposits: dep(560000) }).tax, 52000);
// 2026: investment base above 2.4 mln → 15% on the excess
eq("2026 15% step", calc({ year: 2026, invest: 2.3e6, deposits: dep(360000) }).tax, 100000 * 0.13 + 100000 * 0.15);

// 2027, nalog-nalog.ru example: salary 6 mln, interest 400 000 → base 240 000 at 18% = 43 200; bank 31 200; FNS +12 000
let r = calc({ year: 2027, other: 6e6, deposits: dep(400000) });
eq("2027 nn tax", r.tax, 43200); eq("2027 nn bank", r.bank, 31200); eq("2027 nn fns", r.fnsExtra, 12000);
// bankiros example: 2 mln at 12% for a year, no capitalization → 240 000, base 80 000 → 10 400
r = calc({ year: 2027, deposits: [{ sum: "2 000 000", rate: "12", months: 12, cap: false }] });
eq("bankiros interest", r.interest, 240000); eq("bankiros tax", r.tax, 10400);
// salary 2.2 mln + base 400 000: 200k at 13% + 200k at 15% = 56 000 (old rules 52 000)
r = calc({ year: 2027, other: 2.2e6, deposits: dep(560000) });
eq("stack 2.2m new", r.tax, 56000); eq("stack 2.2m old", r.oldTax, 52000);
// salary 3 mln: all 400 000 at 15% = 60 000
eq("stack 3m", calc({ year: 2027, other: 3e6, deposits: dep(560000) }).tax, 60000);
// under threshold → 0
eq("under free", calc({ year: 2027, other: 3e6, deposits: dep(150000) }).tax, 0);

// interest formulas
eq("cap 12m", depositInterest({ sum: 1e6, rate: 12, months: 12, cap: true }), 1e6 * (1.01 ** 12 - 1));
eq("simple 6m", depositInterest({ sum: 1e6, rate: 12, months: 6, cap: false }), 60000);
eq("manual wins", depositInterest({ sum: 1e6, rate: 12, months: 12, manual: "5 000,50" }), 5000.5);
eq("months clamp", depositInterest({ sum: 1e6, rate: 12, months: 40 }), 120000);

// brute force: stacked tax = scale(S+B) − scale(S), slices add up, monotone, never below 13%
let seed = 7;
const rnd = (k) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 * k;
for (let i = 0; i < 3000; i++) {
  const S = Math.round(rnd(60e6)), I = Math.round(rnd(30e6) * 100) / 100, year = 2027;
  const a = calc({ year, other: S, deposits: dep(I) });
  const b = calc({ year, other: S, deposits: dep(I + 1000) });
  const base = Math.max(0, Math.round((I - 160000) * 100) / 100);
  const want = Math.floor(scaleTax(S + base, RULES.SCALE) - scaleTax(S, RULES.SCALE) + 0.5);
  eq(`brute tax ${S}/${I}`, a.tax, want, 0.001);
  eq(`slices ${S}/${I}`, a.steps.reduce((s, x) => s + x.amount, 0), a.base, 0.01);
  if (b.tax < a.tax) { fails++; console.log(`FAIL monotone ${S}/${I}`); }
  if (a.tax + 1 < Math.floor(a.base * 0.13)) { fails++; console.log(`FAIL min13 ${S}/${I}`); }
  if (a.newTax + 1 < a.oldTax) { fails++; console.log(`FAIL new<old ${S}/${I}`); }
  n += 3;
}

// --- compareOffers: 2 mln for a year, 2027, no other interest → 240 000 − 10 400
const offers = [
  { bank: "A", name: "x", rate: 12, minSum: 10000, termDays: { from: 90, to: 1100 } },
  { bank: "B", name: "y", rate: 14, minSum: 5e6, termDays: null },            // sum too small
  { bank: "C", name: "z", rate: 13, minSum: null, termDays: { from: 30, to: 95 } }, // term too short
  { bank: "D", name: "w", rate: 20, cond: true },                              // special conditions
];
let cmp = compareOffers(offers, { amount: 2e6, months: 12, year: 2027 });
eq("cmp count", cmp.length, 1); eq("cmp interest", cmp[0].interest, 240000); eq("cmp tax", cmp[0].tax, 10400); eq("cmp net", cmp[0].net, 229600);
// with 200 000 of interest already elsewhere the allowance is used: extra tax = tax(440k) − tax(200k)
cmp = compareOffers(offers, { amount: 2e6, months: 12, year: 2027, baseInterest: 200000 });
eq("cmp shared allowance", cmp[0].tax, 31200);
eq("cmp cond on", compareOffers(offers, { amount: 2e6, months: 12, year: 2027, includeCond: true }).length, 2);
eq("cmp sorted", compareOffers(offers, { amount: 2e6, months: 12, year: 2027, includeCond: true })[0].rate, 20);
eq("cmp 3 months", compareOffers(offers, { amount: 2e6, months: 3, year: 2027 })[0].bank === "C" ? 1 : 0, 1);

// --- forecast: 1 mln at 10% from 2027 — under the 160k allowance, no tax
let fc = forecast({ amount: 1e6, rate: 10, years: 2, year0: 2027 });
eq("fc y1", fc[0].capital, 1100000); eq("fc y2", fc[1].capital, 1210000); eq("fc tax0", fc[1].tax, 0);
// 3 mln at 10%: 300k − 160k = 140k × 13% = 18 200
fc = forecast({ amount: 3e6, rate: 10, years: 1, year0: 2027, inflation: 10 });
eq("fc tax", fc[0].tax, 18200); eq("fc cap", fc[0].capital, 3281800); eq("fc noTax", fc[0].noTax, 3300000);
eq("fc real", fc[0].real, 3281800 / 1.1, 0.01);
// unknown future key rate → futureKey used: 2029 uses 2028 rate
fc = forecast({ amount: 3e6, rate: 10, years: 1, year0: 2029, futureKey: 10 });
eq("fc future key", fc[0].tax, (300000 - 100000) * 0.13);

// --- applyKeyMax from live data
applyKeyMax({ 2027: { rate: 12, months: 12 } });
eq("applyKeyMax", calc({ year: 2028, deposits: dep(0) }).free, 120000);
delete RULES.KEY_MAX[2027];

// --- summarizeKey: rate on the 1st of month, max per year
const days = [["2024-12-30", 21], ["2025-01-09", 21], ["2025-06-09", 20], ["2025-12-22", 16], ["2026-02-16", 15.5], ["2026-03-02", 15.5]];
const sk = summarizeKey(days);
eq("key 2025 max", sk.maxByYear[2025].rate, 21); eq("key 2026 max", sk.maxByYear[2026].rate, 16);
eq("key 2026 months", sk.maxByYear[2026].months, 3); eq("key changes", sk.changes.length, 4);

// --- bill card parser on a synthetic page
const bh = `<div>Рассмотрение законопроекта в первом чтении <span>26.10.2026</span></div>
  <div>Рассмотрение законопроекта в третьем чтении Принятие решения 22.11.2026</div>
  <div>Рассмотрение законопроекта Государственной Думой 24.11.2026</div>`;
const pb = parseBill(bh);
eq("bill stage", pb.stage === "Госдума: третье чтение" ? 1 : 0, 1); eq("bill last", pb.last.date === "2026-11-24" ? 1 : 0, 1);
eq("bill SF", parseBill(bh + "<p>Рассмотрение закона Советом Федерации 03.12.2026</p>").stage === "в Совете Федерации" ? 1 : 0, 1);

// --- bank card parser on synthetic text
const cards = parseCards("Вклады ВТБ-Вклад в рублях Вклад на ваших условиях До 13,7% Ставка, годовых От 10 000 ₽ Сумма вклада 2-36 мес. Срок Подробнее " +
  "Вклад «Двойная выгода» для участников ПДС До 18% Ставка, годовых От 30 000 ₽ Подробнее ВТБ-Вклад в юанях До 0,9% Ставка, годовых Подробнее");
eq("cards n", cards.length, 2); eq("cards rate", cards[0].rate, 13.7); eq("cards min", cards[0].minSum, 10000);
eq("cards term", cards[0].termDays.to, Math.round(36 * 30.4)); eq("cards cond", cards[1].cond ? 1 : 0, 1);

// --- parseMoney: how people type sums
for (const [txt, want] of [["1 000 000", 1e6], ["1000000", 1e6], ["1 млн", 1e6], ["1,5 млн", 1.5e6], ["1.5млн", 1.5e6],
  ["1.000.000", 1e6], ["1,000,000", 1e6], ["150к", 150000], ["150 тыс.", 150000], ["150 тыс. руб.", 150000], ["150000 ₽", 150000],
  ["150 000,50", 150000.5], ["293335,02", 293335.02], ["1 234 567.89", 1234567.89], ["1.234.567,89", 1234567.89],
  ["150,000", 150000], ["0,5 млн", 500000], ["2 млрд", 2e9], ["1 000 000", 1e6], ["", 0], [250000, 250000]]) {
  const p = parseMoney(txt);
  eq(`money "${txt}"`, p.value, want, 0.001); if (!p.ok) { fails++; console.log(`FAIL money ok "${txt}"`); }
}
for (const bad of ["abc", "1 млн руб еще", "12-3", "--5"]) if (parseMoney(bad).ok) { fails++; console.log(`FAIL money bad "${bad}"`); }
eq("calc with '1,5 млн'", calc({ year: 2026, deposits: [{ sum: "1,5 млн", rate: "12", months: 12, cap: false }] }).interest, 180000);

console.log(fails ? `${fails} of ${n} failed` : `all ${n} checks passed`);
process.exit(fails ? 1 : 0);
