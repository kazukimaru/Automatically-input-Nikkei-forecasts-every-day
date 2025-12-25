// src/run.js
// 目的：日経先物（Yahoo Finance: NIY=F）の最新値っぽいものを取得して表示する
// まずは「取得できる」ことを最優先。フォーム入力（Playwright）は次段階。

const SYMBOL = process.env.SYMBOL || "NIY=F"; // 先物。必要なら NKD=F に変えてもOK
const RANGE = process.env.RANGE || "1d";
const INTERVAL = process.env.INTERVAL || "1m";

async function fetchYahooChart(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${encodeURIComponent(RANGE)}&interval=${encodeURIComponent(INTERVAL)}`;

  const res = await fetch(url, {
    headers: {
      // 念のため UA を付ける（ブロック回避というより “普通のブラウザっぽさ”）
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*",
    },
  });

  const text = await res.text();

  // 失敗時に原因が追えるように、ステータスと先頭をログ
  if (!res.ok) {
    throw new Error(`Yahoo chart HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON parse failed: ${text.slice(0, 200)}`);
  }

  // chart の中身を安全にチェック
  const result = data?.chart?.result?.[0];
  const error = data?.chart?.error;

  if (error) {
    throw new Error(`Yahoo chart error: ${JSON.stringify(error)}`);
  }
  if (!result) {
    throw new Error(`Yahoo chart result is empty: ${text.slice(0, 200)}`);
  }

  // 「最新の終値(close)」っぽいものを拾う（nullが混ざるので後ろから探す）
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes) || closes.length === 0) {
    throw new Error(`No close array in chart result`);
  }

  let latestClose = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (typeof closes[i] === "number") {
      latestClose = closes[i];
      break;
    }
  }
  if (latestClose == null) {
    throw new Error(`Close array has no numeric value`);
  }

  // タイムスタンプ（あれば）
  const timestamps = result.timestamp;
  let latestTime = null;
  if (Array.isArray(timestamps) && timestamps.length > 0) {
    latestTime = new Date(timestamps[timestamps.length - 1] * 1000).toISOString();
  }

  return { symbol, latestClose, latestTime };
}

async function main() {
  console.log(`INFO: fetching Yahoo chart... symbol=${SYMBOL}`);

  const { symbol, latestClose, latestTime } = await fetchYahooChart(SYMBOL);

  console.log(`OK: ${symbol} latestClose=${latestClose} time=${latestTime || "N/A"}`);

  // ここで「予想値を作る」なら:
  // 例）先物値をそのまま入力する / 端数を丸める / +α補正する など
  // 今はまず “取れてる” ことが最重要。
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
