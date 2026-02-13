// 不直接使用 Cookie 是因为 Cookie 过期时间较短。

import { appendFileSync } from "fs";

const host = process.env.HOST || "ikuuu.nl";

const logInUrl = `https://${host}/auth/login`;
const checkInUrl = `https://${host}/user/checkin`;

// Telegram（只保留 TG，不再支持 SCKEY/Server酱）
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";

// 格式化 Cookie
function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();

  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) {
      cookiePairs.set(match[1].trim(), match[2].trim());
    }
  }

  return Array.from(cookiePairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

// 读取 JSON：若返回 HTML/空，会给出更友好的错误信息
async function safeJson(response, tag) {
  const ct = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!text.trim()) {
    throw new Error(`${tag}: 空响应（HTTP ${response.status}，content-type=${ct}）`);
  }

  try {
    return JSON.parse(text);
  } catch {
    const head = text.slice(0, 200).replace(/\n/g, "\\n");
    throw new Error(
      `${tag}: 非JSON响应（HTTP ${response.status}，content-type=${ct}，body(head)=${JSON.stringify(head)}）`
    );
  }
}

// Telegram 推送：严格校验 ok 字段（避免“HTTP 200 但 ok=false 仍显示成功”）
async function pushTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  const api = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;

  const resp = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  // HTTP 层失败
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 200);
    throw new Error(`Telegram HTTP失败: ${resp.status}, body(head)=${JSON.stringify(body)}`);
  }

  // 业务层失败（HTTP 200 也可能 ok=false）
  const data = await safeJson(resp, "telegram");
  if (!data.ok) {
    throw new Error(`Telegram ok=false: ${JSON.stringify(data)}`);
  }
}

// 登录获取 Cookie
async function logIn(account) {
  console.log(`${account.name}: 登录中...`);

  const formData = new FormData();
  formData.append("host", host);
  formData.append("email", account.email);
  formData.append("passwd", account.passwd);
  formData.append("code", "");
  formData.append("remember_me", "off");

  const response = await fetch(logInUrl, {
    method: "POST",
    body: formData,
    // 让服务端更愿意返回 JSON（有些面板会按 header 返回页面/JSON）
    headers: {
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/plain, */*",
      referer: `https://${host}/auth/login`,
    },
  });

  if (!response.ok) {
    throw new Error(`网络请求出错 - ${response.status}`);
  }

  const responseJson = await safeJson(response, "login");

  if (responseJson.ret !== 1) {
    throw new Error(`登录失败: ${responseJson.msg}`);
  } else {
    console.log(`${account.name}: ${responseJson.msg}`);
  }

  // Node 20+ 支持 getSetCookie；建议 workflow 用 node 20（见下方）
  const rawCookieArray = response.headers.getSetCookie?.() || [];
  if (!rawCookieArray || rawCookieArray.length === 0) {
    // 兜底：尝试读取 set-cookie（某些环境 getSetCookie 不存在）
    const sc = response.headers.get("set-cookie");
    if (!sc) {
      throw new Error("获取 Cookie 失败（未拿到 set-cookie）");
    }
    rawCookieArray.push(sc);
  }

  return { ...account, cookie: formatCookie(rawCookieArray) };
}

// 签到
async function checkIn(account) {
  const response = await fetch(checkInUrl, {
    method: "POST",
    headers: {
      Cookie: account.cookie,
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/plain, */*",
      referer: `https://${host}/user`,
    },
  });

  if (!response.ok) {
    throw new Error(`网络请求出错 - ${response.status}`);
  }

  const data = await safeJson(response, "checkin");
  console.log(`${account.name}: ${data.msg}`);

  return data.msg;
}

// 处理
async function processSingleAccount(account) {
  const cookedAccount = await logIn(account);
  const checkInResult = await checkIn(cookedAccount);
  return checkInResult;
}

function setGitHubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

// 入口
async function main() {
  let accounts;

  try {
    if (!process.env.ACCOUNTS) {
      throw new Error("❌ 未配置账户信息。");
    }
    accounts = JSON.parse(process.env.ACCOUNTS);
  } catch (error) {
    const message = `❌ ${
      error.message.includes("JSON") ? "账户信息配置格式错误。" : error.message
    }`;
    console.error(message);
    setGitHubOutput("result", message);

    // 解析失败也尝试推送一次（可选）
    try {
      await pushTelegram(message);
      console.log("Telegram 推送成功（ok=true）");
    } catch (e) {
      console.error(`Telegram 推送失败：${e.message}`);
    }

    process.exit(1);
  }

  const allPromises = accounts.map((account) => processSingleAccount(account));
  const results = await Promise.allSettled(allPromises);

  const msgHeader = "\n======== 签到结果 ========\n\n";
  console.log(msgHeader);

  let hasError = false;

  const resultLines = results.map((result, index) => {
    const accountName = accounts[index].name;
    const isSuccess = result.status === "fulfilled";
    if (!isSuccess) hasError = true;

    const icon = isSuccess ? "✅" : "❌";
    const message = isSuccess ? result.value : result.reason?.message || String(result.reason);

    const line = `${accountName}: ${icon} ${message}`;
    isSuccess ? console.log(line) : console.error(line);
    return line;
  });

  const resultMsg = resultLines.join("\n");

  setGitHubOutput("result", resultMsg);

  // ✅ 统一推送（只用 Telegram）
  if (TG_BOT_TOKEN && TG_CHAT_ID) {
    try {
      await pushTelegram(resultMsg);
      console.log("Telegram 推送成功（ok=true）");
    } catch (e) {
      console.error(`Telegram 推送失败：${e.message}`);
      // 推送失败也视为失败，方便你在 Actions 里看到红灯
      hasError = true;
    }
  } else {
    console.log("未配置 Telegram 推送（TG_BOT_TOKEN/TG_CHAT_ID），跳过通知");
  }

  if (hasError) process.exit(1);
}

main();
