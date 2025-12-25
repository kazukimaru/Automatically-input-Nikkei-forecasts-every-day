import { chromium } from "playwright";

/* ==========
   設定
========== */
const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const SYMBOL = "NIY=F";

/* ==========
   Yahooから先物取得
========== */
async function fetchFuturePrice() {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?range=1d&interval=1m`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  });

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;

  for (let i = closes.length - 1; i >= 0; i--) {
    if (typeof closes[i] === "number") {
      return closes[i];
    }
  }
  throw new Error("先物価格が取得できません");
}

/* ==========
   円・銭に分解
========== */
function splitYenSen(value) {
  const rounded = Math.round(value * 100) / 100;
  const yen = Math.floor(rounded);
  const sen = Math.round((rounded - yen) * 100);
  return { yen, sen };
}

/* ==========
   メイン処理
========== */
async function main() {
  console.log("📈 先物取得中...");
  const future = await fetchFuturePrice();
  const { yen, sen } = splitYenSen(future);

  console.log(`取得値: ${future} → ${yen}円 ${sen}銭`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  /* --- ログイン --- */
  await page.goto(LOGIN_URL);

  await page.fill('input[name="mail"]', process.env.LOGIN_EMAIL);
  await page.fill('input[name="pass"]', process.env.LOGIN_PASSWORD);
  await page.click('input[type="submit"]');

  /* --- TOPへ --- */
  await page.waitForSelector('a:has-text("TOP")');
  await page.click('a:has-text("TOP")');

  /* --- 投票画面 --- */
  await page.waitForSelector('input[name="yen"]');

  await page.fill('input[name="yen"]', String(yen));
  await page.fill('input[name="sen"]', String(sen));

  await page.click('input[type="submit"]');

  console.log("✅ 投票完了");

  await browser.close();
}

main().catch(err => {
  console.error("❌ ERROR:", err);
  process.exit(1);
});
