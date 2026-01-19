import { chromium } from "playwright";

// ====== 設定 ======
const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const TIMEOUT = 30_000;

// Yahoo Finance symbol (Nikkei futures-like)
const YAHOO_SYMBOL = "NIY=F";

// “古すぎ”判定（分）。これ以上古い値なら Slack に警告を出す（投票は継続）
const STALE_MINUTES_WARN = 30;

// ====== util ======
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

/**
 * サイトによっては fill だとイベントが発火せずボタンが有効化されないことがある。
 * type() を使って keydown/keyup を確実に発火させる。
 */
async function typeLikeHuman(locator, text) {
  await locator.click({ timeout: TIMEOUT });
  await locator.press("Control+A").catch(() => {});
  await locator.press("Meta+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.type(String(text), { delay: 30 });
}

function nowUnixSec() {
  return Math.floor(Date.now() / 1000);
}

function minutesAgo(unixSec) {
  return Math.floor((nowUnixSec() - unixSec) / 60);
}

function formatJst(unixSec) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(unixSec * 1000));
}

function splitYenSen(price) {
  const fixed = Number(price).toFixed(2); // "50320.00"
  const [yen, frac = "00"] = fixed.split(".");
  return { yen, sen: frac.slice(0, 2) };
}

async function postSlack(text) {
  const url = optEnv("SLACK_WEBHOOK_URL", "");
  if (!url) return; // 未設定なら通知スキップ
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
 * ✅ Yahoo chart API（meta優先）
 * - meta.regularMarketPrice / meta.regularMarketTime が更新されるのに、
 *   ローソク(close配列)が止まって古くなるケースがある
 * - そこで meta を最優先で採用し、ダメなら close にフォールバックする
 */
async function fetchLatestByChartWithMeta() {
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

  const meta = result.meta;

  // ====== ① meta を最優先 ======
  if (
    meta &&
    Number.isFinite(meta.regularMarketPrice) &&
    Number.isFinite(meta.regularMarketTime)
  ) {
    return {
      price: meta.regularMarketPrice,
      timestamp: meta.regularMarketTime,
      source: "yahoo_chart_meta",
    };
  }

  // ====== ② フォールバック：ローソク足（close配列） ======
  const ts = result.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;

  if (!Array.isArray(ts) || !Array.isArray(closes)) {
    throw new Error("Yahoo chart missing timestamp/close");
  }

  for (let i = ts.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i])) {
      return {
        price: closes[i],
        timestamp: ts[i],
        source: "yahoo_chart_close",
      };
    }
  }

  throw new Error("Yahoo chart: no valid price");
}

async function main() {
  const LOGIN_EMAIL = mustEnv("LOGIN_EMAIL");
  const LOGIN_PASSWORD = mustEnv("LOGIN_PASSWORD");
  const RUN_URL = optEnv("RUN_URL", "");

  // ① 価格取得（Yahoo chart meta優先）
  console.log(`INFO: fetching latest price from Yahoo chart(meta first): ${YAHOO_SYMBOL}`);
  const { price, timestamp, source } = await fetchLatestByChartWithMeta();
  const { yen, sen } = splitYenSen(price);
  const jstTime = formatJst(timestamp);
  const ageMin = minutesAgo(timestamp);

  console.log(
    `INFO: picked price=${price} (yen=${yen}, sen=${sen}) at JST=${jstTime} source=${source} age=${ageMin}min`
  );

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
    const loginBtn = page.locator("#login"); // <input type="submit" id="login">

    await emailInput.waitFor({ state: "visible" });
    await passInput.waitFor({ state: "visible" });

    await typeLikeHuman(emailInput, LOGIN_EMAIL);
    await typeLikeHuman(passInput, LOGIN_PASSWORD);

    // blur（valid判定が走るサイト対策）
    await passInput.press("Tab").catch(() => {});

    // ボタン有効化待ち（disabled解除）
    await page.waitForFunction(() => {
      const el = document.querySelector("#login");
      return !!el && !el.disabled;
    });

    // ログイン
    await loginBtn.click();
    await page.waitForLoadState("domcontentloaded");

    // TOPへ（同名リンクが複数あっても first() で確定）
    await page.getByRole("link", { name: "TOP" }).first().click();
    await page.waitForLoadState("domcontentloaded");

    // 投票ページ入力欄
    const yenInput = page.locator("input.yen");
    const senInput = page.locator("input.sen");
    await yenInput.waitFor({ state: "visible" });
    await senInput.waitFor({ state: "visible" });

    // 値を入力
    await typeLikeHuman(yenInput, yen);
    await typeLikeHuman(senInput, sen);

    // 投票/訂正 両対応
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
