// src/run.js
import { chromium } from "playwright";

// ====== 設定 ======
const LOGIN_URL = "https://shi2026.market-price-forecast.com/login.php";
const FORECAST_TOP_URL = "https://shi2026.market-price-forecast.com/forecast.php"; // TOP押下後に行く先
const TIMEOUT = 30_000;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing secrets: ${name}`);
  return v;
}

async function saveDebug(page, reason = "on-error") {
  try {
    await page.screenshot({ path: "debug.png", fullPage: true });
    const html = await page.content();
    await Bun.write?.("debug.html", html); // Bun環境用（もし動かなければ下のfsに切替）
  } catch (_) {
    // GitHub Actions(Node)ではBunが無いのでfsに落とす
    try {
      const fs = await import("node:fs/promises");
      await page.screenshot({ path: "debug.png", fullPage: true });
      const html = await page.content();
      await fs.writeFile("debug.html", html, "utf-8");
    } catch (e2) {
      console.log("DEBUG save failed:", e2?.message ?? e2);
    }
  } finally {
    console.log(`DEBUG saved: ${reason} -> debug.png / debug.html`);
  }
}

async function typeLikeHuman(locator, text) {
  await locator.click({ timeout: TIMEOUT });
  // 既存値クリア
  await locator.press("Control+A").catch(() => {});
  await locator.press("Meta+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  // “キー入力”で入れる（keyup/keydownを確実に発火）
  await locator.type(text, { delay: 30 });
}

async function main() {
  const LOGIN_EMAIL = mustEnv("LOGIN_EMAIL");
  const LOGIN_PASSWORD = mustEnv("LOGIN_PASSWORD");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.setDefaultTimeout(TIMEOUT);

  try {
    console.log("INFO: opening login page...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    // ログイン画面要素
    const emailInput = page.locator("#accountid");
    const passInput = page.locator("#password");
    const loginBtn = page.locator("#login"); // <input type="submit" id="login">

    await emailInput.waitFor({ state: "visible" });
    await passInput.waitFor({ state: "visible" });

    // 入力（typeでイベント発火）
    await typeLikeHuman(emailInput, LOGIN_EMAIL);
    await typeLikeHuman(passInput, LOGIN_PASSWORD);

    // blur（これでvalid判定走るサイトが多い）
    await passInput.press("Tab").catch(() => {});

    // ボタンが有効化されるのを待つ
    await page.waitForFunction(() => {
      const el = document.querySelector("#login");
      return !!el && !el.disabled;
    });

    // click
    await loginBtn.click();

    // ログイン後遷移待ち（forecast.phpが見えたらOK）
    await page.waitForLoadState("domcontentloaded");

    // 「TOP」へ（strict回避）
    // ※TOPリンクが2つある場合があるので first() で1個に決め打ち
    const topLink = page.getByRole("link", { name: "TOP" }).first();
    await topLink.click();
    await page.waitForLoadState("domcontentloaded");

    // 投票ページの入力欄
    const yenInput = page.locator('input.yen');
    const senInput = page.locator('input.sen');
    const voteBtn = page.getByRole("button", { name: "投票" }).or(page.locator('input.submit[value="投票"]'));

    await yenInput.waitFor({ state: "visible" });
    await senInput.waitFor({ state: "visible" });

    // ここは例：先物から計算した値を入れる想定
    // いまは仮で 50000円00銭 にしてる。君の既存ロジックに繋いでOK。
    const yen = "50000";
    const sen = "00";

    await typeLikeHuman(yenInput, yen);
    await typeLikeHuman(senInput, sen);

    await voteBtn.click();

    console.log("OK: voted successfully");

  } catch (err) {
    console.log("ERROR:", err?.message ?? err);
    await saveDebug(page, "on-error");
    throw err;
  } finally {
    await browser.close();
  }
}

main();
