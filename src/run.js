// src/run.js
import { chromium } from "playwright";

// ====== 設定 ======
const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const TIMEOUT = 30_000;

// Yahoo Finance（非公式）: Nikkei/Yen Futures (CME) = NIY=F
// ※「日経平均先物」をYahooで無料取得するなら現実的にこれが一番安定 :contentReference[oaicite:2]{index=2}
const YAHOO_SYMBOL = "NIY=F";

// 夜間の最終値（簡易定義）
// JST 前日 16:30 〜 当日 06:00 の間にある最後のcloseを採用
const NIGHT_START_HOUR = 16;
const NIGHT_START_MIN = 30;
const NIGHT_END_HOUR = 6;
const NIGHT_END_MIN = 0;

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
    await page.screenshot({ path: "debug.png", fullPage: true });
    const html = await page.content();
    await Bun.write?.("debug.html", html);
  } catch (_) {
    try {
      const fs = await import("node:fs/promises");
      await page.screenshot({ path: "debug.png", fullPage: true });
      const html = await page.content();
      await fs.writeFile("debug.html", html, "utf-8");
    } catch (e2) {
      console.log("DEBUG save failed:", e2?.message ?? e2);
    }
  } finally {
    console.log(`DEBUG saved: ${reason} -> debug.png / debug.html`);
  }
}

