import { chromium } from "playwright";

const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const TIMEOUT = 30_000;

// Yahoo Finance symbol (Nikkei futures-like)
const YAHOO_SYMBOL = "NIY=F";

// “古すぎ”判定（分）。これ以上古い値なら警告（必要ならエラーに変えられる）
const STALE_MINUTES_WARN = 30;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing secrets: ${name}`);
  return v;
}
function optEnv(name, def = "") {
  return process.env[name] ?? def;
}

async function saveDebug(page, reason = "on-error") {
  try {
    const fs = await import("node:fs/promises");
    await page.screenshot({ path: "debug.png", fullPage: true });
    const html = await page.content();
    await fs.writeFile("debug.html", html, "utf-8");
  } catch (e) {
    console.log("DEBUG save failed:", e?.message ?? e);
  } finally {
    console.log(`DEBUG saved: ${reason} -> debug.png / debug.html`);
  }
}

async function typeLikeHuman(locator, text) {
  await locator.click({ timeout: TIMEOUT });
  await locator.press("Control+A").catch(() => {});
  await locator.press("Meta+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.type(String(text), { delay: 30 });
}

function formatJst(unixSec) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(unixSec * 1000));
}

function nowUnixSec() {
  return Math.floor(Date.now() / 1000);
}

function minutesAgo(unixSec) {
  return Math.floor((nowUnixSec() - unixSec) / 60);
}

function splitYenSen(price) {
  const fixed = Number(price).toFixed(2); // "50320.00"
  const [yen, frac = "00"] = fixed.split(".");
  return { yen, sen: frac.slice(0, 2) };
}

async function postSlack(text) {
  const url = optEnv("SLACK_WEBHOOK_URL", "");
  if (!url) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.log(`WARN: Slack notify failed: ${res.status} ${res.statusText} ${t.slice(0, 200)}`);
  }
}

/**
 * ✅ 推奨：Yahoo Quote API（現在値向け）
 * v7/finance/quote は “今の値” 系（regularMarketPrice / regularMarketTime）を返すことが多い。
 * ここを最優先にすると「昨日の13:55みたいな古い足」問題が減る。
 */
async function fetchLatestByQuote() {
  const url =
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(YAHOO_SYMBOL)}`;

  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Yahoo quote fetch failed: ${res.status} ${res.statusText} ${t.slice(0, 200)}`);
  }

  const json = await res.json();
  const q = json?.quoteResponse?.result?.[0];
  if (!q) throw new Error("Yahoo quote result empty");

  // 先物/指数でフィールドの出方が揺れるので、候補を広めに見る
  const priceCandidates = [
    q.regularMarketPrice,
    q.postMarketPrice,
    q.preMarketPrice,
    q.bid,
    q.ask,
  ];
  const timeCandidates = [
    q.regularMarketTime,
    q.postMarketTime,
    q.preMarketTime,
  ];

  const price = priceCandidates.find((v) => Number.isFinite(v));
  const timestamp = timeCandidates.find((v) => Number.isFinite(v));

  if (!Number.isFinite(price) || !Number.isFinite(timestamp)) {
    throw new Error("Yahoo quote missing price/time");
  }

  return { price, timestamp, source: "yahoo_quote_v7" };
}

/**
 * フォールバック：Yahoo chart API（ローソク足）
 * - interval=1m にしてできるだけ最新を狙う
 * - close配列の最後の有効値を逆順で探す
 */
async function fetchLatestByChart() {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_SYMBOL)}` +
    `?range=1d&interval=1m&includePrePost=true`;

  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Yahoo chart fetch failed: ${res.status} ${res.statusText} ${t.slice(0, 200)}`);
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo chart result empty");

  const ts = result.timestamp; // unix sec[]
  const closes = result?.indicators?.quote?.[0]?.close; // number[] (nullあり)

  if (!Array.isArray(ts) || !Array.isArray(closes)) {
    throw new Error("Yahoo chart missing timestamp/close");
  }

  for (let i = ts.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i])) {
      return { price: closes[i], timestamp: ts[i], source: "yahoo_chart_v8" };
    }
  }

  throw new Error("Yahoo chart: No valid close price");
}

/**
 * ✅ 最終的な価格取得
 * 1) quote（現在値）を優先
 * 2) ダメなら chart（ローソク足）
 */
async function fetchLatestPriceYahoo() {
  try {
    return await fetchLatestByQuote();
  } catch (e) {
    console.log("WARN: quote fetch failed, fallback to chart:", e?.message ?? e);
    return await fetchLatestByChart();
  }
}

async function main() {
  const LOGIN_EMAIL = mustEnv("LOGIN_EMAIL");
  const LOGIN_PASSWORD = mustEnv("LOGIN_PASSWORD");
  const RUN_URL = optEnv("RUN_URL", "");

  // ① 価格取得（最新優先）
  console.log(`INFO: fetching latest price from Yahoo: ${YAHOO_SYMBOL}`);
  const { price, timestamp, source } = await fetchLatestPriceYahoo();
  const { yen, sen } = splitYenSen(price);
  const jstTime = formatJst(timestamp);
  const ageMin = minutesAgo(timestamp);

  console.log(`INFO: picked price=${price} (yen=${yen}, sen=${sen}) at JST=${jstTime} source=${source} age=${ageMin}min`);

  // 古い値なら Slack で警告（必要ならここで throw にして“失敗扱い”にできる）
  const staleWarn = ageMin >= STALE_MINUTES_WARN;

  // ② ブラウザ操作開始
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    console.log("INFO: opening login page...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    const emailInput = page.locator("#accountid");
    const passInput = page.locator("#password");
    const loginBtn = page.locator("#login");

    await emailInput.waitFor({ state: "visible" });
    await passInput.waitFor({ state: "visible" });

    await typeLikeHuman(emailInput, LOGIN_EMAIL);
    await typeLikeHuman(passInput, LOGIN_PASSWORD);

    await passInput.press("Tab").catch(() => {});

    await page.waitForFunction(() => {
      const el = document.querySelector("#login");
      return !!el && !el.disabled;
    });

    await loginBtn.click();
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("link", { name: "TOP" }).first().click();
    await page.waitForLoadState("domcontentloaded");

    const yenInput = page.locator("input.yen");
    const senInput = page.locator("input.sen");
    await yenInput.waitFor({ state: "visible" });
    await senInput.waitFor({ state: "visible" });

    await typeLikeHuman(yenInput, yen);
    await typeLikeHuman(senInput, sen);

    // 投票 / 訂正 両対応
    const submitBtn = page
      .locator('input.submit[value="投票"]')
      .or(page.locator('input.submit[value="訂正"]'))
      .or(page.getByRole("button", { name: /投票|訂正/ }));

    await submitBtn.first().click();

    console.log("OK: submitted successfully");

    await postSlack(
      `✅ Nikkei forecast bot: SUCCESS\n` +
        `• Value: ${yen}円${sen}銭\n` +
        `• Source: Yahoo ${YAHOO_SYMBOL} (${source})\n` +
        `• Time(JST): ${jstTime} (${ageMin} min ago)\n` +
        (staleWarn ? `⚠️ WARNING: price is stale (>= ${STALE_MINUTES_WARN} min)\n` : "") +
        (RUN_URL ? `• Run: ${RUN_URL}` : "")
    );
  } catch (err) {
    console.log("ERROR:", err?.message ?? err);
    await saveDebug(page, "on-error");

    await postSlack(
      `❌ Nikkei forecast bot: FAILED\n` +
        `• Error: ${err?.message ?? err}\n` +
        (RUN_URL ? `• Run: ${RUN_URL}` : "") +
        `\n(Artifactsに debug.png / debug.html)`
    );

    throw err;
  } finally {
    await browser.close();
  }
}

main();
