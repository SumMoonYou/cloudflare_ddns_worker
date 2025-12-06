/**
 * Cloudflare DDNS Worker - IPv4 Only + ip-api 获取 IP 信息
 * 特性：
 * - 自动获取公网 IPv4
 * - 查询 IP 归属地（使用 ip-api）
 * - Cloudflare A 记录更新
 * - KV 保存上次 IP
 * - 夜间静默（0-8 点）
 * - Telegram 通知（美化模板 + 换行 + 运营商图标 + 更多地区 emoji）
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

        // 查询 IP 归属地
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

// ===== 查询 IP 归属地（使用 ip-api） =====
async function getIPInfo(ip) {
    try {
        const url = `http://ip-api.com/json/${ip}`;
        const data = await fetch(url).then(res => res.json());
        return {
            country: data.country || "无法获取地区信息",
            region: data.regionName || "",
            city: data.city || "",
            isp: data.isp || "无法获取运营商信息"
        };
    } catch {
        return null;
    }
}

// ===== 运营商图标 =====
function getISPEmoji(isp = "") {
    isp = isp.toLowerCase();
    if (isp.includes("电信")) return "📘 电信";
    if (isp.includes("联通")) return "🔴 联通";
    if (isp.includes("移动")) return "🟡 移动";
    if (isp.includes("铁通")) return "🟠 铁通";
    if (isp.includes("教育")) return "🎓 教育网";
    if (isp.includes("hong") || isp.includes("hk") || isp.includes("香港")) return "🇭🇰 香港";
    if (isp.includes("taiwan") || isp.includes("台湾")) return "🇹🇼 台湾";
    if (isp.includes("japan") || isp.includes("日本")) return "🇯🇵 日本";
    if (isp.includes("korea") || isp.includes("韩国")) return "🇰🇷 韩国";
    if (isp.includes("singapore") || isp.includes("新加坡")) return "🇸🇬 新加坡";
    if (isp.includes("united states") || isp.includes("美国")) return "🇺🇸 美国";
    if (isp.includes("germany") || isp.includes("德国")) return "🇩🇪 德国";
    if (isp.includes("france") || isp.includes("法国")) return "🇫🇷 法国";
    if (isp.includes("united kingdom") || isp.includes("英国")) return "🇬🇧 英国";
    if (isp.includes("india") || isp.includes("印度")) return "🇮🇳 印度";
    return "📡 其他";
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

// ===== TG 美化通知（进一步美化和优化 emoji） =====
async function sendTG(env, ipv4, ipinfo, type = "success") {
    if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;

    const time = getBeijingTime();
    let msg = "";

    if (type === "success") {
        // 如果未能获取到 IP 归属地或运营商，替换为提示语
        const ispEmoji = ipinfo && ipinfo.isp ? getISPEmoji(ipinfo.isp) : "📡";
        const location = ipinfo && (ipinfo.country || ipinfo.region || ipinfo.city) 
            ? `${ipinfo.country} ${ipinfo.region} ${ipinfo.city}` 
            : "🌍 无法获取地区信息";
        const isp = ipinfo && ipinfo.isp ? ipinfo.isp : "🚫 无法获取运营商信息";

        msg = `
<b>🟢 <u>Cloudflare DDNS 更新成功</u></b>
🌐 <b>域名：</b><code>${env.DOMAIN}</code>
📡 <b>IPv4：</b><code>${ipv4}</code>
${ispEmoji} <b>运营商：</b><code>${isp}</code>
📍 <b>位置：</b><code>${location}</code>
⏰ <b>更新时间：</b><code>${time}</code>

<i>🎉 更新完成，感谢使用！</i>
`;
    } else {
        msg = `
<b>🔴 <u>Cloudflare DDNS 更新失败</u></b>
🌐 <b>域名：</b><code>${env.DOMAIN}</code>
⚠️ <b>错误：</b><code>${ipv4}</code>
⏰ <b>时间：</b><code>${time}</code>

<i>🛠 请检查 Worker、API Key 或 DNS 配置。</i>
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

// ===== 夜间静默 0-8 点 =====
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
