/**
 * Cloudflare DDNS Worker
 * 功能：
 *  - IPv4 自动获取并更新 Cloudflare A 记录
 *  - 支持手动更新 (/update)
 *  - 支持立即发送 TG 通知 (/notify)
 *  - 每天 0 点自动发送每日 IP 变化报表
 *  - IP 变化历史完整记录（不折叠）
 *  - Telegram 消息美化，标注抖动次数
 */

export default {
  // HTTP 请求入口
  async fetch(req, env) {
    const url = new URL(req.url);

    // 手动更新（不发送 TG）
    if (url.pathname === "/update") {
      const result = await run(env, { manual: true });
      return new Response(result, {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // 手动触发 + 立即发送 TG（用于测试 TG 排版和效果）
    if (url.pathname === "/notify") {
      const result = await run(env, { manual: true, notify: true });
      return new Response(result, {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // 默认返回状态信息
    return new Response("Cloudflare DDNS Worker 正常运行", {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  },

  // 定时任务入口，每天或按 Worker Scheduler 触发
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  }
};

// ================= 主流程 =================
/**
 * run 主函数
 * @param {Object} env Worker 环境变量（KV、CF_API、TG_BOT_TOKEN 等）
 * @param {Object} opts 选项：
 *    - manual: 是否手动触发（true 不触发定时日报）
 *    - notify: 是否立即发送 TG 通知
 */
async function run(env, opts = {}) {
  const manual = opts.manual === true;
  const notify = opts.notify === true;
  const time = getBJTime();

  try {
    // 如果不是手动触发，则尝试发送每日报表
    if (!manual) {
      await trySendDailyReport(env);
    }

    // 获取 IPv4
    const ipRes = await getIPv4();
    if (!ipRes.ok) {
      // IP 获取失败处理
      if (!manual && !notify) await sendTG(env, ipRes.error, null, "ip_error");
      if (notify) {
        await sendTG(env, ipRes.error, {}, "daily", {
          history: JSON.parse(await env.KV.get("daily_history") || "[]")
        });
      }
      return manual || notify ? `失败：${ipRes.error}` : "IP 获取失败";
    }

    const ipv4 = ipRes.ip;
    const lastIP = await env.KV.get("last_ip") || "";

    // IP 未变化
    if (ipv4 === lastIP) {
      if (notify) {
        // 手动/notify 模式仍然发送 TG（用于测试排版）
        await sendTG(env, ipv4, {}, "daily", {
          history: JSON.parse(await env.KV.get("daily_history") || "[]")
        });
      }
      return manual || notify
        ? `DDNS 通知测试\nIP 未变化\n${ipv4}\n${time}`
        : "IP 未变化";
    }

    // IP 变化，更新 Cloudflare A 记录
    const update = await updateDNS(env, ipv4);
    if (!update.ok) {
      // 更新失败处理
      if (!manual && !notify) await sendTG(env, update.error, null, "error");
      if (notify) {
        await sendTG(env, update.error, {}, "daily", {
          history: JSON.parse(await env.KV.get("daily_history") || "[]")
        });
      }
      return manual || notify ? `DNS 更新失败\n${update.error}` : "DNS 更新失败";
    }

    // 记录 IP 历史
    await env.KV.put("last_ip", ipv4);
    await recordDaily(env, ipv4);

    // notify 模式下发送 TG
    if (notify) {
      const history = JSON.parse(await env.KV.get("daily_history") || "[]");
      await sendTG(env, ipv4, {}, "daily", { history });
    }

    return manual
      ? `DDNS 通知测试完成\n${env.DOMAIN}\n${ipv4}\n${time}`
      : "更新完成";

  } catch (e) {
    // 捕获异常并发送 TG
    if (!manual && !notify) await sendTG(env, e.message, null, "error");
    if (notify) {
      await sendTG(env, e.message, {}, "daily", {
        history: JSON.parse(await env.KV.get("daily_history") || "[]")
      });
    }
    return manual || notify ? `异常\n${e.message}` : "异常";
  }
}

// ================= IPv4 获取 =================
/**
 * getIPv4
 * 从第三方页面获取公网 IPv4，随机选择一个合法 IP
 */
async function getIPv4() {
  try {
    const res = await fetch("https://ip.164746.xyz/ipTop.html");
    if (!res.ok) return { ok: false, error: "请求失败" };

    const html = await res.text();
    const ips = html.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g);
    if (!ips) return { ok: false, error: "未解析到 IPv4" };

    var valid = [];
    for (var i = 0; i < ips.length; i++) {
      var p = ips[i].split(".");
      if (p.length !== 4) continue;
      if (p[0] <= 255 && p[1] <= 255 && p[2] <= 255 && p[3] <= 255)
        valid.push(ips[i]);
    }

    if (!valid.length) return { ok: false, error: "无合法 IPv4" };
    return { ok: true, ip: valid[Math.floor(Math.random() * valid.length)] };

  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ================= DNS 更新 =================
/**
 * updateDNS
 * @param {Object} env Worker 环境
 * @param {string} ip 新 IP
 * @returns {Object} 更新结果
 */
async function updateDNS(env, ip) {
  try {
    const list = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/dns_records?type=A&name=${env.DOMAIN}`,
      { headers: { Authorization: `Bearer ${env.CF_API}` } }
    ).then(r => r.json());

    const record = list.result && list.result[0];
    if (!record) return { ok: false, error: "未找到 A 记录" };

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/dns_records/${record.id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.CF_API}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "A",
          name: env.DOMAIN,
          content: ip,
          ttl: 120
        })
      }
    ).then(r => r.json());

    return res.success
      ? { ok: true }
      : { ok: false, error: JSON.stringify(res.errors) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ================= 日报记录 =================
/**
 * recordDaily
 * @param {Object} env Worker KV
 * @param {string} ip 当前 IP
 * 保存每日 IP 历史
 */
async function recordDaily(env, ip) {
  const today = getBJDate();
  if ((await env.KV.get("daily_date")) !== today) {
    await env.KV.put("daily_date", today);
    await env.KV.put("daily_history", "[]");
  }

  const history = JSON.parse(await env.KV.get("daily_history") || "[]");
  history.push({ ip, time: getBJTime() });
  await env.KV.put("daily_history", JSON.stringify(history));
}

// ================= 日报发送 =================
/**
 * trySendDailyReport
 * 每天 0 点发送日报
 */
async function trySendDailyReport(env) {
  if (getBJHour() !== 0) return;

  const today = getBJDate();
  if ((await env.KV.get("daily_sent")) === today) return;

  const history = JSON.parse(await env.KV.get("daily_history") || "[]");
  const lastIP = await env.KV.get("last_ip") || "未知";

  await sendTG(env, lastIP, {}, "daily", { history });
  await env.KV.put("daily_sent", today);
}

// ================= Telegram =================
/**
 * sendTG
 * @param {Object} env Worker 环境
 * @param {string} info 当前 IP 或错误信息
 * @param {Object} ipinfo 可选 IP 运营商信息
 * @param {string} type 类型：daily / error / ip_error
 * @param {Object} data 附加数据 { history }
 */
async function sendTG(env, info, ipinfo, type, data = {}) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;

  const time = getBJTime();
  const history = formatHistory(data.history || []);

  let msg = `
<b>📅 Cloudflare DDNS 每日提醒</b>

🌐 <b>域名：</b><code>${env.DOMAIN}</code>

${history.summary}

${history.body}

📍 <b>当前 IP：</b><code>${info}</code>
🕒 <b>时间：</b><i>${time}</i>

✅ <b>今日 DDNS 状态正常</b>
`;

  if (type === "ip_error") {
    msg = `<b>🚨 DDNS IP 获取失败</b>\n${env.DOMAIN}\n${info}\n${time}`;
  }

  if (type === "error") {
    msg = `<b>❌ DDNS 错误</b>\n${env.DOMAIN}\n${info}\n${time}`;
  }

  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TG_CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    })
  });
}

// ================= 历史格式化（无折叠） =================
function formatHistory(list) {
  if (!list.length) {
    return {
      summary: "📊 <b>今日概览</b>\n• IP 变更次数：0",
      body: "<i>无 IP 变化</i>"
    };
  }

  const map = new Map();
  for (const v of list) {
    if (!map.has(v.ip)) map.set(v.ip, { ip: v.ip, times: [v.time], count: 1 });
    else {
      const m = map.get(v.ip);
      m.times.push(v.time);
      m.count++;
    }
  }

  const merged = Array.from(map.values());

  let max = merged[0];
  for (const v of merged) if (v.count > max.count) max = v;

  const display = merged; // 全部显示，无折叠

  const body = display.map((v, i) => {
    const times = v.times.map(t => t.slice(11, 16)).join(" / ");
    let warn = "";
    if (v.count >= 3) warn = ` 🔥 <b>${v.count} 次</b>`;
    else if (v.count >= 2) warn = ` ⚠️ <b>${v.count} 次</b>`;
    return `${i + 1}. <code>${v.ip}</code>   🕒 ${times}${warn}`;
  }).join("\n");

  return {
    summary:
`📊 <b>今日概览</b>
• IP 变更次数：<b>${merged.length}</b>
• 最频繁IP：<code>${max.ip}</code>（${max.count} 次）
• 最大更换：${max.count >= 3 ? "🔥" : "⚠️"} <b>${max.count} 次</b>`,

    body:
`📜 <b>IP 变化历史</b>
──────────────────────
${body}
──────────────────────`
  };
}

// ================= 北京时间 =================
const BJ = 8 * 3600 * 1000; // 东八区偏移
const nowBJ = () => new Date(Date.now() + BJ);
const getBJTime = () => nowBJ().toISOString().replace("T", " ").split(".")[0];
const getBJDate = () => nowBJ().toISOString().slice(0, 10);
const getBJHour = () => nowBJ().getUTCHours();
