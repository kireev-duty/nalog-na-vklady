// Shared helpers for the data updater. Node 20+, no dependencies.
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export async function fetchText(url, { timeout = 25000, tries = 2, init = {} } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        ...init,
        headers: { "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9", ...(init.headers || {}) },
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${last?.cause?.code || last?.message}`);
}

const ENT = { nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", quot: '"', amp: "&", thinsp: " ", hellip: "…" };
export function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

// visible text of an HTML page, one line
export function visibleText(html) {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const num = (s) => parseFloat(String(s).replace(/\s/g, "").replace(",", "."));
export const today = () => new Date().toISOString().slice(0, 10);

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export function ruDate(s) {
  const m = String(s).match(/(\d{1,2})\s+([а-я]+)\s+(\d{4})/i);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  return mi < 0 ? null : `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

export function rssItems(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const it = m[0];
    const get = (tag) => {
      const x = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return x ? decode(x[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")).trim() : "";
    };
    const d = new Date(get("pubDate"));
    out.push({ title: get("title"), link: get("link"), date: isNaN(d) ? null : d.toISOString().slice(0, 10), text: get("description") });
  }
  return out;
}
