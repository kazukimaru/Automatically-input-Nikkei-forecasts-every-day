// src/run.js
// 目的：Nikkei 225 先物（Stooq: NY.F）の最新の終値を取得して表示する
// メモ：Stooq の CSV は認証なしで取れる

function parseStooqDailyCsv(csvText) {
  // 例:
  // Date,Open,High,Low,Close,Volume
  // 2025-12-24,50165.0,50815.0,49755.0,50490.0,0
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) {
    throw new Error("CSVの行数が足りない（データが取得できてない可能性）");
  }

  const header = lines[0].split(",");
  const last = lines[lines.length - 1].split(",");

  const idx = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSVヘッダーに ${name} が無い`);
    return i;
  };

  const date = last[idx("Date")];
  const closeStr = last[idx("Close")];
  const close = Number(closeStr);

  if (!Number.isFinite(close)) {
    throw new Error(`Closeが数値になってない: ${closeStr}`);
  }

  return { date, close };
}

function roundToNearest(value, unit) {
  // unit=10なら10円刻み、unit=5なら5円刻み等
  return Math.round(value / unit) * unit;
}

async function main() {
  // Stooq: NY.F = Nikkei 225 futures
  // i=d は日足
  const url = "https://stooq.com/q/l/?s=ny.f&i=d";

  const res = await fetch(url, {
    headers: {
      // Stooq側で弾かれにくくするため軽く指定（必須ではない）
      "User-Agent": "nikkei-forecast-bot/1.0",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${text}`);
  }

  const csv = await res.text();
  const { date, close } = parseStooqDailyCsv(csv);

  // ここが「先物の数値」。まずはこれをログで確認できればOK。
  console.log(`[NY.F] date=${date} close=${close}`);

  // 予想値の例：先物をそのまま使う、かつ 10円刻みに丸める（仮）
  const forecast = roundToNearest(close, 10);
  console.log(`forecast=${forecast}`);

  // 次のステップで、ここから Playwright を使ってフォームに入力する
}

main().catch((err) => {
  console.error("ERROR:", err?.stack || err);
  process.exit(1);
});
