# 🌐 Cloudflare DDNS Worker (IPv4 Only)

一个基于 **Cloudflare Worker** 的 DDNS 自动更新脚本，只更新 **IPv4**，无需服务器，支持 Telegram 通知和夜间静默。

---

## 功能

- 自动获取公网 IPv4（通过 `https://ip.164746.xyz/ipTop.html`）  
- 比对 Cloudflare A 记录并自动更新  
- 支持 Telegram 成功/失败通知  
- 美化 HTML 模板，信息清晰可读  
- 夜间静默 0-8 点，避免打扰  
- KV 存储上次 IP，减少不必要的 API 调用  
- 支持 Cron Trigger 每小时自动执行  
- 单文件 Worker，易于部署，无需 VPS 或 crontab  

---

## 配置

在 Cloudflare Worker Dashboard 或使用 Wrangler Secret 配置以下变量：

| 变量名         | 示例               | 说明                                 |
| -------------- | ------------------ | ------------------------------------ |
| `DOMAIN`       | `ddns.example.com` | 你要更新的 A 记录域名                |
| `ZONE_ID`      | `xxxxxxxxxxxx`     | Cloudflare Zone ID                   |
| `CF_API`       | `xxxxxxx`          | Cloudflare API Token（DNS 编辑权限） |
| `TG_BOT_TOKEN` | `123456:ABCDEF`    | 可选，Telegram Bot Token             |
| `TG_CHAT_ID`   | `123456789`        | 可选，Telegram Chat ID               |

### KV 配置

- 创建命名空间：`DDNS_KV`  
- 绑定到 Worker，变量名必须为：`KV`  
- 用于保存上次 IP，避免重复更新  

### Cron Trigger

- 在 Worker → **Triggers → Add Cron Trigger**  
- 设置为 **每小时执行一次**：
