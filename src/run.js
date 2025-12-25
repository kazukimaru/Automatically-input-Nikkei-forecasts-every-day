// src/run.js
import { chromium } from "playwright";

const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const TOP_URL = "https://shi2026.market-price-forecast.com/forecast.php";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing secrets: ${name}`);
  return v;
}

async function saveDebug(page, label = "on-error") {
  try {
    await page.screenshot({ path: "debug.png", fullPage: true });
    const html = await page.content();
    await Bun.write?.("debug.html", html); // Bun環境用（無ければ下のfsに落ちる）
  } catch (_) {
    // ignore
  }
}

async function main() {
  const email = requireEnv("LOGIN_EMAIL");
  const password = requireEnv("LOGIN_PASSWORD");

  // ここは君の「先物取得」ロジックが既にある前提で
  // 例: "50395円 00銭" を作れている状態にする
  // ↓↓↓ いま動いてる値生成をここに残す/移植してね
  const yen = process.env.FORECAST_YEN ?? "50395";
  const sen = process.env.FORECAST_SEN ?? "00";

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log("INFO: opening login page...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    // ログイン画面（君が貼ってくれたHTMLに合わせた）
    const emailInput = page.locator("#accountid");
    const passInput = page.locator("#password");
    const loginBtn = page.locator("#login");

    await emailInput.waitFor({ state: "visible", timeout: 30000 });
    await emailInput.fill(email);
    await passInput.fill(password);

    // ボタンが disabled の間は押せない仕様 → 有効化待つ
    await page.waitForFunction(() => {
      const btn = document.querySelector("#login");
      return btn && !btn.disabled;
    }, { timeout: 30000 });

    await loginBtn.click();

    // ログイン後：TOPへ（strict mode回避で “TOP” の文字を指定）
    // a[href="/forecast.php"] が2つあるので、文字で絞る
    const topLink = page.getByRole("link", { name: "TOP", exact: true });
    await topLink.waitFor({ state: "visible", timeout: 30000 });
    await topLink.click();

    // 投票ページ（forecast.php）にいる前提
    await page.waitForURL(/forecast\.php/, { timeout: 30000 });

    // 円・銭入力（複数ある可能性に備えて first）
    const yenInput = page.locator('input.yen').first();
    const senInput = page.locator('input.sen').first();
    const voteBtn = page.locator('input.submit[value="投票"]').first();

    await yenInput.waitFor({ state: "visible", timeout: 30000 });
    await yenInput.fill(String(yen));

    await senInput.fill(String(sen).padStart(2, "0"));

    await voteBtn.click();

    // 成功っぽい状態確認（適宜メッセージ/ステータスで確認に変えてOK）
    console.log(`OK: voted yen=${yen} sen=${String(sen).padStart(2, "0")}`);
  } catch (e) {
    console.log("DEBUG saved: on-error -> debug.png / debug.html");
    try {
      await page.screenshot({ path: "debug.png", fullPage: true });
      const html = await page.content();
      // Node環境: fsで保存
      const fs = await import("node:fs/promises");
      await fs.writeFile("debug.html", html, "utf-8");
    } catch (_) {}

    console.error("ERROR:", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
