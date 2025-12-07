/**
 * Cloudflare DDNS Worker - IPv4 Only + IP 运营商信息
 * 功能：
 * - 自动获取公网 IPv4
 * - 查询 IP 归属地及运营商（多种来源）
 * - 更新 Cloudflare A 记录
 * - KV 保存上次 IP
 * - 夜间静默（0-8点）
 * - Telegram 通知（高大上模板，带 emoji）
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

// ===== 主执行函数 =====
async function runDDNS(env) {
    try {
        const domain = env.DOMAIN;
        const zoneId = env.ZONE_ID;

        // 获取公网 IPv4
        const ipv4 = await getIPv4FromSource();
        if (!ipv4) throw new Error("无法获取公网 IPv4");

        // 查询 IP 归属地及运营商
        const ipinfo = await getIPInfo(ipv4);

        // 获取上次 IP
        const last = await env.KV.get("ddns_last_ip") || "";
        if (last === ipv4) return "IP 未变化，无需更新";

        // 更新 Cloudflare A 记录
        const result = await updateARecord(env, zoneId, domain, ipv4);

        if (result.ok) {
            await env.KV.put("ddns_last_ip", ipv4);
            if (!isNightSilent()) await sendTG(env, ipv4, ipinfo, "success");
        } else {
            await sendTG(env, result.error, null, "error");
        }

        return "任务完成";
    } catch (e) {
        await sendTG(env, e.message, null, "error");
        return `错误：${e.stack}`;
    }
}

// ===== 获取公网 IPv4 =====
async function getIPv4FromSource() {
    try {
        const url = "https://ip.164746.xyz/ipTop.html";
        const html = await fetch(url).then(r => r.text());
        const match = html.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
        return match ? match[0] : null;
    } catch {
        return null;
    }
}

// ===== 查询 IP 归属地及运营商 =====
async function getIPInfo(ip) {
    try {
        // 尝试使用 vore.top 的 API
        const urlVore = `https://api.vore.top/api/IPdata?ip=${ip}`;
        const responseVore = await fetch(urlVore);
        const dataVore = await responseVore.json();

        // 如果解析成功，返回格式化的数据
        if (dataVore && dataVore.code === 200) {
            return {
                ip: dataVore.ipinfo.text,
                country: dataVore.ipdata.info1,
                region: dataVore.ipdata.info2,
                city: dataVore.ipdata.info3,
                isp: dataVore.ipdata.isp,
                cnip: dataVore.ipinfo.cnip,
                error: null
            };
        }
    } catch (error) {
        console.error("Vore API 解析失败，使用备选接口", error);
    }

    // 如果 vore.top 解析失败，使用 ip-api.com 解析
    try {
        const urlIpApi = `http://ip-api.com/json/${ip}?lang=zh-CN`;
        const responseIpApi = await fetch(urlIpApi);
        const dataIpApi = await responseIpApi.json();
        
        // 如果 ip-api.com 解析成功
        if (dataIpApi && dataIpApi.status === "success") {
            return {
                ip: dataIpApi.query,
                country: dataIpApi.country,
                region: dataIpApi.regionName,
                city: dataIpApi.city,
                isp: dataIpApi.isp,
                cnip: dataIpApi.country === "中国", // 根据 IP 所在国家判断是否为中国 IP
                error: null
            };
        } else {
            throw new Error("ip-api 解析失败");
        }
    } catch (error) {
        return {
            ip: ip,
            country: "未知",
            region: "未知",
            city: "未知",
            isp: "未知",
            cnip: false,
            error: error.message || "无法解析 IP"
        };
    }
}

// ===== 更新 Cloudflare A 记录 =====
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
            body: JSON.stringify({
                type: "A",
                name: domain,
                content: ipv4,
                ttl: 120
            })
        });

        data = await res.json();
        return data.success ? { ok: true } : { ok: false, error: JSON.stringify(data.errors) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ===== Telegram 通知（带 emoji，高大上模板） =====
async function sendTG(env, ipv4, ipinfo, type = "success") {
    if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;

    const time = getBeijingTime();
    let msg = "";

    if (type === "success") {
        const isp = ipinfo?.isp || "未知";
        const country = ipinfo?.country || "未知";
        const region = ipinfo?.region || "未知";
        const city = ipinfo?.city || "未知";

        msg = `
<b>✅ Cloudflare DDNS 更新成功</b>

<b><code>${env.DOMAIN}</code></b>

<b>📡 运营商：</b><i>${isp}</i>
<b>🔗 地址：</b><i>${ipv4}</i>
<b>🗺️ 位置：</b><i>${country} ${region} ${city}</i>
<b>🕒 时间：</b><i>${time}</i>

🎉 更新完成，感谢使用！
`;
    } else {
        msg = `
<b>❌ Cloudflare DDNS 更新失败</b>

<b>🌐 域名：</b><i>${env.DOMAIN}</i>
<b>⚠️ 信息：</b><i>${ipv4}</i>
<b>🕒 时间：</b><i>${time}</i>

🛠️ 请检查 Worker 配置、API Key 或 DNS 设置。
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

// ===== 夜间静默 0-8点 =====
function isNightSilent() {
    const hour = Number(getBeijingHour());
    return hour >= 0 && hour < 8;
}

// ===== 工具：北京时间 =====
function getBeijingTime() {
    return new Date(Date.now() + 8 * 3600 * 1000)
        .toISOString()
        .replace("T", " ")
        .split(".")[0];
}

function getBeijingHour() {
    return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
}
