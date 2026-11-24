// Bank of Russia: key rate (SOAP web service), top-10 banks max deposit rate, rate meeting calendar.
import { fetchText, visibleText, num, ruDate, today } from "../lib.mjs";

const SOAP = "https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx";

export async function keyRate(from = "2022-12-01") {
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><KeyRateXML xmlns="http://web.cbr.ru/"><fromDate>${from}</fromDate><ToDate>${today()}</ToDate></KeyRateXML></soap:Body></soap:Envelope>`;
  const xml = await fetchText(SOAP, {
    init: { method: "POST", body, headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"http://web.cbr.ru/KeyRateXML"' } },
  });
  const days = [...xml.matchAll(/<DT>(\d{4}-\d{2}-\d{2})[^<]*<\/DT>\s*<Rate>([\d.]+)<\/Rate>/g)]
    .map((m) => [m[1], +m[2]])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (days.length < 50) throw new Error("key rate: too few points");
  return summarizeKey(days);
}

// days: [[iso, rate%]] ascending. Keep change points and the max rate on the 1st of each month per year.
export function summarizeKey(days) {
  const changes = [];
  for (const [d, r] of days) if (!changes.length || changes.at(-1)[1] !== r) changes.push([d, r]);
  const rateOn = (iso) => {
    let r = null;
    for (const [d, v] of days) { if (d <= iso) r = v; else break; }
    return r;
  };
  const maxByYear = {};
  const lastDay = days.at(-1)[0];
  const y0 = +days[0][0].slice(0, 4), y1 = +lastDay.slice(0, 4);
  for (let y = y0; y <= y1; y++) {
    let mx = null, months = 0;
    for (let m = 1; m <= 12; m++) {
      const iso = `${y}-${String(m).padStart(2, "0")}-01`;
      if (iso > lastDay || iso < days[0][0]) continue;
      const r = rateOn(iso);
      if (r != null) { mx = Math.max(mx ?? r, r); months++; }
    }
    if (mx != null) maxByYear[y] = { rate: mx, months, final: months === 12 };
  }
  return { current: { date: lastDay, rate: days.at(-1)[1] }, changes, maxByYear };
}

export async function top10() {
  const html = await fetchText("https://www.cbr.ru/statistics/avgprocstav/");
  const i = html.indexOf('<table class="data">');
  const rows = [...html.slice(i, html.indexOf("</table>", i)).matchAll(/<td>\s*([IV]+\.\d{2}\.\d{4})\s*<\/td>\s*<td>\s*([\d,]+)\s*<\/td>/g)]
    .map((m) => ({ decade: m[1], rate: num(m[2]) }));
  if (rows.length < 5) throw new Error("top10: table not found");
  return rows.reverse(); // oldest first
}

export async function nextMeeting() {
  const t = visibleText(await fetchText("https://www.cbr.ru/dkp/cal_mp/"));
  const dates = [...t.matchAll(/(\d{1,2} [а-я]+ \d{4}) года Заседание Совета директоров Банка России по ключевой ставке/g)]
    .map((m) => ruDate(m[1])).filter(Boolean).sort();
  return dates.find((d) => d >= today()) || null;
}
