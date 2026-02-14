/**
 * IKUUU 自动签到脚本（Node 18 / GitHub Actions）
 *
 * 环境变量：
 * - URL: 站点地址，如 "https://ikuuu.nl" 或 "ikuuu.nl"
 * - CONFIG:
 *    1) 单账号对象：
 *       {"name":"jack","email":"a@example.com","passwd":"your_password"}
 *    2) 多账号数组：
 *       [{"name":"a","email":"a@xx.com","passwd":"p1"},{"name":"b","email":"b@xx.com","passwd":"p2"}]
 *
 * Telegram（可选）：
 * - TELEGRAM_TOKEN / TELEGRAM_TO
 */

"use strict";

const { appendFileSync } = require("fs");

// ---------------------- GitHub Actions Output ----------------------

function setGitHubOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  appendFileSync(out, `${name}<<EOF\n${value}\nEOF\n`);
}

// ---------------------- Utils ----------------------

function normalizeBaseUrl(input) {
  const raw = (input || "").trim();
  if (!raw) return "https://ikuuu.nl";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw.replace(/\/+$/, "");
  return `https://${raw.replace(/\/+$/, "")}`;
}

function getSetCookieArray(headers) {
  // Node 18 (undici) 支持 headers.getSetCookie()
  if (headers && typeof headers.getSetCookie === "function") {
    const arr = headers.getSetCookie();
    if (Array.isArray(arr) && arr.length) return arr;
  }
  // 兼容：只有一条 set-cookie 的情况
  const single = headers?.get?.("set-cookie");
  if (single) return [single];
  return [];
}

function formatCookie(rawCookieArray) {
  // 将多条 Set-Cookie 归并成 Cookie header
  const cookiePairs = new Map();
  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) cookiePairs.set(match[1].trim(), match[2].trim());
  }
  return Array.from(cookiePairs)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// ---------------------- Telegram ----------------------

async function sendTelegramHtml(html) {
  const token = (process.env.TELEGRAM_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_TO || "").trim();
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: "true",
  });

  const resp = await fetch(url, { method: "POST", body });
  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`Telegram 通知失败: HTTP ${resp.status} ${errTxt}`.trim());
  }

  console.log("Telegram: 已发送通知");
}

// ---------------------- Config ----------------------

function parseAccountsFromConfig() {
  if (!process.env.CONFIG) throw new Error("❌ 未配置 CONFIG。");

  let obj;
  try {
    obj = JSON.parse(process.env.CONFIG);
  } catch {
    throw new Error("❌ CONFIG 不是合法 JSON。");
  }

  const arr = Array.isArray(obj) ? obj : [obj];
  if (!arr.length) throw new Error("❌ CONFIG 为空。");

  return arr.map((a, idx) => {
    if (!a || typeof a !== "object") throw new Error(`❌ CONFIG 第 ${idx + 1} 个账号内容无效。`);
    if (!a.email || !a.passwd) throw new Error(`❌ CONFIG 第 ${idx + 1} 个账号缺少 email/passwd。`);
    return {
      name: a.name || a.email,
      email: String(a.email),
      passwd: String(a.passwd),
    };
  });
}

// ---------------------- IKUUU Actions ----------------------

async function logIn({ baseUrl, account }) {
  const logInUrl = `${baseUrl}/auth/login`;

  const formData = new FormData();
  formData.append("host", new URL(baseUrl).host);
  formData.append("email", account.email);
  formData.append("passwd", account.passwd);
  formData.append("code", "");
  formData.append("remember_me", "off");

  const response = await fetch(logInUrl, { method: "POST", body: formData });
  const text = await response.text();

  const cookies = formatCookie(getSetCookieArray(response.headers));
  if (!cookies) return { ok: false, cookies: "", text };

  return { ok: true, cookies, text };
}

async function checkIn({ baseUrl, cookies }) {
  const checkInUrl = `${baseUrl}/user/checkin`;

  const res = await fetch(checkInUrl, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/x-www-form-urlencoded",
      referer: `${baseUrl}/user`,
    },
    body: new URLSearchParams({}),
  });

  const json = await res.json().catch(() => null);
  return { ok: res.ok, json };
}

// ---------------------- Notify Builder (更像卡片) ----------------------

function classifyStatus(text) {
  const s = String(text || "");
  if (/(失败|错误|异常|error|fail)/i.test(s)) return "fail";
  if (/(已签到|已经签到|似乎已经签到|重复签到)/.test(s)) return "already";
  if (/(成功|success)/i.test(s)) return "success";
  return "info";
}

