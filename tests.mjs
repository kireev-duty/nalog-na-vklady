// node tests.mjs — checks the calculation core from index.html
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const code = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const { calc, scaleTax, slices, depositInterest, defaultKeyRate, RULES } =
  new Function(code + "; return { calc, scaleTax, slices, depositInterest, defaultKeyRate, RULES };")();

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

console.log(fails ? `${fails} of ${n} failed` : `all ${n} checks passed`);
process.exit(fails ? 1 : 0);
