// src/run.js
import { chromium } from "playwright";

const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const TOP_URL = "https://shi2026.market-price-forecast.com/"; // TOPリンク押下後の遷移先が不明でもここ起点でOK

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`ENV ${name} is missing (GitHub Secretsに設定してね)`);
  return v;
}

// Yahoo Finance から先物っぽい値を取る（今は NIY=F を使用）
// 例: https://query1.finance.yahoo.com/v8/finance/chart/NIY=F?range=5d&interval=1d
async function fetchYahooLatestClose(symbol = "NIY=F") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=1d`;

  console.log(`INFO: fetching Yahoo chart... symbol=${symbol}`);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status} ${res.statusText}`);

  const data = await res.json();

  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  const timestamps = result?.timestamp;

  if (!Array.isArray(closes) || closes.length === 0) {
    throw new Error("Yahoo: close array missing (取得できてない)");
  }

  // 末尾が null のことがあるので、最後の非nullを拾う
  let idx = closes.length - 1;
  while (idx >= 0 && (closes[idx] === null || closes[idx] === undefined)) idx--;

  if (idx < 0) throw new Error("Yahoo: all close values are null");

  const latestClose = closes[idx];
  const ts = timestamps?.[idx] ? new Date(timestamps[idx] * 1000).toISOString() : "unknown";

  return { latestClose, timeISO: ts };
}

function toYenSen(value) {
  // value が 50455.12 みたいな想定
  const yen = Math.floor(value);
  const sen = Math.round((value - yen) * 100); // 0〜99
  return { yen, sen };
}

async function firstVisibleLocator(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel);
    try {
      const count = await loc.count();
      if (count > 0) {
        // 表示待ち（すぐ例外なら次へ）
        await loc.first().waitFor({ state: "visible", timeout: 3000 });
        return loc.first();
      }
    } catch (_) {
      // 次の候補へ
    }
  }
  return null;
}

async function confirmOnLoginPage(page) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  console.log(`INFO: page title="${title}" url=${url}`);
}

async function dumpDebug(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  console.log(`DEBUG: url=${url}`);
  console.log(`DEBUG: title=${title}`);

  // スクショ & HTML保存（Actionsでartifactにできる）
  await page.screenshot({ path: "debug.png", fullPage: true });
  const html = await page.content();
  await BunWrite("debug.html", html);
}

// Node標準でファイル保存（Bunなし）
async function BunWrite(path, text) {
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, text, "utf-8");
}

async function main() {
  const email = mustEnv("FORECAST_EMAIL");
  const password = mustEnv("FORECAST_PASSWORD");

  // 先物の取得（今は NIY=F）
  console.log("📈 先物取得中...");
  const { latestClose, timeISO } = await fetchYahooLatestClose("NIY=F");
  const { yen, sen } = toYenSen(latestClose);

  console.log(`取得値: ${latestClose} → ${yen}円 ${sen}銭  time=${timeISO}`);

  // ブラウザ起動
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36",
  });
  const page = await context.newPage();

  // タイムアウト長め
  page.setDefaultTimeout(60000);

  try {
    console.log(`INFO: goto ${LOGIN_URL}`);
    const resp = await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    const status = resp?.status();
    console.log(`INFO: login status=${status}`);
    await confirmOnLoginPage(page);

    // 「メール」「パスワード」欄を複数候補で探す
    const mailInput = await firstVisibleLocator(page, [
      'input[name="mail"]',
      'input#mail',
      'input[type="email"]',
      'input[name="email"]',
      'input[type="text"]', // 最後の保険（ログイン画面の最初の入力欄がメールなら拾える）
    ]);

    const passInput = await firstVisibleLocator(page, [
      'input[name="pass"]',
      'input#pass',
      'input[type="password"]',
      'input[name="password"]',
    ]);

    if (!mailInput || !passInput) {
      console.log("ERROR: ログイン画面の入力欄が見つからない");
      await dumpDebug(page);
      throw new Error("Login inputs not found. debug.png / debug.html を見て原因特定してね");
    }

    await mailInput.fill(email);
    await passInput.fill(password);

    // ログインボタンも複数候補
    const loginBtn =
      (await firstVisibleLocator(page, [
        'input[type="submit"]',
        'button[type="submit"]',
        'input[value*="ログイン"]',
        'button:has-text("ログイン")',
      ])) ?? page.locator("text=ログイン").first();

    console.log("INFO: click login");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      loginBtn.click({ timeout: 30000 }),
    ]);

    console.log("INFO: logged in maybe. current url=", page.url());

    // TOPへ（画面左上の TOP リンク押下想定）
    const topLink = await firstVisibleLocator(page, [
      'a:has-text("TOP")',
      'a:has-text("トップ")',
      "text=TOP",
    ]);
    if (topLink) {
      await Promise.all([page.waitForLoadState("domcontentloaded"), topLink.click()]);
    } else {
      // ない場合はTOP_URLへ直アクセス
      await page.goto(TOP_URL, { waitUntil: "domcontentloaded" });
    }

    // 円と銭の入力欄（ここも複数候補）
    // 画面構造が不明でも、最初の2つのテキスト入力欄を拾う保険を入れる
    const inputs = page.locator('input[type="text"], input[type="number"]');
    const count = await inputs.count();
    if (count < 2) {
      console.log("ERROR: 円/銭入力欄が見つからない");
      await dumpDebug(page);
      throw new Error("Yen/Sen inputs not found. debug.png / debug.html を確認してね");
    }

    // 1つ目：円 2つ目：銭 の想定で入れる
    await inputs.nth(0).fill(String(yen));
    await inputs.nth(1).fill(String(sen));

    // 投票ボタン
    const voteBtn = await firstVisibleLocator(page, [
      'input[type="submit"]',
      'button[type="submit"]',
      'input[value*="投票"]',
      'button:has-text("投票")',
      "text=投票",
    ]);

    if (!voteBtn) {
      console.log("ERROR: 投票ボタンが見つからない");
      await dumpDebug(page);
      throw new Error("Vote button not found. debug.png / debug.html を確認してね");
    }

    console.log("INFO: click vote");
    await Promise.all([page.waitForLoadState("domcontentloaded"), voteBtn.click()]);

    console.log(`✅ VOTED: ${yen}円 ${sen}銭 (from ${latestClose})`);
    console.log(`OK: NIY=F latestClose=${latestClose} time=${timeISO}`);

    await browser.close();
    return;
  } catch (e) {
    console.log("❌ ERROR:", e?.message || e);
    // ここでdebug.png/debug.htmlができてればActions artifactで回収できる
    await browser.close();
    process.exit(1);
  }
}

main();
