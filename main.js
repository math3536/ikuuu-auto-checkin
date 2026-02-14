/**
 * 单账户 Ikuuu 自动签到脚本（Node 18 / GitHub Actions）
 *
 * 环境变量（统一命名）：
 * - URL: 站点地址，如 "https://ikuuu.nl" 或 "ikuuu.nl"
 * - CONFIG: 单账户 JSON，例如:
 *   {"name":"账号1","email":"a@example.com","passwd":"your_password"}
 * - TELEGRAM_TOKEN: Telegram Bot Token（可选；不填则不通知）
 * - TELEGRAM_TO: Telegram chat id（可选；不填则不通知）
 *
 * 输出：
 * - 写入 GITHUB_OUTPUT: result
 */

"use strict";

const { appendFileSync } = require("fs");

function setGitHubOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return; // 本地运行可能没有
  appendFileSync(out, `${name}<<EOF\n${value}\nEOF\n`);
}

function normalizeBaseUrl(input) {
  const raw = (input || "").trim();
  if (!raw) return "https://ikuuu.nl";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw.replace(/\/+$/, "");
  return `https://${raw.replace(/\/+$/, "")}`;
}

function formatCookie(rawCookieArray) {
  // 将多条 Set-Cookie 归并成 Cookie header
  const cookiePairs = new Map();
  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) cookiePairs.set(match[1].trim(), match[2].trim());
  }
  return Array.from(cookiePairs).map(([k, v]) => `${k}=${v}`).join("; ");
}

function getSetCookieArray(headers) {
  // Node 18 (undici) 支持 headers.getSetCookie()
  if (headers && typeof headers.getSetCookie === "function") {
    const arr = headers.getSetCookie();
    if (Array.isArray(arr) && arr.length) return arr;
  }

  // 兼容：退化读取单个 set-cookie（若服务端合并/或只有一条）
  const single = headers?.get?.("set-cookie");
  if (single) return [single];

  return [];
}

async function sendTelegram(text) {
  const token = (process.env.TELEGRAM_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_TO || "").trim();
  if (!token || !chatId) return; // 未配置就不发

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: "true",
  });

  const resp = await fetch(url, { method: "POST", body });
  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`Telegram 通知失败: HTTP ${resp.status} ${errTxt}`.trim());
  }
}

async function logIn({ baseUrl, account }) {
  const logInUrl = `${baseUrl}/auth/login`;

  const formData = new FormData();
  // 站点常见要求带 host 字段（原脚本也带了）：
  formData.append("host", new URL(baseUrl).host);
  formData.append("email", account.email);
  formData.append("passwd", account.passwd);
  formData.append("code", "");
  formData.append("remember_me", "off");

  const resp = await fetch(logInUrl, { method: "POST", body: formData });
  if (!resp.ok) throw new Error(`登录请求失败 - HTTP ${resp.status}`);

  const json = await resp.json().catch(() => null);
  if (!json || typeof json.ret === "undefined") {
    throw new Error("登录响应解析失败（非预期 JSON）");
  }
  if (json.ret !== 1) {
    throw new Error(`登录失败: ${json.msg || "unknown error"}`);
  }

  const rawCookies = getSetCookieArray(resp.headers);
  if (!rawCookies.length) throw new Error("获取 Cookie 失败（Set-Cookie 为空）");

  return { cookie: formatCookie(rawCookies), loginMsg: json.msg || "login ok" };
}

async function checkIn({ baseUrl, cookie }) {
  const checkInUrl = `${baseUrl}/user/checkin`;

  const resp = await fetch(checkInUrl, {
    method: "POST",
    headers: { Cookie: cookie },
  });

  if (!resp.ok) throw new Error(`签到请求失败 - HTTP ${resp.status}`);

  const json = await resp.json().catch(() => null);
  if (!json) throw new Error("签到响应解析失败（非预期 JSON）");

  // 常见字段：msg
  return json.msg || JSON.stringify(json);
}

function parseAccountFromConfig() {
  if (!process.env.CONFIG) throw new Error("❌ 未配置 CONFIG。");

  let obj;
  try {
    obj = JSON.parse(process.env.CONFIG);
  } catch (e) {
    throw new Error("❌ CONFIG 不是合法 JSON。");
  }

  // 只支持单账户对象；如果你传了数组，自动取第一个并提示
  const account = Array.isArray(obj) ? obj[0] : obj;

  if (!account || typeof account !== "object") throw new Error("❌ CONFIG 内容无效。");
  if (!account.email || !account.passwd) {
    throw new Error("❌ CONFIG 缺少 email/passwd。");
  }

  return {
    name: account.name || account.email,
    email: String(account.email),
    passwd: String(account.passwd),
  };
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.URL);
  const account = parseAccountFromConfig();

  const title = `【Ikuuu 签到】${account.name}`;
  let finalMsg = "";
  let exitCode = 0;

  try {
    console.log(`${account.name}: 登录中...`);
    const { cookie, loginMsg } = await logIn({ baseUrl, account });
    console.log(`${account.name}: ${loginMsg}`);

    console.log(`${account.name}: 签到中...`);
    const checkinMsg = await checkIn({ baseUrl, cookie });
    console.log(`${account.name}: ${checkinMsg}`);

    finalMsg = `${title}\n✅ ${checkinMsg}\n站点：${baseUrl}`;
    setGitHubOutput("result", `✅ ${checkinMsg}`);
  } catch (err) {
    exitCode = 1;
    const msg = err?.message || String(err);
    console.error(`${account.name}: ❌ ${msg}`);

    finalMsg = `${title}\n❌ ${msg}\n站点：${baseUrl}`;
    setGitHubOutput("result", `❌ ${msg}`);
  }

  // 通知（可选）
  try {
    await sendTelegram(finalMsg);
    console.log("Telegram: 已发送通知");
  } catch (e) {
    // 通知失败不影响签到主流程（但会在日志里体现）
    console.error(String(e?.message || e));
  }

  process.exit(exitCode);
}

main();
