# Cloudflare Email Gateway (中文文档)

[English](./README.md) | [中文](#cloudflare-email-gateway-中文文档)

---

一个运行在 Cloudflare Workers 边缘节点的轻量级邮件发信网关。基于 **Resend API** 构建，支持通过自定义域名安全、快速地对外发送交易或通知邮件。写信页面会在 Worker 内校验 Cloudflare Access JWT，没有通过 Access 登录时不会渲染页面。

## ✨ 项目特性
- **超低延迟**：部署在 Cloudflare 全球边缘节点，响应极快。
- **安全鉴权**：写信页面和 `/api/send` 强制校验 Cloudflare Access JWT；旧版 JSON API 仍支持 Client Token。
- **配置分离**：完全通过环境变量控制发信人身份，代码无任何硬编码，方便开源复用。
- **写信页面**：访问绑定到 Worker 的自定义域名即可打开类似邮件系统的发信界面，并交给 Cloudflare Access 保护。
- **全栈通用**：支持多个收件人、Cc、Bcc、Reply-To、富文本、纯文本 fallback 和附件。

---

## ⚙️ ☁️ 云端环境变量配置

代码成功部署到 Cloudflare Workers 后，需要在后台的 **Settings -> Variables（设置 -> 变量）** 中配置以下变量：

| 变量名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `RESEND_API_KEY` | **Secret (加密)** | 填写从 Resend 后台申请的 API 密钥。 |
| `CLIENT_TOKEN` | **Secret (加密)** | 可选。旧版 `POST /` API 使用的 Bearer 鉴权令牌；Access 保护的写信页面不需要填写它。 |
| `FROM_EMAIL` | **Variable (文本)** | 你的发信人展示文本与真实邮箱（例如：`通知机器人 <i@mydomain.com>`）。 |
| `ACCESS_TEAM_DOMAIN` | **Variable (文本)** | 你的 Access team 域名，例如 `https://<team>.cloudflareaccess.com`。 |
| `ACCESS_AUD` | **Variable (文本)** | Zero Trust Access 应用的 **Application Audience (AUD) Tag**。 |

---

## 📨 写信页面

部署完成后，在浏览器中打开绑定到 Worker 的自定义域名：

```text
https://email.example.com/
```

这里会显示一个类似邮件系统的写信页面，用于手动输入邮箱并发送邮件。当前页面支持：

- 多个收件人，输入后会以标签形式展示。
- Cc、Bcc，以及可选 Reply-To。
- 主题和富文本正文编辑。
- 常用格式操作：标题、加粗、斜体、下划线、删除线、列表、缩进、对齐、文字颜色、背景高亮、链接、撤销、重做、清除格式。
- 自动生成纯文本 fallback，提升不同邮件客户端的兼容性。
- 附件上传，页面侧限制附件总大小不超过 10 MB。

请在 Cloudflare Zero Trust 中为这个自定义域名配置 Access 应用。页面会提交到同一个 Worker 的 `POST /api/send`，用户只需要通过 Access 登录，不需要输入 `CLIENT_TOKEN`。

推荐的 Access 配置方式：

1. 进入 **Zero Trust -> Access controls -> Applications**。
2. 创建 **Self-hosted** 应用，并添加 Public hostname，例如 `email.luojie.dev`。
3. 在策略中只允许可信用户、用户组或邮箱域名访问，不要使用 Everyone 或 Bypass。
4. 在应用的 Additional settings 中复制 **Application Audience (AUD) Tag**，填入 Worker 变量 `ACCESS_AUD`。
5. 将你的 Access team 域名填入 Worker 变量 `ACCESS_TEAM_DOMAIN`，格式类似 `https://<team>.cloudflareaccess.com`。
6. Worker 继续配置 `RESEND_API_KEY` 和 `FROM_EMAIL`；如果只使用写信页面，可以不配置 `CLIENT_TOKEN`。

`wrangler.toml` 已设置 `workers_dev = false`，避免默认的 `*.workers.dev` 地址绕过自定义域名上的 Access 应用。

---

## 🔀 路由说明

| 路由 | 方法 | 用途 | 鉴权方式 |
| :--- | :--- | :--- | :--- |
| `/` | `GET` | 打开写信页面。 | Worker 内校验 Cloudflare Access JWT。 |
| `/api/send` | `POST` | 写信页面提交发信请求。 | Worker 内校验 Cloudflare Access JWT，不使用 `CLIENT_TOKEN`。 |
| `/` | `POST` | 兼容旧版 JSON API 调用。 | 如果配置了 `CLIENT_TOKEN`，需要 `Authorization: Bearer <CLIENT_TOKEN>`。 |

---

## 🚀 API 调用示例

旧版 token API 仍保留在 `POST /`：

- **请求地址 (URL):** `https://email.example.com/`
- **请求头 (Headers):**
  - `Content-Type: application/json`
  - `Authorization: Bearer <你配置的 CLIENT_TOKEN>`

- **请求体 (Body JSON):**
```json
{
  "to": "target_user@gmail.com",
  "subject": "系统报警通知",
  "text": "服务器运行状态正常。",
  "html": "<h1>系统通知</h1><p>服务器运行状态<strong>正常</strong>。</p>"
}
```
