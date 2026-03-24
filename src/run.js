import { chromium } from "playwright";

const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const TIMEOUT = 30_000;
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ====== retry fetch ======
async function fetchWithRetry(url, options = {}, retries = 3) {
  let lastError;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastError = err;
      console.log(`FETCH RETRY ${i}/${retries}: ${err.message}`);
      if (i < retries) await sleep(i * 1000);
    }
  }
  throw lastError;
}

// ====== Yahoo取得 ======
async function fetchNightPrice() {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_SYMBOL)}` +
    `?range=2d&interval=5m&includePrePost=true`;

  const res = await fetchWithRetry(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  }, 3);

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo result empty");

  const ts = result.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;

  for (let i = ts.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i])) {
      return { price: closes[i], timestamp: ts[i] };
    }
  }
  throw new Error("No valid close price");
}

function splitYenSen(price) {
  const fixed = Number(price).toFixed(2);
  const [yen, frac = "00"] = fixed.split(".");
  return { yen, sen: frac.slice(0, 2) };
}

async function postSlack(text) {
  const url = optEnv("SLACK_WEBHOOK_URL", "");
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

function formatJst(unixSec) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(unixSec * 1000));
}

// ====== Playwright本体 ======
async function runPlaywright(yen, sen) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    await page.goto(LOGIN_URL);

    await page.locator("#accountid").fill(process.env.LOGIN_EMAIL);
    await page.locator("#password").fill(process.env.LOGIN_PASSWORD);

    await page.locator("#login").click();
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("link", { name: "TOP" }).first().click();

    await page.locator("input.yen").fill(yen);
    await page.locator("input.sen").fill(sen);

    const submitBtn = page
      .locator('input.submit[value="投票"]')
      .or(page.locator('input.submit[value="訂正"]'));

    await submitBtn.first().click();

  } finally {
    await browser.close();
  }
}

// ====== Playwright retry ======
async function runWithRetry(yen, sen, maxRetry = 2) {
  let lastError;

  for (let i = 1; i <= maxRetry; i++) {
    try {
      console.log(`PLAYWRIGHT TRY ${i}/${maxRetry}`);
      await runPlaywright(yen, sen);
      return { success: true, attempt: i };
    } catch (err) {
      lastError = err;
      console.log(`PLAYWRIGHT ERROR ${i}: ${err.message}`);
      if (i < maxRetry) await sleep(2000);
    }
  }

  return { success: false, attempt: maxRetry, error: lastError };
}

// ====== main ======
async function main() {
  const start = Date.now();
  const runId = Date.now();

  try {
    const { price, timestamp } = await fetchNightPrice();
    const { yen, sen } = splitYenSen(price);
    const time = formatJst(timestamp);

    const result = await runWithRetry(yen, sen, 2);

    const duration = ((Date.now() - start) / 1000).toFixed(1);

    if (result.success) {
      await postSlack(
        `✅ SUCCESS\n` +
        `値: ${yen}円${sen}銭\n` +
        `時刻: ${time}\n` +
        `試行回数: ${result.attempt}\n` +
        `実行時間: ${duration}s\n` +
        `runId: ${runId}`
      );
    } else {
      throw result.error;
    }

  } catch (err) {
    const duration = ((Date.now() - start) / 1000).toFixed(1);

    await postSlack(
      `❌ FAILED\n` +
      `エラー: ${err.message}\n` +
      `実行時間: ${duration}s\n` +
      `runId: ${runId}`
    );

    throw err;
  }
}

main();
