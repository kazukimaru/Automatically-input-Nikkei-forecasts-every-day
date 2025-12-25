// src/run.js
import { chromium } from "playwright";

// ====== 設定 ======
const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const TIMEOUT = 30_000;

// Yahoo Finance（非公式）: Nikkei/Yen Futures
const YAHOO_SYMBOL = "NIY=F";

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
    await page.screenshot({ path: "debug.png", fullPage: true });
    const html = await page.content();
    const fs = await import("node:fs/promises");
    await fs.writeFile("debug.html", html, "utf-8");
  } catch (e) {
    console.log("DEBUG save failed:", e?.message ?? e);
  } finally {
    console.log(`DEBUG saved: ${reason}`);
  }
}

async function typeLikeHuman(locator, text) {
  await locator.click({ timeout: TIMEOUT });
  await locator.press("Control+A").catch(() => {});
  await locator.press("Meta+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.type(text, { delay: 30 });
}

// ====== Yahoo Finance 価格取得 ======
async function fetchNightPrice() {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${YAHOO_SYMBOL}?range=2d&interval=5m&includePrePost=true`;

  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("Yahoo Finance fetch failed");

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo result empty");

  const ts = result.timestamp;
  const closes = result.indicators.quote[0].close;

  // 直近の有効 close を使う（夜間最終値の簡易定義）
  for (let i = ts.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i])) {
      return {
        price: closes[i],
        timestamp: ts[i],
      };
    }
  }
  throw new Error("No valid close price");
}

function splitYenSen(price) {
  const fixed = Number(price).toFixed(2); // "50320.00"
  const [yen, frac] = fixed.split(".");
  return { yen, sen: frac.slice(0, 2) };
}

async function postSlack(text) {
  const url = optEnv("SLACK_WEBHOOK_URL");
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// ====== main ======
async function main() {
  const LOGIN_EMAIL = mustEnv("LOGIN_EMAIL");
  const LOGIN_PASSWORD = mustEnv("LOGIN_PASSWORD");
  const RUN_URL = optEnv("RUN_URL");

  // ① 価格取得
  const { price, timestamp } = await fetchNightPrice();
  const { yen, sen } = splitYenSen(price);
  const jstTime = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(timestamp * 1000));

  console.log(`INFO: price=${price} JST=${jstTime}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // ② ログイン
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    await typeLikeHuman(page.locator("#accountid"), LOGIN_EMAIL);
    await typeLikeHuman(page.locator("#password"), LOGIN_PASSWORD);
    await page.locator("#password").press("Tab").catch(() => {});

    await page.waitForFunction(() => {
      const btn = document.querySelector("#login");
      return btn && !btn.disabled;
    });
    await page.locator("#login").click();
    await page.waitForLoadState("domcontentloaded");

    // ③ TOP
    await page.getByRole("link", { name: "TOP" }).first().click();
    await page.waitForLoadState("domcontentloaded");

    // ④ 入力
    await typeLikeHuman(page.locator("input.yen"), yen);
    await typeLikeHuman(page.locator("input.sen"), sen);

    /**
     * ★★ ここが今回の修正点 ★★
     * 「投票」「訂正」どちらでも拾う
     */
    const submitBtn = page
      .locator('input.submit[value="投票"]')
      .or(page.locator('input.submit[value="訂正"]'))
      .or(page.getByRole("button", { name: /投票|訂正/ }));

    await submitBtn.first().click();

    console.log("OK: submitted");

    await postSlack(
      `✅ Nikkei forecast bot: SUCCESS\n` +
        `• Value: ${yen}円${sen}銭\n` +
        `• Source: Yahoo ${YAHOO_SYMBOL}\n` +
        `• Time(JST): ${jstTime}\n` +
        (RUN_URL ? `• Run: ${RUN_URL}` : "")
    );
  } catch (err) {
    console.error("ERROR:", err?.message ?? err);
    await saveDebug(page, "on-error");

    await postSlack(
      `❌ Nikkei forecast bot: FAILED\n` +
        `• Tried: ${yen ?? "?"}円${sen ?? "?"}銭\n` +
        `• Error: ${err?.message ?? err}\n` +
        (RUN_URL ? `• Run: ${RUN_URL}` : "")
    );
    throw err;
  } finally {
    await browser.close();
  }
}

main();
