export default {
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

    return new Response("Cloudflare DDNS Worker 正常运行", {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  }
};

// ================= 主流程 =================
async function run(env, opts = {}) {
  const manual = opts.manual === true;
  const notify = opts.notify === true;
  const time = getBJTime();

  try {
    if (!manual) {
      await trySendDailyReport(env);
    }

    const ipRes = await getIPv4();
    if (!ipRes.ok) {
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

    if (ipv4 === lastIP) {
      if (notify) {
        await sendTG(env, ipv4, {}, "daily", {
          history: JSON.parse(await env.KV.get("daily_history") || "[]")
        });
      }
      return manual || notify
        ? `DDNS 通知测试\nIP 未变化\n${ipv4}\n${time}`
        : "IP 未变化";
    }

    const update = await updateDNS(env, ipv4);
    if (!update.ok) {
      if (!manual && !notify) await sendTG(env, update.error, null, "error");
      if (notify) {
        await sendTG(env, update.error, {}, "daily", {
          history: JSON.parse(await env.KV.get("daily_history") || "[]")
        });
      }
      return manual || notify ? `DNS 更新失败\n${update.error}` : "DNS 更新失败";
    }

    await env.KV.put("last_ip", ipv4);
    await recordDaily(env, ipv4);

    if (notify) {
      const history = JSON.parse(await env.KV.get("daily_history") || "[]");
      await sendTG(env, ipv4, {}, "daily", { history });
    }

    return manual
      ? `DDNS 通知测试完成\n${env.DOMAIN}\n${ipv4}\n${time}`
      : "更新完成";

  } catch (e) {
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
async function getIPv4() {
  try {
    const res = await fetch("https://ip.164746.xyz/ipTop.html");
    if (!res.ok) return { ok: false, error: "请求失败" };

    const html = await res.text();
    const ips = html.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g);
    if (!ips) return { ok: false, error: "未解析到 IPv4" };

    var valid = [];

    for (var i = 0; i < ips.length; i++) {
      var parts = ips[i].split(".");
      if (parts.length !== 4) continue;
    
      var ok = true;
      for (var j = 0; j < 4; j++) {
        if (!/^\d+$/.test(parts[j])) {
          ok = false;
          break;
        }
        var num = Number(parts[j]);
        if (num < 0 || num > 255) {
          ok = false;
          break;
        }
      }
      if (ok) valid.push(ips[i]);
    }
    if (!valid.length) return { ok: false, error: "无合法 IPv4" };
    return { ok: true, ip: valid[Math.floor(Math.random() * valid.length)] };
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
async function sendTG(env, info, ipinfo, type, data = {}) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;

  const history = data.history || [];
  
  // 1. 动态序号生成器
  const getEmoji = (i) => (i + 1).toString().split('').map(d => d + '\uFE0F\u20E3').join('');

  let msg = `📢 <b>CloudFlare 优选IP更新通知</b>\n\n`;
  msg += `🌐 域名：<code>${env.DOMAIN}</code>\n`;

  if (history.length) {
    msg += `⬇️⬇️⬇️ 变更记录 ⬇️⬇️⬇️\n`;

    const total = history.length;
    let displayList = [];

    if (total <= 24) {
      // 数量少于 24 个，全部显示
      displayList = history.map((v, i) => ({ ...v, idx: i }));
    } else {
      // 数量多时：保留前 5 个 和 最后 5 个，中间用省略号
      const head = history.slice(0, 12).map((v, i) => ({ ...v, idx: i }));
      const tail = history.slice(-5).map((v, i) => ({ ...v, idx: total - 5 + i }));
      
      displayList = [...head, { isSeparator: true }, ...tail];
    }

    msg += displayList.map(item => {
      if (item.isSeparator) return `<code>      ...... (中间省略 ${total - 10} 个)</code>`;
      const ipLink = `https://ip.gs/${item.ip}`;
      return `${getEmoji(item.idx)}<a href=" ">${item.ip}</a >，🕐${item.time.slice(11, 16)}`;
    }).join("\n");

    msg += `\n\n✅ 共计：<b>${total}</b> 个优选节点`;
  } else if (type === "error" || type === "ip_error") {
    msg += `\n⚠️ 异常：${info || "IP 获取失败"}`;
  } else {
    msg += `\n✅ 状态：未发生变更`;
  }

  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true 
      }),
    });
  } catch (e) {
    console.error('TG 推送失败');
  }
}
// ================= 北京时间 =================
const BJ = 8 * 3600 * 1000;
const nowBJ = () => new Date(Date.now() + BJ);
const getBJTime = () => nowBJ().toISOString().replace("T", " ").split(".")[0];
const getBJDate = () => nowBJ().toISOString().slice(0, 10);
const getBJHour = () => nowBJ().getUTCHours();
