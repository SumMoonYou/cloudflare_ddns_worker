/**
 * Cloudflare DDNS Worker - IPv4 Only
 * IP 来源： https://ip.164746.xyz/ipTop.html
 * 功能：
 *  - 自动获取公网 IPv4
 *  - 比对 Cloudflare A 记录并更新
 *  - Telegram 成功/失败通知（美化模板）
 *  - 夜间静默（0-8点）
 *  - KV 保存上次 IP
 *  - 支持 Cron Trigger 每小时执行一次
 */

export default {
    async fetch(request, env) {
        return new Response(await runDDNS(env), {
            headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(runDDNS(env));
    }
};

// ======= 主执行函数 =======
async function runDDNS(env) {
    try {
        const logs = [];
        const domain = env.DOMAIN;
        const zoneId = env.ZONE_ID;

        logs.push(`DDNS 执行开始`);
        logs.push(`域名: ${domain}`);

        // 获取公网 IPv4
        const ipv4 = await getIPv4FromSource();
        logs.push(`当前 IPv4: ${ipv4 || "获取失败"}`);
        if (!ipv4) throw new Error("无法获取公网 IPv4");

        // 获取上次 IP
        const last = await env.KV.get("ddns_last_ip") || "";

        if (last === ipv4) {
            logs.push(`IP 未变化，无需更新`);
            return logs.join("\n");
        }

        // 更新 DNS A 记录
        const result = await updateARecord(env, zoneId, domain, ipv4);

        if (result.ok) {
            logs.push(`✔ 成功更新 A 记录 → ${ipv4}`);
            // 保存新 IP
            await env.KV.put("ddns_last_ip", ipv4);

            // 夜间静默 0-8 点
            if (!isNightSilent()) {
                await sendTG(env, ipv4, "success");
                logs.push("TG 通知已发送");
            }
        } else {
            logs.push(`❌ 更新失败：${result.error}`);
            await sendTG(env, result.error, "error");
        }

        logs.push("任务结束");
        return logs.join("\n");

    } catch (e) {
        await sendTG(env, e.message, "error");
        return `错误：${e.stack}`;
    }
}

// ======= 获取 IPv4 =======
async function getIPv4FromSource() {
    try {
        const url = "https://ip.164746.xyz/ipTop.html";
        const html = await fetch(url, { timeout: 5000 }).then(r => r.text());
        const match = html.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
        return match ? match[0] : null;
    } catch {
        return null;
    }
}

// ======= 更新 A 记录 =======
async function updateARecord(env, zoneId, domain, ipv4) {
    try {
        const listURL = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${domain}`;
        let res = await fetch(listURL, {
            headers: {
                "Authorization": `Bearer ${env.CF_API}`,
                "Content-Type": "application/json"
            }
        });
        let data = await res.json();
        const record = data.result[0];
        if (!record) return { ok: false, error: "未找到 A 记录" };

        const updateURL = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.id}`;
        res = await fetch(updateURL, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${env.CF_API}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ type: "A", name: domain, content: ipv4, ttl: 120 })
        });

        data = await res.json();
        return data.success ? { ok: true } : { ok: false, error: JSON.stringify(data.errors) };

    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ======= Telegram 通知（美化模板） =======
async function sendTG(env, text, type = "success") {
    if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;

    let msg = "";
    const time = getBeijingTime();

    if (type === "success") {
        msg = `
<b>✅ Cloudflare DDNS 更新成功</b>

<b>🌐 域名：</b> <code>${env.DOMAIN}</code>
<b>📡 IPv4：</b> <code>${text}</code>
<b>⏰ 更新时间：</b> <code>${time}</code>

<i>🎉 更新完成！感谢使用~</i>
`;
    } else if (type === "error") {
        msg = `
<b>❌ Cloudflare DDNS 更新失败</b>

<b>🌐 域名：</b> <code>${env.DOMAIN}</code>
<b>⚠️ 错误信息：</b> <code>${text}</code>
<b>⏰ 时间：</b> <code>${time}</code>
`;
    } else {
        msg = text;
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

// ======= 夜间静默 =======
function isNightSilent() {
    const hour = Number(getBeijingHour());
    return hour >= 0 && hour < 8;
}

function getBeijingTime() {
    return new Date(Date.now() + 8 * 3600 * 1000)
        .toISOString()
        .replace("T", " ")
        .split(".")[0];
}

function getBeijingHour() {
    return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
}
