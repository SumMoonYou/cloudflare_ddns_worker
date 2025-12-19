/**
 * Cloudflare DDNS Worker
 * - IPv4 Only
 * - 自动更新 Cloudflare A 记录
 * - 每天 0 点发送一次日报
 * - IP 变化历史：
 *     • 同 IP 多次出现显示所有时间点
 *     • 标注 ⚠️ 次数
 */

export default {
  async fetch(req, env) {
    return new Response(await run(env), {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  }
};

// ================= 主流程 =================
async function run(env) {
  try {
    // 每天 0 点尝试发送日报
    await trySendDailyReport(env);

    // 获取 IPv4
    const ipRes = await getIPv4();
    if (!ipRes.ok) {
      await sendTG(env, ipRes.error, null, "ip_error");
      return "IP 获取失败";
    }

    const ipv4 = ipRes.ip;
    const lastIP = await env.KV.get("last_ip") || "";

    // IP 未变化
    if (ipv4 === lastIP) return "IP 未变化";

    // 更新 DNS
    const update = await updateDNS(env, ipv4);
    if (!update.ok) {
      await sendTG(env, update.error, null, "error");
      return "DNS 更新失败";
    }

    // 记录 IP 历史
    await env.KV.put("last_ip", ipv4);
    await recordDaily(env, ipv4);

    return "更新完成";
  } catch (e) {
    await sendTG(env, e.message, null, "error");
    return "异常";
  }
}

// ================= IPv4 获取 =================
async function getIPv4() {
  try {
    const res = await fetch("https://ip.164746.xyz/ipTop.html");
    const html = await res.text();
    const match = html.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    if (!match) return { ok: false, error: "未解析到 IPv4" };
    return { ok: true, ip: match[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ================= DNS 更新 =================
async function updateDNS(env, ip) {
  try {
    const list = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/dns_records?type=A&name=${env.DOMAIN}`,
      { headers: { Authorization: `Bearer ${env.CF_API}` } }
    ).then(r => r.json());

    const record = list.result?.[0];
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

// ================= IP 信息 =================
async function getIPInfo(ip) {
  try {
    const r = await fetch(`https://api.vore.top/api/IPdata?ip=${ip}`);
    const d = await r.json();
    if (d.code === 200) {
      return {
        isp: d.ipdata.isp,
        region: `${d.ipdata.info1} ${d.ipdata.info2} ${d.ipdata.info3}`
      };
    }
  } catch {}
  return {};
}

// ================= 日报记录 =================
async function recordDaily(env, ip) {
  const today = getBJDate();
  const dateKey = "daily_date";

  // 新的一天重置
  if ((await env.KV.get(dateKey)) !== today) {
    await env.KV.put(dateKey, today);
    await env.KV.put("daily_history", "[]");
  }

  const history = JSON.parse(await env.KV.get("daily_history") || "[]");
  history.push({ ip, time: getBJTime() });
  await env.KV.put("daily_history", JSON.stringify(history));
}

// ================= 日报发送 =================
async function trySendDailyReport(env) {
  if (getBJHour() !== 0) return;

  const today = getBJDate();
  if ((await env.KV.get("daily_sent")) === today) return;

  const history = JSON.parse(await env.KV.get("daily_history") || "[]");
  const lastIP = await env.KV.get("last_ip") || "未知";
  const ipinfo = lastIP !== "未知" ? await getIPInfo(lastIP) : {};

  await sendTG(env, lastIP, ipinfo, "daily", { history });
  await env.KV.put("daily_sent", today);
}

// ================= Telegram =================
async function sendTG(env, info, ipinfo, type, data = {}) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;

  const time = getBJTime();
  const historyText = formatHistory(data.history || []);

  let msg = `
<b>📅 Cloudflare DDNS 每日提醒</b>

<b>🌐 域名：</b><b>${env.DOMAIN}</b>

<b>📜 IP 变化历史：</b>
${historyText}

<b>📍 当前 IP：</b><code>${info}</code>
<b>📡 运营商：</b><i>${ipinfo?.isp || "未知"}</i>
<b>🕒 时间：</b><i>${time}</i>

✅ 今日 DDNS 状态正常
`;

  if (type === "ip_error") {
    msg = `
<b>🚨 DDNS IP 获取失败</b>

<b>${env.DOMAIN}</b>
错误信息：<i>${info}</i>
<b>时间：</b><i>${time}</i>
`;
  }

  if (type === "error") {
    msg = `
<b>❌ Cloudflare DDNS 错误</b>

<b>${env.DOMAIN}</b>
错误信息：<i>${info}</i>
<b>时间：</b><i>${time}</i>
`;
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

// ================= IP 历史格式化（多次显示时间点 + ⚠️ 次数） =================
function formatHistory(list = []) {
  if (!list.length) return "<i>无 IP 变化</i>";

  const map = new Map();

  // 合并同 IP，收集所有时间点
  for (const { ip, time } of list) {
    if (!map.has(ip)) {
      map.set(ip, { ip, times: [time], count: 1 });
    } else {
      const v = map.get(ip);
      v.times.push(time);
      v.count++;
    }
  }

  const merged = Array.from(map.values());
  const totalIPs = merged.length;
  const nums = [
    // 1-10
    "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
    // 11-20
    "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳",
    // 21-30
    "㉑", "㉒", "㉓", "㉔", "㉕", "㉖", "㉗", "㉘", "㉙", "㉚",
    // 31-40
    "㉛", "㉜", "㉝", "㉞", "㉟", "㊱", "㊲", "㊳", "㊴", "㊵",
    // 41-50
    "㊶", "㊷", "㊸", "㊹", "㊺", "㊻", "㊼", "㊽", "㊾", "㊿"
  ];

  const body = merged.map((v, i) => {
    // 显示 HH:mm
    const timePoints = v.times.map(t => t.slice(11,16)).join(" / ");
    const countMark = v.count > 1 ? `   ⚠️ ${v.count} 次` : "";

    return `${nums[i] || `${i + 1}.`} <code>${v.ip}</code>
   🕒 <i>${timePoints}</i>${countMark}`;
  }).join("\n\n");

  return `（今日共更换 ${totalIPs} 个 IP）\n\n${body}`;
}

// ================= 北京时间工具 =================
const BJ = 8 * 3600 * 1000;
const nowBJ = () => new Date(Date.now() + BJ);
const getBJTime = () => nowBJ().toISOString().replace("T", " ").split(".")[0];
const getBJDate = () => nowBJ().toISOString().slice(0, 10);
const getBJHour = () => nowBJ().getUTCHours();
