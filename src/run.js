async function main() {
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=NKD=F";

  const res = await fetch(url);
  const data = await res.json();

  const price =
    data.quoteResponse.result[0].regularMarketPrice;

  console.log("📈 日経平均先物の価格:", price);
}

main();
