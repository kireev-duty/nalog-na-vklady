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

export const BANKS = [
  { id: "vtb", name: "ВТБ", url: "https://www.vtb.ru/personal/vklady-i-scheta/", parse: (h) => parseCards(visibleText(h)) },
  { id: "gpb", name: "Газпромбанк", url: "https://www.gazprombank.ru/personal/increase/deposits/", parse: (h) => parseGpb(visibleText(h)) },
  { id: "tbank", name: "Т-Банк", url: "https://www.tbank.ru/savings/deposit/", parse: parseTbank },
  { id: "rshb", name: "Россельхозбанк", url: "https://www.rshb.ru/natural/deposits/", parse: (h) => parseCards(visibleText(h), { split: /Подробнее|Открыть|Оформить онлайн|Рассчитать доход/ })
    .map((o) => (/Ультра|Социальн/.test(o.name) ? { ...o, cond: true } : o)) }, // «Ультра» — для премиальных
  { id: "domrf", name: "Банк ДОМ.РФ", url: "https://domrfbank.ru/deposits/", parse: (h) => parseDomrf(visibleText(h)) },
];
// Not collected: Сбербанк, Альфа-Банк, МКБ (rates are loaded by JavaScript), Совкомбанк (blocks bots).

export async function collectBank(bank) {
  const html = await fetchText(bank.url);
  const offers = bank.parse(html);
  if (!offers.length) throw new Error("no offers parsed (page layout changed?)");
  return offers;
}