async function typeLikeHuman(locator, text) {
  await locator.click({ timeout: TIMEOUT });
  await locator.press("Control+A").catch(() => {});
  await locator.press("Meta+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.type(text, { delay: 30 });
}

/** JSTの「今日」を基準に Date を作る（UTCベースで扱いやすくするために内部はUTCミリ秒） */
function getNowJstParts() {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

/** JST日時（年月日時分）をUTCのDateに変換（JST=UTC+9固定として扱う） */
function jstToUtcDate({ year, month, day, hour, minute, second = 0 }) {
  // Date.UTC は「UTCの年月日時分秒」
  // ここに JST の値を入れて -9h すると UTC
  const utcMs = Date.UTC(year, month - 1, day, hour - 9, minute, second);
  return new Date(utcMs);
}

/** JSTの当日 06:00 を作る / 前日 16:30 を作る */
function getNightWindowUtc() {
  const now = getNowJstParts();
  const endJst = { ...now, hour: NIGHT_END_HOUR, minute: NIGHT_END_MIN, second: 0 };
  const endUtc = jstToUtcDate(endJst);

  // start = 前日 16:30
  const startBase = new Date(endUtc.getTime() - 24 * 60 * 60 * 1000);
  // startBase をJSTに戻して年月日取るのが面倒なので、JSTパーツから前日を作る
  const endUtcAsJst = new Date(endUtc.getTime() + 9 * 60 * 60 * 1000);
  const y = endUtcAsJst.getUTCFullYear();
  const m = endUtcAsJst.getUTCMonth() + 1;
  const d = endUtcAsJst.getUTCDate();
  // 前日
  const prev = new Date(Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000);
  const prevY = prev.getUTCFullYear();
  const prevM = prev.getUTCMonth() + 1;
  const prevD = prev.getUTCDate();

  const startJst = {
    year: prevY,
    month: prevM,
    day: prevD,
    hour: NIGHT_START_HOUR,
    minute: NIGHT_START_MIN,
    second: 0,
  };
  const startUtc = jstToUtcDate(startJst);

  return { startUtc, endUtc };
}

/**
 * Yahoo Finance chart APIから close を取る
 * ref: v8/finance/chart :contentReference[oaicite:3]{index=3}
 */
async function fetchYahooChart(symbol, range = "2d", interval = "5m") {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=true`;

  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Yahoo chart API failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo chart API returned no result");

  const ts = result.timestamp; // seconds[]
  const closes = result?.indicators?.quote?.[0]?.close; // number[] (nullあり)
  if (!Array.isArray(ts) || !Array.isArray(closes)) {
    throw new Error("Yahoo chart API missing timestamp/close");
  }

  return { ts, closes };
}

/** 夜間最終値（簡易定義：window内の最後の有効close）を取得 */
async function getNightFinalPriceJst() {
  const { startUtc, endUtc } = getNightWindowUtc();

  // 2d/5m なら夜間〜朝のローソクはほぼ拾える
  const { ts, closes } = await fetchYahooChart(YAHOO_SYMBOL, "2d", "5m");

  const startSec = Math.floor(startUtc.getTime() / 1000);
  const endSec = Math.floor(endUtc.getTime() / 1000);

  let picked = null; // {sec, price}
  for (let i = 0; i < ts.length; i++) {
    const sec = ts[i];
    const price = closes[i];
    if (sec == null) continue;
    if (sec < startSec || sec > endSec) continue;
    if (price == null || !Number.isFinite(price)) continue;
    picked = { sec, price };
  }

  // フォールバック：window内が取れないなら「直近の有効close」
  if (!picked) {
    for (let i = ts.length - 1; i >= 0; i--) {
      const sec = ts[i];
      const price = closes[i];
      if (sec == null) continue;
      if (price == null || !Number.isFinite(price)) continue;
      picked = { sec, price };
      break;
    }
  }

  if (!picked) throw new Error("Could not determine futures price from Yahoo chart data");

  return picked; // priceは指数値そのもの（例: 50320）
}

function splitYenSenFromPrice(price) {
  // 投票UIが「円」「銭」なので、小数対応（あれば）して分割
  // 先物が整数しか返らない場合でもOK
  const fixed = Number(price).toFixed(2); // "50320.00"
  const [yen, frac] = fixed.split(".");
  const sen = (frac ?? "00").slice(0, 2);
  return { yen, sen };
}

async function postSlack(text) {
  const url = optEnv("SLACK_WEBHOOK_URL", "");
  if (!url) return; // webhook未設定なら何もしない
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

function fmtJstFromUnix(sec) {
  const d = new Date(sec * 1000);
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return fmt.format(d);
}

async function main() {
  const LOGIN_EMAIL = mustEnv("LOGIN_EMAIL");
  const LOGIN_PASSWORD = mustEnv("LOGIN_PASSWORD");

  const RUN_URL = optEnv("RUN_URL", "");
  const TZ = optEnv("TZ", "Asia/Tokyo"); // 参考用ログ

  // ① 先物価格取得（夜間最終値）
  console.log(`INFO: timezone env = ${TZ}`);
  console.log(`INFO: fetching futures from Yahoo: ${YAHOO_SYMBOL} ...`);
  const picked = await getNightFinalPriceJst();
  const pickedJst = fmtJstFromUnix(picked.sec);
  const { yen, sen } = splitYenSenFromPrice(picked.price);

  console.log(`INFO: picked night-final (approx) = ${picked.price} at JST ${pickedJst}`);
  console.log(`INFO: input split => yen=${yen}, sen=${sen}`);

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

    const topLink = page.getByRole("link", { name: "TOP" }).first();
    await topLink.click();
    await page.waitForLoadState("domcontentloaded");

    const yenInput = page.locator('input.yen');
    const senInput = page.locator('input.sen');
    const voteBtn = page
      .getByRole("button", { name: "投票" })
      .or(page.locator('input.submit[value="投票"]'));

    await yenInput.waitFor({ state: "visible" });
    await senInput.waitFor({ state: "visible" });

    await typeLikeHuman(yenInput, yen);
    await typeLikeHuman(senInput, sen);

    await voteBtn.click();

    console.log("OK: voted successfully");

    // ② Slackに「入力した値」も通知
    const msg =
      `✅ Nikkei forecast bot: SUCCESS\n` +
      `• Source: Yahoo Finance ${YAHOO_SYMBOL}\n` +
      `• Picked (night-final approx): ${picked.price} (${yen}円${sen}銭)\n` +
      `• Timestamp(JST): ${pickedJst}\n` +
      (RUN_URL ? `• Run: ${RUN_URL}` : "");

    await postSlack(msg);
  } catch (err) {
    console.log("ERROR:", err?.message ?? err);

    const msg =
      `❌ Nikkei forecast bot: FAILED\n` +
      `• While trying to input: ${picked?.price ?? "?"} (${yen ?? "?"}円${sen ?? "?"}銭)\n` +
      `• Error: ${err?.message ?? err}\n` +
      (RUN_URL ? `• Run: ${RUN_URL}` : "") +
      `\n(Artifactsに debug.png / debug.html)`;

    await postSlack(msg);

    await saveDebug(page, "on-error");
    throw err;
  } finally {
    await browser.close();
  }
}

main();
