// News: Bank of Russia press releases, Banki.ru news feed, and the status card of bill 617-9 (State Duma).
import { fetchText, visibleText, rssItems } from "../lib.mjs";

export const BILL = { id: "617-9", url: "https://sozd.duma.gov.ru/bill/617-9" };

const TOPIC = /вклад|депозит|ключев|накопительн|НДФЛ|налог на процент|страховани[ея] вкладов|АСВ|процентн(?:ые|ых) ставк/i;
// news that may require changing the calculator rules
export const RULE_NEWS = /(НДФЛ|налог)[^.]{0,80}(вклад|процент|пассивн)|(вклад|процент|пассивн)[^.]{0,80}(НДФЛ|налог)|617-9|необлагаем/i;

const FEEDS = [
  { source: "Банк России", url: "https://www.cbr.ru/rss/RssPress", filter: /ключев|вклад|депозит|процентн|сбережен|страховани/i },
  { source: "Банки.ру", url: "https://www.banki.ru/xml/news.rss", filter: TOPIC },
];

export async function news() {
  const all = [], errors = [];
  await Promise.all(FEEDS.map(async (f) => {
    try {
      for (const it of rssItems(await fetchText(f.url)))
        if (f.filter.test(it.title + " " + it.text)) all.push({ date: it.date, source: f.source, title: it.title, link: it.link });
    } catch (e) { errors.push(`${f.source}: ${e.message}`); }
  }));
  if (!all.length && errors.length === FEEDS.length) throw new Error(errors.join("; "));
  return { items: all, errors };
}

const STAGES = [
  [/Опубликование/, "закон опубликован"],
  [/Президент/, "у Президента на подписи"],
  [/Совет(?:ом)? Федерации/, "в Совете Федерации"],
  [/третьем чтении/, "Госдума: третье чтение"],
  [/втором чтении/, "Госдума: второе чтение"],
  [/первом чтении/, "Госдума: первое чтение"],
];

export function parseBill(html) {
  const t = visibleText(html);
  const events = [...t.matchAll(/((?:Рассмотрение|Принятие|Направление|Опубликование|Подписание|Регистрация|Внесение|Отклонение|Одобрение)[^0-9]{5,160}?)\s(\d{2}\.\d{2}\.\d{4})/g)]
    .map((m) => ({ date: m[2].split(".").reverse().join("-"), text: m[1].trim().replace(/\s+б\/н$/, "") }));
  if (!events.length) throw new Error("bill: no events found");
  const all = events.map((e) => e.text).join(" | ");
  const stage = (STAGES.find(([re]) => re.test(all)) || [null, "внесён"])[1];
  const last = events.reduce((a, e) => (e.date > a.date ? e : a));
  return { ...BILL, stage, last, count: events.length, fingerprint: `${events.length}:${last.date}:${stage}` };
}

export async function bill() {
  return parseBill(await fetchText(BILL.url));
}
