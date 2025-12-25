import fs from "fs";
import { chromium } from "playwright";

/**
 * Yahoo Finance chart API から最新終値を取る
 * 例: symbol=NIY=F (日経平均先物), ^N225 など
 */
async function fetchYahooLatestClose(symbol = "NIY=F") {
  console.log(`INFO: fetching Yahoo chart... symbol=${symbol}`);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=7d`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const result = data?.chart?.result?.[0];
  if (!result) {
    throw new Error("Yahoo response has no chart.result[0]");
  }

  const closes = result?.indicators?.quote?.[0]?.close;
  const timestamps = result?.timestamp;

  if (!Array.isArray(closes) || closes.length === 0) {
    throw new Error("Yahoo response has no close array");
  }

  // close配列の末尾はnullが混ざることがあるので、最後の有効値を取る
  let idx = closes.length - 1;
  while (idx >= 0 && (closes[idx] == null || !Number.isFinite(closes[idx]))) {
    idx--;
  }
  if (idx < 0) throw new Error("No valid close value found");

  const latestClose = closes[idx];
  const ts = Array.isArray(timestamps) ? timestamps[idx] : null;
  const timeISO = ts ? new Date(ts * 1000).toISOString() : "unknown";

  console.log(`OK: ${symbol} latestClose=${latestClose} time=${timeISO}`);

  return { latestClose, timeISO };
}

function toYenSen(value) {
  // 例: 50455.23 -> yen=50455, sen=23
  // サイト側が「円」「銭」で受ける前提
  const yen = Math.floor(value);
  const sen = Math.round((value - yen) * 100);
  const sen2 = String((sen + 100) % 100).padStart(2, "0");
  return { yen: String(yen), sen: sen2 };
}

async function saveDebug(page, reason = "on-error") {
  try {
    await page.screenshot({ path: "debug.png", fullPage: true });
  } catch (e) {
    console.log("WARN: screenshot failed:", e?.message || e);
  }

  try {
    const html = await page.content();
    fs.writeFileSync("debug.html", html, "utf-8");
  } catch (e) {
    console.log("WARN: html dump failed:", e?.message || e);
  }

  console.log(`DEBUG saved: ${reason} -> debug.png / debug.html`);
}

async function main() {
  const LOGIN_EMAIL = process.env.LOGIN_EMAIL;
  const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;

  if (!LOGIN_EMAIL || !LOGIN_PASSWORD) {
    throw new Error("Missing secrets: LOGIN_EMAIL / LOGIN_PASSWORD");
  }

  // 1) 先物取得
  console.log("📈 先物取得中...");
  const { latestClose } = await fetchYahooLatestClose("NIY=F");
  const { yen, sen } = toYenSen(latestClose);
  console.log(`取得値: ${latestClose} → ${yen}円 ${sen}銭`);

  // 2) 投票（Playwright）
  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage();

  try {
    // ログインページ
    await page.goto("https://shi2026.market-price-forecast.com/login.php", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // 入力（fillだけで反応しないサイトがあるので type を使う）
    await page.locator("#accountid").click();
    await page.locator("#accountid").fill("");
    await page.locator("#accountid").type(LOGIN_EMAIL, { delay: 20 });

    await page.locator("#password").click();
    await page.locator("#password").fill("");
    await page.locator("#password").type(LOGIN_PASSWORD, { delay: 20 });

    // ボタンが有効化されるまで待つ（ここが超重要）
    const loginBtn = page.locator("#login");
    await loginBtn.waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(200); // ちょい待ち（JSの有効化処理の猶予）
    await page.waitForFunction(() => {
      const el = document.querySelector("#login");
      return el && !el.disabled;
    }, { timeout: 30000 });

    // クリックして遷移待ち
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }),
      loginBtn.click(),
    ]);

    // ホーム → TOP
    await page.locator('a[href="/forecast.php"]').click();
    await page.waitForLoadState("domcontentloaded");

    // 投票ページ：円/銭/投票ボタン
    await page.locator('input.yen').waitFor({ state: "visible", timeout: 30000 });
    await page.locator('input.yen').fill("");
    await page.locator('input.yen').type(yen, { delay: 10 });

    await page.locator('input.sen').fill("");
    await page.locator('input.sen').type(sen, { delay: 10 });

    // 投票クリック
    await page.locator('input.submit').click();

    // 何かしら成功判定（ページが更新される/文言が変わる等があればここを強化）
    await page.waitForTimeout(1500);

    console.log("✅ 投票処理: 完了（画面確認できるなら success）");

  } catch (e) {
    console.log("❌ ERROR:", e?.message || e);
    await saveDebug(page, "on-error");
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  // GitHub Actionsで失敗扱いにする
  process.exitCode = 1;
});
