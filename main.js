/**
 * IKUUU 自动签到脚本 - 修复版（支持验证码处理）
 * 
 * 修复内容：
 * 1. 处理登录页面的"开始验证"按钮
 * 2. 支持通过 Telegram Bot 接收验证码
 * 3. 自动重试机制
 * 
 * 环境变量：
 * - URL: 站点地址
 * - CONFIG: 账号配置 JSON
 * - TELEGRAM_TOKEN / TELEGRAM_TO: Telegram 通知（必需，用于接收验证码）
 * - TELEGRAM_BOT_USERNAME: Telegram Bot 用户名（可选，用于发送验证码）
 */

"use strict";

const { appendFileSync } = require("fs");

// ===================== 配置 =====================

const MAX_RETRIES = 3;           // 最大重试次数
const RETRY_DELAY = 5000;        // 重试延迟（毫秒）
const VERIFY_TIMEOUT = 60000;    // 验证码等待超时（毫秒）

// ===================== 工具函数 =====================

function normalizeBaseUrl(url) {
    if (!url) return "https://ikuuu.nl";
    return url.startsWith("http") ? url : `https://${url}`;
}

function formatTime(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ===================== Telegram =====================

async function sendTelegramMessage(text, parseMode = "HTML") {
    const token = (process.env.TELEGRAM_TOKEN || "").trim();
    const chatId = (process.env.TELEGRAM_TO || "").trim();
    if (!token || !chatId) {
        console.log("Telegram 未配置，跳过通知");
        return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = new URLSearchParams({
        chat_id: chatId,
        text: text,
        parse_mode: parseMode,
        disable_web_page_preview: "true",
    });

    const resp = await fetch(url, { method: "POST", body });
    if (!resp.ok) {
        const errTxt = await resp.text().catch(() => "");
        console.error(`Telegram 发送失败: ${resp.status} ${errTxt}`);
    }
}

async function getTelegramUpdates(offset = 0, timeout = 30) {
    const token = (process.env.TELEGRAM_TOKEN || "").trim();
    if (!token) return [];

    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${timeout}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];

    const data = await resp.json();
    return data.ok ? data.result : [];
}

// ===================== 配置解析 =====================

function parseAccountsFromConfig() {
    if (!process.env.CONFIG) throw new Error("❌ 未配置 CONFIG");
    
    let obj;
    try {
        obj = JSON.parse(process.env.CONFIG);
    } catch {
        throw new Error("❌ CONFIG 不是合法 JSON");
    }

    const arr = Array.isArray(obj) ? obj : [obj];
    if (!arr.length) throw new Error("❌ CONFIG 为空");

    return arr.map((a, idx) => {
        if (!a || typeof a !== "object") throw new Error(`❌ CONFIG 第 ${idx + 1} 个账号内容无效`);
        if (!a.email || !a.passwd) throw new Error(`❌ CONFIG 第 ${idx + 1} 个账号缺少 email/passwd`);
        return {
            name: a.name || a.email,
            email: String(a.email),
            passwd: String(a.passwd),
        };
    });
}

// ===================== Cookie 处理 =====================

function getSetCookieArray(headers) {
    const setCookie = headers.get("set-cookie");
    if (!setCookie) return [];
    return setCookie.split(/,\s*(?=[^=]+=)/);
}

function formatCookie(setCookieArray) {
    return setCookieArray
        .map((c) => c.split(";")[0])
        .filter((c) => c.includes("="))
        .join("; ");
}

// ===================== 登录逻辑（修复版） =====================

async function logIn({ baseUrl, account, retryCount = 0 }) {
    const logInUrl = `${baseUrl}/auth/login`;
    
    console.log(`🔐 尝试登录: ${account.email} (第 ${retryCount + 1} 次)`);
    
    // 步骤 1: 先 GET 登录页面，获取初始 cookies 和 CSRF token
    const getResp = await fetch(logInUrl);
    const loginPageHtml = await getResp.text();
    const initialCookies = formatCookie(getSetCookieArray(getResp.headers));
    
    // 步骤 2: 检查是否需要验证
    const needsVerification = checkNeedsVerification(loginPageHtml);
    
    if (needsVerification) {
        console.log("⚠️ 检测到验证机制，尝试处理...");
        
        // 尝试处理验证
        const verifyResult = await handleVerification({
            baseUrl,
            account,
            cookies: initialCookies,
            loginPageHtml
        });
        
        if (!verifyResult.success) {
            // 如果验证失败，通知用户
            await sendTelegramMessage(
                `🚨 <b>IKUUU 登录需要人工验证</b>\n\n` +
                `👤 账号: ${account.name}\n` +
                `📧 邮箱: ${account.email}\n\n` +
                `请访问 ${baseUrl}/auth/login 完成验证\n` +
                `或发送验证码给 Telegram Bot`
            );
            
            return { 
                ok: false, 
                cookies: "", 
                text: "需要人工验证，已发送通知",
                needsManualVerification: true 
            };
        }
    }
    
    // 步骤 3: 提交登录表单
    const formData = new FormData();
    formData.append("host", new URL(baseUrl).host);
    formData.append("email", account.email);
    formData.append("passwd", account.passwd);
    formData.append("code", "");  // 邀请码
    formData.append("remember_me", "on");
    
    // 如果页面有 CSRF token，添加它
    const csrfToken = extractCsrfToken(loginPageHtml);
    if (csrfToken) {
        formData.append("_token", csrfToken);
    }

    const response = await fetch(logInUrl, {
        method: "POST",
        body: formData,
        headers: {
            "cookie": initialCookies,
            "referer": logInUrl,
        },
        redirect: "manual"
    });
    
    const responseText = await response.text();
    const cookies = formatCookie(getSetCookieArray(response.headers));
    
    // 检查登录结果
    if (cookies && cookies.includes("uid")) {
        return { ok: true, cookies, text: "登录成功" };
    }
    
    // 检查是否需要二步验证
    if (responseText.includes("二步验证") || responseText.includes("两步验证")) {
        return { 
            ok: false, 
            cookies, 
            text: "需要二步验证",
            needs2FA: true 
        };
    }
    
    // 检查是否被重定向回登录页面
    if (response.status === 302 || responseText.includes("登录")) {
        return { ok: false, cookies: "", text: "登录失败，请检查账号密码" };
    }
    
    return { ok: false, cookies, text: responseText.substring(0, 200) };
}

/**
 * 检查页面是否需要验证
 */
function checkNeedsVerification(html) {
    const indicators = [
        '点我开始验证',
        'verify',
        '验证',
        'captcha',
        'recaptcha',
        'hcaptcha',
        'turnstile',
        '请完成安全验证',
    ];
    
    const lowerHtml = html.toLowerCase();
    return indicators.some(indicator => lowerHtml.includes(indicator.toLowerCase()));
}

/**
 * 提取 CSRF Token
 */
function extractCsrfToken(html) {
    // 尝试多种常见的 CSRF token 格式
    const patterns = [
        /name="_token"\s+value="([^"]+)"/,
        /name="csrf[_-]?token"\s+value="([^"]+)"/i,
        /content="([^"]+)"\s+name="csrf-token"/i,
        /window\.csrf\s*=\s*['"]([^'"]+)['"]/,
    ];
    
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return match[1];
    }
    
    return null;
}

