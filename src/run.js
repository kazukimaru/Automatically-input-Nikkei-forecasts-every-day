import fs from "fs";
import { chromium } from "playwright";

// Node 20+ は fetch が使える
async function fetchYahooLatestClose(symbol) {
  // YahooのチャートAPI（非公式）
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;

  console.log(`INFO: fetching Yahoo chart... symbol=${symbol}`);

  const res = await fetch(url, {
    headers: {
      // GitHub Actions で弾かれにくくするため
      "User-Agent": "Mozilla/5.0 (compatible; nikkei-forecast-bot/1.0)",
      "Accept": "application/json,text/plain,*/*",
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const closeArr = result?.indicators?.quote?.[0]?.close;
  const timestamps = result?.timestamp;

  if (!Array.isArray(closeArr) || closeArr.length === 0) {
    throw new Error("Yahoo chart close array is empty");
  }

  // null が混ざることがあるので最後の有効値を拾う
  let latestClose = null;
  let latestTime = null;
  for (let i = closeArr.length - 1; i >= 0; i--) {
    const v = closeArr[i];
    if (Number.isFinite(v)) {
      latestClose = v;
      latestTime = timestamps?.[i] ? new Date(timestamps[i] * 1000).toISOString() : null;
      break;
    }
  }

  if (!Number.isFinite(latestClose)) {
    throw new Error("Could not find finite close value");
  }

  console.log(`OK: ${symbol} latestClose=${latestClose} time=${latestTime}`);
  return { latestClose, latestTime };
}

function toYenSen(priceNumber) {
  // 例：50455.12 → 50455円 12銭
  const yen = Math.floor(priceNumber);
  let sen = Math.round((priceNumber - yen) * 100);

  // 100銭になったら繰り上げ
  if (sen >= 100) {
    sen = 0;
    return { yen: yen + 1, sen };
  }
  if (sen < 0) sen = 0;

  return { yen, sen };
}

async function saveDebug(page, label) {
  try {
    await page.screenshot({ path: "debug.png", fullPage: true });
    const html = await page.content();
    fs.writeFileSync("debug.html", html, "utf-8");
    console.log(`DEBUG saved: ${label} -> debug.png / debug.html`);
  } catch (e) {
    console.log("DEBUG save failed:", e?.message || e);
  }
}

async function main() {
  const EMAIL = process.env.LOGIN_EMAIL;
  const PASSWORD = process.env.LOGIN_PASSWORD;

  if (!EMAIL || !PASSWORD) {
    throw new Error("Missing secrets: FORECAST_EMAIL / FORECAST_PASSWORD");
  }

  // 日経先物っぽいシンボル（君のログに出てた NIY=F を踏襲）
  const YAHOO_SYMBOL = process.env.YAHOO_SYMBOL || "NIY=F";

  console.log("📈 先物取得中...");
  const { latestClose } = await fetchYahooLatestClose(YAHOO_SYMBOL);

  // 予想値（とりあえず先物終値をそのまま円/銭に）
  const { yen, sen } = toYenSen(latestClose);
  console.log(`取得値: ${latestClose} → ${yen}円 ${String(sen).padStart(2, "0")}銭`);

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1) ログインページへ
    await page.goto("https://shi2026.market-price-forecast.com/login.php", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // ログインフォームが出るまで待つ（★ここが今回の修正点）
    await page.waitForSelector("#accountid", { timeout: 60_000 });

    // 2) 入力
    await page.fill("#accountid", EMAIL);
    await page.fill("#password", PASSWORD);

    // 3) ログイン
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
      page.click("#login"),
    ]);

    // 4) ログイン後ホームで TOP を押す（/forecast.php）
    await page.waitForSelector('a[href="/forecast.php"]', { timeout: 60_000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
      page.click('a[href="/forecast.php"]'),
    ]);

    // 5) 投票ページ：円・銭
    await page.waitForSelector("input.yen", { timeout: 60_000 });
    await page.fill("input.yen", String(yen));

    await page.waitForSelector("input.sen", { timeout: 60_000 });
    await page.fill("input.sen", String(sen).padStart(2, "0"));

    // 6) 投票ボタン
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null),
      page.click('input.submit[value="投票"]'),
    ]);

    // 成功っぽい判定（ページ内に「ステータス」や「投票済」みたいなのが出るなら、ここをもっと強化できる）
    console.log("✅ 投票処理を実行しました（画面確認ログはArtifactsで見れるようにします）");

    // 成功時もデバッグ保存しておくと安心（不要なら消してOK）
    await saveDebug(page, "after-vote");
  } catch (e) {
    console.log("❌ ERROR:", e?.message || e);
    await saveDebug(page, "on-error");
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
