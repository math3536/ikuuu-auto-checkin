// iKuuu 自动签到 + 抓流量（本次获得/累计已用/剩余）
// 说明：不同站点主题/版本 HTML 文案不一样，必要时需要调整 parseTraffic() 正则

import { appendFileSync } from "fs";

const host = process.env.HOST || "ikuuu.nl";
const logInUrl = `https://${host}/auth/login`;
const checkInUrl = `https://${host}/user/checkin`;
const userUrl = `https://${host}/user`;

// 格式化 Cookie
function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();
  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) cookiePairs.set(match[1].trim(), match[2].trim());
  }
  return Array.from(cookiePairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

// GitHub Actions step output（多行）
function setGitHubOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

// 从 HTML 里抓字段（多套兼容）
function pickFirst(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}

// 解析用户页流量信息：剩余/累计已用/今日已用（若页面有）
function parseTraffic(html) {
  const remaining =
    pickFirst(html, [
      /剩余流量[:：]\s*([^<\n]+)/i,
      /可用流量[:：]\s*([^<\n]+)/i,
      /Remaining\s*Traffic[:：]\s*([^<\n]+)/i,
    ]) || "";

  const usedTotal =
    pickFirst(html, [
      /累计已用[:：]\s*([^<\n]+)/i,
      /已用流量[:：]\s*([^<\n]+)/i,
      /总共已用[:：]\s*([^<\n]+)/i,
      /Used\s*Traffic[:：]\s*([^<\n]+)/i,
    ]) || "";

  const usedToday =
    pickFirst(html, [
      /今日已用[:：]\s*([^<\n]+)/i,
      /今日使用[:：]\s*([^<\n]+)/i,
      /Today\s*Used[:：]\s*([^<\n]+)/i,
    ]) || "";

  return { remaining, usedTotal, usedToday };
}

// 尝试从签到 msg 提取“本次获得多少流量”
function parseEarnedFromMsg(msg) {
  // 常见：获得了 500MB 流量 / 获得 1 GB / +500MB
  const m =
    msg.match(/获得了?\s*([0-9.]+\s*(?:B|KB|MB|GB|TB))/i) ||
    msg.match(/\+\s*([0-9.]+\s*(?:B|KB|MB|GB|TB))/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
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
  });

  if (!response.ok) throw new Error(`网络请求出错 - ${response.status}`);

  const responseJson = await response.json();
  if (responseJson.ret !== 1) throw new Error(`登录失败: ${responseJson.msg}`);

  console.log(`${account.name}: ${responseJson.msg}`);

  let rawCookieArray = response.headers.getSetCookie?.();
  if (!rawCookieArray || rawCookieArray.length === 0) {
    throw new Error("获取 Cookie 失败");
  }

  return { ...account, cookie: formatCookie(rawCookieArray) };
}

// 签到：返回 msg（以及原始 data 备用）
async function checkIn(account) {
  const response = await fetch(checkInUrl, {
    method: "POST",
    headers: { Cookie: account.cookie },
  });

  if (!response.ok) throw new Error(`网络请求出错 - ${response.status}`);

  const data = await response.json();
  const msg = data?.msg ?? "";
  console.log(`${account.name}: ${msg}`);

  return { msg, data };
}

// 拉用户页 HTML
async function getUserHtml(account) {
  const response = await fetch(userUrl, {
    method: "GET",
    headers: {
      Cookie: account.cookie,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    },
  });

  if (!response.ok) throw new Error(`获取用户页失败 - ${response.status}`);
  return await response.text();
}

// 单账号处理：登录→签到→抓流量→返回汇总
async function processSingleAccount(account) {
  const cooked = await logIn(account);

  const { msg } = await checkIn(cooked);
  const earned = parseEarnedFromMsg(msg) || "0";

  const html = await getUserHtml(cooked);
  const { remaining, usedTotal, usedToday } = parseTraffic(html);

  // 你要的：本次领了多少 / 总共用了多少 / 还剩多少（额外给你今日已用，若解析不到就空）
  const parts = [];
  parts.push(`领取：${earned}`);
  parts.push(`累计已用：${usedTotal || "获取失败"}`);
  if (usedToday) parts.push(`今日已用：${usedToday}`);
  parts.push(`剩余：${remaining || "获取失败"}`);

  return parts.join("｜");
}

// 入口
async function main() {
  let accounts;

  try {
    if (!process.env.ACCOUNTS) throw new Error("❌ 未配置账户信息。");
    accounts = JSON.parse(process.env.ACCOUNTS);
  } catch (error) {
    const message = `❌ ${
      error.message.includes("JSON") ? "账户信息配置格式错误。" : error.message
    }`;
    console.error(message);
    setGitHubOutput("result", message);
    process.exit(1);
  }

  const results = await Promise.allSettled(
    accounts.map((account) => processSingleAccount(account))
  );

  console.log("\n======== 签到结果 ========\n");

  let hasError = false;

  const lines = results.map((r, idx) => {
    const name = accounts[idx]?.name ?? `账号${idx + 1}`;
    const ok = r.status === "fulfilled";
    if (!ok) hasError = true;

    const icon = ok ? "✅" : "❌";
    const msg = ok ? r.value : (r.reason?.message || String(r.reason));
    const line = `${name}: ${icon} ${msg}`;

    ok ? console.log(line) : console.error(line);
    return line;
  });

  const resultMsg = lines.join("\n");
  setGitHubOutput("result", resultMsg);

  if (hasError) process.exit(1);
}

main();