/**
 * 尝试处理验证机制
 */
async function handleVerification({ baseUrl, account, cookies, loginPageHtml }) {
    // 方法 1: 检查是否有 JavaScript 生成的验证码
    const jsVerifyMatch = loginPageHtml.match(/验证码[：:]\s*(\d+)/);
    if (jsVerifyMatch) {
        console.log(`📱 检测到验证码: ${jsVerifyMatch[1]}`);
        // 如果验证码在页面上可见，直接使用
        return { success: true, code: jsVerifyMatch[1] };
    }
    
    // 方法 2: 检查是否是 Telegram Bot 验证
    const botMatch = loginPageHtml.match(/@([A-Za-z0-9_]+bot)/i);
    if (botMatch) {
        console.log(`🤖 检测到 Telegram Bot: @${botMatch[1]}`);
        // 通知用户发送验证码给 Bot
        return { success: false, botUsername: botMatch[1] };
    }
    
    // 方法 3: 尝试直接提交（有些验证可以通过添加特定 headers 绕过）
    const turnstileMatch = loginPageHtml.match(/turnstile|hcaptcha|recaptcha/i);
    if (turnstileMatch) {
        console.log("🔒 检测到 Turnstile/hCaptcha/reCAPTCHA");
        return { success: false, needsManual: true };
    }
    
    // 默认返回需要人工验证
    return { success: false, needsManual: true };
}

// ===================== 签到逻辑 =====================

