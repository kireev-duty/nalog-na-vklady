// Bank deposit offers from banks' own public pages. One fetch per bank per day.
// Pages change: a bank that fails keeps its last data with the old date (see update.mjs).
import { fetchText, visibleText, num } from "../lib.mjs";

const NAME_RE =
  /(Накопительный\s+(?:ВТБ-)?[Сс]ч[её]т(?:\s+«[^»]{2,40}»|\s+в\s+[а-яё]+)?|(?:ВТБ-)?Вклад(?![а-яё])(?:\s+«[^»]{2,40}»|\s+в\s+[а-яё]+)?|Семейная копилка|Социальный (?:банковский )?вклад)/;
const FX_RE = /Ұ|¥|\$|€|юан|доллар|евро|валют/i;
// special conditions that make the headline rate not available to everyone
const COND_RE =
  /ПДС|долгосрочных сбережений|страхован|паи|ПИФ|инвест|14-25|14–25|социальн|пенсион|Почт[аеы]|новых (?:вкладчиков|клиентов)|для новых|акци|зарплатн|премиальн|привилеги|подписк/i;

function parseTerm(s) {
  const m = s.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s*(мес|дн|год|лет)/);
  if (!m) return null;
  const k = m[3] === "мес" ? 30.4 : m[3] === "дн" ? 1 : 365;
  return { from: Math.round(+m[1] * k), to: Math.round(+(m[2] || m[1]) * k) };
}

// generic "card" parser over visible text: segments between card buttons
export function parseCards(text, { split = /Подробнее|Стать клиентом|Открыть вклад|Оформить/ } = {}) {
  const out = [];
  for (const seg of text.split(split)) {
    const tail = seg.slice(-420);
    const nm = tail.match(NAME_RE);
    if (!nm) continue;
    const body = tail.slice(nm.index);
    const rate = body.match(/(?:До\s+)?(\d{1,2}(?:[,.]\d{1,2})?)\s?%\s*(?:Ставка|ставка)/) ||
      body.match(/(?:[Дд]о\s+)?(\d{1,2}(?:[,.]\d{1,2})?)\s?%\s*(?:годовых|Доходность)/);
    if (!rate) continue;
    if (FX_RE.test(body.slice(0, 160))) continue;
    const minSum = body.match(/[Оо]т\s+([\d ,]{1,12})\s?(млн\.?\s?)?₽/);
    const term = body.match(/(\d+(?:\s*[-–]\s*\d+)?\s*(?:мес|дн|год|лет)[а-я.]*)\s*(?:Срок|срок)/);
    const sum = minSum && num(minSum[1]) * (minSum[2] ? 1e6 : 1);
    out.push(offer(nm[1], num(rate[1]), body, sum, term && parseTerm(term[1])));
  }
  return dedupe(out);
}

function offer(name, rate, desc, minSum, term) {
  const n = name.replace(/\s+/g, " ").trim();
  return {
    name: n,
    kind: /[Сс]ч[её]т|копилка/.test(n) ? "savings" : "deposit",
    rate,
    minSum: minSum || null,
    termDays: term,
    cond: COND_RE.test(desc.slice(0, 220)),
  };
}

function dedupe(list) {
  const m = new Map();
  for (const o of list) if (o.rate > 0.5 && o.rate < 40 && (!m.has(o.name) || m.get(o.name).rate < o.rate)) m.set(o.name, o);
  return [...m.values()];
}

// Gazprombank: comparison table "Name rate% termFrom termTo minSum ..."
function parseGpb(text) {
  const rows = [...text.matchAll(/([А-ЯЁ][А-Яа-яё ]{2,30}?) (\d{1,2}(?:,\d{1,2})?)% (\d+ (?:мес\.|дн\.|год|года|лет)) (\d+ (?:мес\.|дн\.|год|года|лет)) ([\d,]+ (?:тыс\. |млн )?[₽¥])/g)];
  const out = rows
    .filter((m) => m[5].endsWith("₽"))
    .map((m) => {
      const t1 = parseTerm(m[3]), t2 = parseTerm(m[4]);
      const sum = num(m[5]) * (/тыс/.test(m[5]) ? 1e3 : /млн/.test(m[5]) ? 1e6 : 1);
      const name = m[1].trim().replace(/^(?:Пополнение|Снятие|Капитализация|Выплата процентов)\s+/, "");
      return offer(`Вклад «${name}»`, num(m[2]), m[1], sum, t1 && t2 ? { from: t1.from, to: t2.to } : null);
    });
  for (const o of out) if (/Социальн/.test(o.name)) o.cond = true;
  const sav = text.match(/Накопительный счет До (\d{1,2}(?:,\d{1,2})?)% годовых/);
  if (sav) out.push(offer("Накопительный счёт", num(sav[1]), "", null, null));
  return dedupe(out);
}

// T-Bank: one deposit, headline rate in meta description
function parseTbank(html) {
  const m = html.match(/<meta name="description" content="[^"]*?до\s*(\d{1,2}(?:,\d{1,2})?)%/);
  return m ? [offer("Вклад", num(m[1]), "", 50000, null)] : [];
}

// Dom.RF: landing with one headline deposit
function parseDomrf(text) {
  const m = text.match(/Ставка до (\d{1,2}(?:,\d{1,2})?)% Сумма от ([\d ]+) ₽ Срок от (\d+) мес\. до (\d+) (?:лет|года)/);
  if (!m) return [];
  return [offer("Вклад «Мой Дом»", num(m[1]), "для новых клиентов с надбавками", num(m[2]), { from: Math.round(+m[3] * 30.4), to: +m[4] * 365 })]
    .map((o) => ({ ...o, cond: false }));
}

