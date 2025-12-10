# 🌐 Cloudflare DDNS Worker (IPv4 Only + ISP Info + Telegram Notify)

一款轻量、稳定、优雅的 **Cloudflare DDNS 动态域名解析工具**，基于 **Cloudflare Workers** 实现。

支持自动更新 IPv4、查询 IP 归属地与运营商信息、KV 缓存、夜间静默，以及高质量 Telegram Push 通知。

------

## ✨ 功能特性

- 🚀 **自动获取公网 IPv4**
- 🛰️ **IP 地址归属地与运营商解析**
  - 支持 **vore.top API**
  - 支持 **ip-api.com**（备用）
- 🔄 **自动更新 Cloudflare DNS A 记录**
- 💾 **KV 存储上次 IP（无变化不更新）**
- 🌙 **夜间静默（北京时间 0 - 8 点）**
- 📢 **Telegram 高质量消息通知（Emoji + HTML 渲染）**
- 🛡️ **异常自动上报（失败会推送 TG）**

------

## 🗂️目录

- 🌐 Cloudflare DDNS Worker (IPv4 Only + ISP Info + Telegram Notify)
- ✨ 功能特性
- 📦 部署方式
  - \1. 导入 Worker 脚本
  - \2. 创建 KV 命名空间
  - \3. 绑定环境变量
- ⚙️ 必要环境变量
- 🛈 Telegram 通知示例
- 📄 完整 Worker 脚本
- 📝 License

------

## 📦 部署方式

### **1. 导入 Worker 脚本**

在 Cloudflare Dashboard 中：

`Workers and Pages` → `Create Worker` → 全部替换为你的脚本。

------

### **2. 创建 KV 命名空间**

Cloudflare Dashboard → `Workers` → `KV` → `Create Namespace`

名称建议：`DDNS_KV`

------

### **3. 绑定环境变量**

进入 Worker → `Settings` → `Variables`：

| 名称           | 类型         | 说明                                  |
| -------------- | ------------ | ------------------------------------- |
| `DOMAIN`       | Text         | 你的域名，如：`home.example.com`      |
| `ZONE_ID`      | Text         | Cloudflare Zone ID                    |
| `CF_API`       | Text         | Cloudflare API Token（Zone.DNS 权限） |
| `TG_BOT_TOKEN` | Text         | Telegram Bot Token                    |
| `TG_CHAT_ID`   | Text         | Telegram Chat ID                      |
| `KV`           | KV Namespace | 绑定你创建的 KV 命名空间              |

------

## ⚙️ 必要环境变量

你的 Worker 需要如下环境变量：

| 变量名         | 示例               | 描述               |
| -------------- | ------------------ | ------------------ |
| `DOMAIN`       | `ddns.example.com` | 要更新的 DNS 记录  |
| `ZONE_ID`      | `xxxxxxxxxxxx`     | Cloudflare 区域 ID |
| `CF_API`       | `cf_xxx`           | Cloudflare Token   |
| `TG_BOT_TOKEN` | `123456:ABC-DEF`   | Telegram Bot       |
| `TG_CHAT_ID`   | `123456789`        | Telegram 推送对象  |
| `KV`           | KV Namespace       | 存储上次更新的 IP  |

------

## 🛈 Telegram 通知示例

### ✅ 更新成功消息

```
Cloudflare DDNS 更新成功

ddns.example.com

运营商：中国电信
IP：1.2.3.4
位置：中国 四川 成都
时间：2025-01-01 12:00:00
```

### ❌ 更新失败消息

```
Cloudflare DDNS 更新失败

域名：ddns.example.com
错误：未找到 A 记录
时间：2025-01-01 12:00:00
```

------

## 📄 完整 Worker 脚本

你的完整脚本可以放在仓库中的 `worker.js`。
 （此处可直接粘贴你发送的代码。）

------

## 📝 License

本项目采用 MIT License，欢迎自由使用与二次开发。