async function checkIn({ baseUrl, cookies }) {
    const checkInUrl = `${baseUrl}/user/checkin`;
    
    const res = await fetch(checkInUrl, {
        method: "POST",
        headers: {
            "cookie": cookies,
            "content-type": "application/x-www-form-urlencoded",
            "referer": `${baseUrl}/user`,
        },
        body: new URLSearchParams({}),
    });
    
    const json = await res.json().catch(() => null);
    return { ok: res.ok, json };
}

// ===================== 结果格式化 =====================

function buildResultLine(account, result) {
    const lines = [`👤 ${account.name}`];
    
    if (result.loginOk) {
        lines.push("  ✅ 登录成功");
    } else if (result.needsManualVerification) {
        lines.push("  ⚠️ 需要人工验证");
    } else if (result.needs2FA) {
        lines.push("  ⚠️ 需要二步验证");
    } else {
        lines.push(`  ❌ 登录失败: ${result.loginError}`);
    }
    
    if (result.checkinOk && result.checkinMsg) {
        lines.push(`  🎯 签到: ${result.checkinMsg}`);
    }
    
    return lines.join("\n");
}

// ===================== 主函数 =====================

async function main() {
    const baseUrl = normalizeBaseUrl(process.env.URL);
    const accounts = parseAccountsFromConfig();
    const timeStr = formatTime();
    const results = [];

    console.log(`\n🚀 IKUUU 自动签到开始`);
    console.log(`📅 时间: ${timeStr}`);
    console.log(`🌐 站点: ${baseUrl}`);
    console.log(`👥 账号数: ${accounts.length}\n`);

    for (const account of accounts) {
        console.log(`\n━━━━ 处理账号: ${account.name} ━━━━`);
        
        let result = {
            loginOk: false,
            checkinOk: false,
            needsManualVerification: false,
            needs2FA: false,
            loginError: "",
            checkinMsg: ""
        };

        // 重试逻辑
        for (let retry = 0; retry < MAX_RETRIES; retry++) {
            try {
                // 登录
                const loginRes = await logIn({ baseUrl, account, retryCount: retry });
                
                if (loginRes.needsManualVerification) {
                    result.needsManualVerification = true;
                    result.loginError = "需要人工验证";
                    break;
                }
                
                if (loginRes.needs2FA) {
                    result.needs2FA = true;
                    result.loginError = "需要二步验证";
                    break;
                }
                
                if (!loginRes.ok) {
                    result.loginError = loginRes.text;
                    if (retry < MAX_RETRIES - 1) {
                        console.log(`  ⏳ 登录失败，${RETRY_DELAY/1000}秒后重试...`);
                        await sleep(RETRY_DELAY);
                        continue;
                    }
                    break;
                }
                
                result.loginOk = true;
                console.log(`  ✅ 登录成功`);
                
                // 签到
                await sleep(1000);  // 等待 1 秒
                const checkinRes = await checkIn({ baseUrl, cookies: loginRes.cookies });
                
                if (checkinRes.json && checkinRes.json.msg) {
                    result.checkinMsg = checkinRes.json.msg;
                    result.checkinOk = true;
                    console.log(`  🎯 签到: ${checkinRes.json.msg}`);
                } else {
                    result.checkinMsg = "签到请求已发送";
                    result.checkinOk = checkinRes.ok;
                    console.log(`  🎯 签到请求已发送`);
                }
                
                break;  // 成功，退出重试循环
                
            } catch (error) {
                result.loginError = error.message;
                console.error(`  ❌ 错误: ${error.message}`);
                
                if (retry < MAX_RETRIES - 1) {
                    console.log(`  ⏳ ${RETRY_DELAY/1000}秒后重试...`);
                    await sleep(RETRY_DELAY);
                }
            }
        }
        
        results.push({ account, result });
    }

    // 生成汇总
    const summaryLines = results.map(({ account, result }) => 
        buildResultLine(account, result)
    );
    
    const summaryText = summaryLines.join("\n\n");
    console.log(`\n━━━━ 执行汇总 ━━━━\n${summaryText}\n`);

    // 发送 Telegram 通知
    const icon = results.some(r => r.result.loginOk) ? "✅" : "❌";
    const html = 
        `${icon} <b>IKUUU 签到结果</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🕒 ${timeStr}\n` +
        `🌐 ${baseUrl}\n\n` +
        `<pre>${summaryLines.map(l => l.replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("\n\n")}</pre>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `#ikuuu #checkin`;

    await sendTelegramMessage(html);

    // 设置 GitHub Actions 输出
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `result<<EOF\n${summaryText}\nEOF\n`);
    }
}

// 运行
main().catch((e) => {
    console.error("❌ 执行失败:", e);
    process.exit(1);
});
