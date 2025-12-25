// src/run.js
import { chromium } from "playwright";

// ====== 設定（GitHub Secrets から読む） ======
const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const EMAIL = process.env.FORECAST_EMAIL;
const PASSWORD = process.env.FORECAST_PASSWORD;

// 先物データ（いまログでNIY=F取れてるやつを使う想定）
const FUTURES_SYMBOL = process.env.FUTURES_SYMBOL || "NIY=F"; // 日経先物の例
const YAHOO_CHART_URL = (symbol) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;

// Slack通知（Incoming Webhook）
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// ====== ユーティリティ ======
async function slackNotify(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    // Slack失敗は致命傷にしない
    console.log("WARN: Slack notify failed:", e?.message || e);
  }
}

async function fetchYahooLatestClose(symbol) {
  console.log(`INFO: fetching Yahoo chart... symbol=${symbol}`);
  const res = await fetch(YAHOO_CHART_URL(symbol), {
    headers: {
      // GitHub Actions上で弾かれることがあるので軽く偽装（超重要）
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "application/json,text/plain,*/*",
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo chart fetch failed: HTTP ${res.status}`);
  }

  const data = await res.json();

  const result = data?.chart?.result?.[0];
  const close = result?.indicators?.quote?.[0]?.close;
  const timestamps = result?.timestamp;

  if (!Array.isArray(close) || close.length === 0) {
    throw new Error("CSVの行数が足りない（データが取得できてない可能性）");
  }

  // closeの最後はnullのときがあるので、後ろから有効値を探す
  let latestClose = null;
  let latestTime = null;
  for (let i = close.length - 1; i >= 0; i--) {
    if (Number.isFinite(close[i])) {
      latestClose = close[i];
      latestTime = timestamps?.[i] ? new Date(timestamps[i] * 1000) : null;
      break;
    }
  }

  if (!Number.isFinite(latestClose)) {
    throw new Error("latestClose が取れなかった（closeが全部nullの可能性）");
  }

  console.log(`OK: ${symbol} latestClose=${latestClose} time=${latestTime?.toISOString()}`);
  return { latestClose, latestTime };
}

// 予想値 → 円/銭に分割（例：50455.12 → 50455円 12銭）
function toYenSen(value) {
  const rounded = Math.round(value * 100) / 100; // 小数2桁
  const yen = Math.floor(rounded);
  const sen = Math.round((rounded - yen) * 100);
  return { yen: String(yen), sen: String(sen).padStart(2, "0") };
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    throw new Error("FORECAST_EMAIL / FORECAST_PASSWORD が未設定（GitHub Secretsを確認）");
  }

  // 1) 先物取得
  const { latestClose } = await fetchYahooLatestClose(FUTURES_SYMBOL);

  // ここはあなたのルールで調整OK
  // 「先物の終値をそのまま入れる」例（小数なしにしたければ Math.round を使う）
  const target = latestClose;
  const { yen, sen } = toYenSen(target);

  console.log(`📈 先物取得中...`);
  console.log(`取得値: ${target} → ${yen}円 ${sen}銭`);

  // 2) ブラウザで入力
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // 失敗時のデバッグ用
    page.setDefaultTimeout(60_000);

    // ログインページ
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    // あなたが教えてくれた正しいセレクタ
    await page.locator("#accountid").fill(EMAIL);
    await page.locator("#password").fill(PASSWORD);

    // ログイン押下→遷移待ち
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.locator("#login").click(),
    ]);

    // 3) TOPへ（ログイン後ホームに TOPリンクがある）
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.getByRole("link", { name: "TOP" }).click(),
    ]);

    // 4) 投票ページで入力（classで拾う）
    // 円: input.yen, 銭: input.sen
    await page.locator("input.yen").fill(yen);
    await page.locator("input.sen").fill(sen);

    // 投票ボタン
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => null),
      page.locator('input.submit[value="投票"]').click(),
    ]);

    // 成功っぽい判定（ページに「投票済」や「ステータス」が出るならここを強化）
    const content = await page.content();
    const ok = content.includes("投票") || content.includes("ステータス");

    if (!ok) {
      throw new Error("投票完了の判定ができなかった（画面文言が想定と違う可能性）");
    }

    console.log("✅ 投票処理: たぶん成功");
    await slackNotify(`✅ 日経平均フォーキャスト投票 成功\n${yen}円${sen}銭（元データ: ${FUTURES_SYMBOL}）`);
  } catch (e) {
    // デバッグ用スクショ（ActionsのArtifactsに上げる）
    try {
      await page.screenshot({ path: "debug.png", fullPage: true });
    } catch {}

    console.log("❌ ERROR:", e?.message || e);
    await slackNotify(`❌ 日経平均フォーキャスト投票 失敗\n原因: ${e?.message || e}`);
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
