// Daily data update: node scripts/update.mjs [--dry] [--test-issue]
// Writes data/live.json (what the page reads) and data/state.json (what changed since last run).
// In GitHub Actions (GITHUB_TOKEN + GITHUB_REPOSITORY set) it opens issues when the page itself needs work.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { keyRate, top10, nextMeeting } from "./sources/cbr.mjs";
import { BANKS, collectBank } from "./sources/banks.mjs";
import { news, bill, RULE_NEWS } from "./sources/news.mjs";

const DRY = process.argv.includes("--dry");
const TEST_ISSUE = process.argv.includes("--test-issue");
const DATA = new URL("../data/", import.meta.url);
const now = new Date().toISOString();
const read = (f, d) => { try { return JSON.parse(readFileSync(new URL(f, DATA), "utf8")); } catch { return d; } };

const prev = read("live.json", {});
const state = read("state.json", { seen: [], bankFails: {}, bill: null, key: null });
const log = [], issues = [];
const step = async (name, fn) => {
  try { const v = await fn(); log.push(`ok   ${name}`); return v; }
  catch (e) { log.push(`FAIL ${name}: ${e.message}`); return undefined; }
};

const [key, top, meeting, nw, bl, ...banks] = await Promise.all([
  step("cbr key rate", keyRate),
  step("cbr top-10", top10),
  step("cbr calendar", nextMeeting),
  step("news", news),
  step("bill 617-9", bill),
  ...BANKS.map((b) => step(`bank ${b.id}`, () => collectBank(b))),
]);

// --- banks: keep last good data when a bank fails
const prevBanks = Object.fromEntries((prev.banks || []).map((b) => [b.id, b]));
const bankOut = BANKS.map((b, i) => {
  if (banks[i]) { state.bankFails[b.id] = 0; return { id: b.id, name: b.name, url: b.url, updated: now, ok: true, offers: banks[i] }; }
  state.bankFails[b.id] = (state.bankFails[b.id] || 0) + 1;
  if (state.bankFails[b.id] === 3)
    issues.push({ title: `Сбор ставок: ${b.name} не обновляется 3 дня`, body: `Адаптер \`${b.id}\` падает третий запуск подряд. Страница: ${b.url}\nСкорее всего, банк поменял вёрстку — поправить \`scripts/sources/banks.mjs\`.` });
  const old = prevBanks[b.id];
  return old ? { ...old, ok: false } : { id: b.id, name: b.name, url: b.url, updated: null, ok: false, offers: [] };
});

// --- news: merge with previous, newest first, 40 max
const seen = new Set(state.seen);
let items = prev.news?.items || [];
if (nw) {
  const fresh = nw.items.filter((x) => x.link && !seen.has(x.link));
  for (const x of fresh) seen.add(x.link);
  items = [...fresh, ...items];
  const ruleNews = fresh.filter((x) => RULE_NEWS.test(x.title));
  if (ruleNews.length && state.seen.length) // not on the very first run
    issues.push({ title: "Проверить: новости о налоге на вклады", rolling: true,
      body: ruleNews.map((x) => `- ${x.date} ${x.source}: [${x.title}](${x.link})`).join("\n") + "\n\nЕсли меняются ставки, порог или порядок — поправить `RULES` в index.html и тесты." });
}
items = [...new Map(items.map((x) => [x.link, x])).values()].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 40);
state.seen = [...seen].slice(-500);

// --- bill 617-9
if (bl) {
  if (state.bill && state.bill !== bl.fingerprint)
    issues.push({ title: `Законопроект 617-9: ${bl.stage}`,
      body: `Новое событие ${bl.last.date}: ${bl.last.text}\n${bl.url}\n\nПроверить: подписан ли закон, не поменялись ли порог, шкала и порядок удержания. Поправить \`RULES\` и сноски в index.html, README.` });
  state.bill = bl.fingerprint;
  bl.checked = now;
  items = [{ date: bl.last.date, source: "Госдума", title: `Законопроект 617-9 (налог на вклады): ${bl.stage}`, link: bl.url, pinned: true },
    ...items.filter((x) => !x.pinned)];
}

// --- key rate: change is not an issue (the page updates itself), but goes to the news list
if (key) {
  if (state.key != null && state.key !== key.current.rate)
    items.unshift({ date: key.current.date, source: "Банк России", title: `Ключевая ставка: ${state.key}% → ${key.current.rate}%`, link: "https://www.cbr.ru/hd_base/KeyRate/" });
  state.key = key.current.rate;
}

if (TEST_ISSUE) issues.push({ title: "Тест автозадач (можно закрыть)", body: "Проверка, что робот умеет открывать задачи." });

const live = {
  updated: now,
  key: key ? { ...key, nextMeeting: meeting ?? prev.key?.nextMeeting ?? null } : prev.key || null,
  top10: top ?? prev.top10 ?? null,
  banks: bankOut,
  bill: bl ?? prev.bill ?? null,
  news: { items },
  log,
};

console.log(log.join("\n"));
console.log(`banks ok: ${bankOut.filter((b) => b.ok).length}/${bankOut.length}, offers: ${bankOut.reduce((s, b) => s + b.offers.length, 0)}, news: ${items.length}, issues: ${issues.length}`);

if (!DRY) {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  writeFileSync(new URL("live.json", DATA), JSON.stringify(live, null, 1) + "\n");
  writeFileSync(new URL("state.json", DATA), JSON.stringify(state, null, 1) + "\n");
  await openIssues(issues);
} else {
  for (const i of issues) console.log(`[dry] issue: ${i.title}`);
  if (process.argv.includes("--print")) console.log(JSON.stringify(live, null, 1));
}

async function openIssues(list) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
  if (!list.length) return;
  if (!token || !repo) { for (const i of list) console.log(`issue (not sent, no token): ${i.title}`); return; }
  const api = (path, init = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
  }).then((r) => r.json());
  const open = await api("/issues?state=open&per_page=100");
  for (const i of list) {
    const same = Array.isArray(open) && open.find((o) => o.title === i.title && !o.pull_request);
    if (same && i.rolling) await api(`/issues/${same.number}/comments`, { method: "POST", body: JSON.stringify({ body: i.body }) });
    else if (!same) await api("/issues", { method: "POST", body: JSON.stringify({ title: i.title, body: i.body }) });
    console.log(`issue: ${i.title}${same ? (i.rolling ? " (comment)" : " (already open)") : ""}`);
  }
}