// Ak Bars: cards "Вклад «X» <description> До N% максимальная ставка <term> срок … От S ₽ минимальная сумма"
export function parseAkbars(text) {
  const out = [];
  const re = /((?:Вклад|Накопительный сч[её]т) «[^»]{2,40}»)\s+((?:(?!Вклад «|Накопительный сч)[^]){0,200}?)\s*До (\d{1,2}(?:,\d{1,2})?)%\s*(?:—\s*)?максимальная ставка\s*(.{0,40}?)\s*(?:срок|Срок)?(?:\s+(?:вклада|счёта|счета))?\s*(?:Срок\s+(.{0,20}?)\s*)?От ([\d ]+) ₽/g;
  for (const m of text.matchAll(re)) {
    const desc = m[2], termTxt = (m[4] || m[5] || "").trim();
    let term = parseTerm(termTxt);
    if (term && /^До/i.test(termTxt)) term = { from: 1, to: term.to };
    const o = offer(m[1], num(m[3]), desc, num(m[6]) || null, term);
    // salary/pension clients, new clients, pension savings programme, IIS — not for everyone
    if (/зарплат|пенси|новых клиентов|ПДС|ИИС|участник/i.test(desc)) o.cond = true;
    // headline with capitalization is an effective yield, the page compares without it
    if (/с капитализацией/i.test(desc)) o.cond = true;
    out.push(o);
  }
  return dedupe(out);
}

// Uralsib (/vklady-scheta/vklady): rates stand before or after the product name, no cards
export function parseUralsib(text) {
  const out = [];
  const first = (re) => text.match(re);
  // "14% годовых Выгодный вклад «Доход» на 12 месяцев … Сумма вклада — от 1 млн ₽" — the first one is for everyone
  const d = first(/(\d{1,2}(?:,\d{1,2})?)% годовых Выгодный вклад «Доход» на (\d+) месяц[а-я]* .{0,80}?Сумма вклада — от ([\d ,]+) (млн )?₽/);
  if (d) out.push(offer("Вклад «Доход»", num(d[1]), "", num(d[3]) * (d[4] ? 1e6 : 1), parseTerm(`${d[2]} мес`)));
  const v = first(/Вклад «Выгодный» (\d{1,2}(?:,\d{1,2})?) ?% процентная ставка/);
  if (v) out.push(offer("Вклад «Выгодный»", num(v[1]), "", null, null));
  // the rate grows month by month, the headline is the last month only
  const dyn = first(/Вклад «Динамичный» .{0,60}?(\d+) месяц[а-я]* .{0,30}?от \d{1,2}(?:,\d{1,2})?% до (\d{1,2}(?:,\d{1,2})?)% годовых Сумма вклада — от ([\d ]+) ₽/);
  if (dyn) out.push({ ...offer("Вклад «Динамичный»", num(dyn[2]), "", num(dyn[3]), parseTerm(`${dyn[1]} мес`)), cond: true });
  const plus = first(/(\d{1,2}(?:[,.]\d{1,2})?)% для новых клиентов на срок (\d+) месяц[а-я]* по вкладу «Доход Плюс»/);
  if (plus) out.push({ ...offer("Вклад «Доход Плюс»", num(plus[1]), "", null, parseTerm(`${plus[2]} мес`)), cond: true });
  return dedupe(out);
}

export const BANKS = [
  { id: "vtb", name: "ВТБ", url: "https://www.vtb.ru/personal/vklady-i-scheta/", parse: (h) => parseCards(visibleText(h)) },
  { id: "gpb", name: "Газпромбанк", url: "https://www.gazprombank.ru/personal/increase/deposits/", parse: (h) => parseGpb(visibleText(h)) },
  { id: "tbank", name: "Т-Банк", url: "https://www.tbank.ru/savings/deposit/", parse: parseTbank },
  { id: "rshb", name: "Россельхозбанк", url: "https://www.rshb.ru/natural/deposits/", parse: (h) => parseCards(visibleText(h), { split: /Подробнее|Открыть|Оформить онлайн|Рассчитать доход/ })
    .map((o) => (/Ультра|Социальн/.test(o.name) ? { ...o, cond: true } : o)) }, // «Ультра» — для премиальных
  { id: "domrf", name: "Банк ДОМ.РФ", url: "https://domrfbank.ru/deposits/", parse: (h) => parseDomrf(visibleText(h)) },
  // savings headline is a welcome bonus for card purchases from 20k ₽ (base rate is much lower)
  { id: "bspb", name: "Банк Санкт-Петербург", url: "https://www.bspb.ru/retail/deposits", parse: (h) => parseCards(visibleText(h))
    .map((o) => (o.kind === "savings" ? { ...o, cond: true } : o)) },
  { id: "akbars", name: "Ак Барс", url: "https://www.akbars.ru/individuals/deposits/", parse: (h) => parseAkbars(visibleText(h)) },
  { id: "uralsib", name: "Уралсиб", url: "https://www.uralsib.ru/vklady-scheta/vklady", parse: (h) => parseUralsib(visibleText(h)) },
];
// Not collected: Сбербанк, Альфа-Банк, МКБ, ОТП, Абсолют (bot protection page), Совкомбанк (401).

export async function collectBank(bank) {
  const html = await fetchText(bank.url);
  const offers = bank.parse(html);
  if (!offers.length) throw new Error("no offers parsed (page layout changed?)");
  return offers;
}