function statusEmoji(kind) {
  if (kind === "success") return "✅";
  if (kind === "already") return "⚠️";
  if (kind === "fail") return "❌";
  return "ℹ️";
}

function prettyLoginText(raw) {
  const kind = classifyStatus(raw);
  const emoji = statusEmoji(kind);

  if (kind === "success") return `${emoji} 登录成功`;
  if (kind === "fail") return `${emoji} 登录失败`;
  return `${emoji} ${String(raw || "登录信息")}`;
}

function prettyCheckinText(raw) {
  const s = String(raw || "");
  const kind = classifyStatus(s);
  const emoji = statusEmoji(kind);

  if (kind === "success") return `${emoji} 签到成功`;
  if (kind === "already") return `${emoji} 已签到（无需重复）`;

  return `${emoji} ${s || "签到结果未知"}`;
}

function buildAccountBlock(name, { loginRaw, checkinRaw, extraRaw = [] }) {
  const lines = [];
  lines.push(`👤 ${name}`);

  if (loginRaw !== undefined) lines.push(`  🔐 ${prettyLoginText(loginRaw)}`);
  if (checkinRaw !== undefined) lines.push(`  🎯 ${prettyCheckinText(checkinRaw)}`);

  for (const x of extraRaw) {
    const kind = classifyStatus(x);
    lines.push(`  🧾 ${statusEmoji(kind)} ${String(x)}`);
  }

  return lines;
}

function detectOverallIcon(lines) {
  const text = lines.join("\n");
  if (/(失败|错误|异常|error|fail)/i.test(text)) return "❌";
  if (/(已签到|已经签到|似乎已经签到|重复签到)/.test(text)) return "⚠️";
  if (/(成功|success)/i.test(text)) return "✅";
  return "ℹ️";
}

function buildTelegramHtml({ timeStr, titleName, lines }) {
  const icon = detectOverallIcon(lines);

  const safeTitle = escapeHtml(titleName);
  const safeTime = escapeHtml(timeStr);
  const safeLines = lines.map((l) => escapeHtml(l)).join("\n");

  return (
    `${icon} <b>${safeTitle}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🕒 <b>时间：</b>${safeTime}\n\n` +
    `📊 <b>执行结果：</b>\n` +
    `<pre>${safeLines}</pre>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `<i>#ikuuu #checkin</i>`
  );
}

// ---------------------- Main ----------------------

(async () => {
  const baseUrl = normalizeBaseUrl(process.env.URL);
  const accounts = parseAccountsFromConfig();

  const timeStr = formatTime(new Date());
  const summaryLines = [];

  for (const account of accounts) {
    try {
      const loginRes = await logIn({ baseUrl, account });

      if (!loginRes.ok) {
        summaryLines.push(
          ...buildAccountBlock(account.name, {
            loginRaw: "登录失败（未获取到会话 Cookie）",
            extraRaw: ["请检查账号密码 / 站点是否变更 / 是否需要验证码"],
          }),
          "" // 账号间空行
        );
        continue;
      }

      const checkinRes = await checkIn({ baseUrl, cookies: loginRes.cookies });
      const msg = checkinRes?.json?.msg || (checkinRes.ok ? "签到请求已发送" : "签到请求失败");

      summaryLines.push(
        ...buildAccountBlock(account.name, {
          loginRaw: "登录成功",
          checkinRaw: msg,
        }),
        ""
      );
    } catch (e) {
      const err = String(e?.message || e);
      summaryLines.push(
        ...buildAccountBlock(account.name, {
          loginRaw: "异常",
          extraRaw: [`异常：${err}`],
        }),
        ""
      );
    }
  }

  // 去掉最后一个多余空行
  while (summaryLines.length && summaryLines[summaryLines.length - 1] === "") summaryLines.pop();

  const resultText = summaryLines.join("\n");
  console.log(resultText);
  setGitHubOutput("result", resultText);

  // 汇总只发一条
  try {
    const html = buildTelegramHtml({
      timeStr,
      titleName: "IKUUU 签到通知（汇总）",
      lines: summaryLines.length ? summaryLines : ["无可用结果（CONFIG 可能为空）"],
    });
    await sendTelegramHtml(html);
  } catch (e) {
    console.error(String(e?.message || e));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
