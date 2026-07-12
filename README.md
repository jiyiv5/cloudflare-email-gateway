# Cloudflare Email Gateway

[English](#english) | [中文](./README_zh.md)

---

## English

A secure, lightweight serverless email gateway running on Cloudflare Workers, powered by the **Resend API**. It allows you to send transactional and notification emails via your custom domains safely and quickly. The compose page validates Cloudflare Access JWTs inside the Worker, so the page is not rendered unless Access authentication has passed.

### ✨ Features
- **Ultra-low Latency**: Powered by Cloudflare's global edge network.
- **Secure Authentication**: The compose page and `/api/send` require a valid Cloudflare Access JWT; the legacy JSON API can still use a Client Token.
- **Environment Driven**: Fully decoupled configuration via environment variables—no hardcoded emails.
- **Mail Composer UI**: Visit the custom Worker domain to send email from a webmail-like compose page protected by Cloudflare Access.
- **Rich Format Support**: Supports multiple recipients, Cc, Bcc, Reply-To, rich text, plain text fallback, and attachments.

### ⚙️ Environment Variables Configuration

After deploying to Cloudflare Workers, configure the following variables in **Settings -> Variables**:

| Variable | Type | Description |
| :--- | :--- | :--- |
| `RESEND_API_KEY` | **Secret** | Your API Key generated from the Resend dashboard. |
| `CLIENT_TOKEN` | **Secret** | Optional. A secure random token used to authenticate the legacy `POST /` API. The Access-protected compose page does not use it. |
| `FROM_EMAIL` | **Variable** | The sender identity (e.g., `Notification <i@yourdomain.com>`). |
| `ACCESS_TEAM_DOMAIN` | **Variable** | Your Access team domain, for example `https://<team>.cloudflareaccess.com`. |
| `ACCESS_AUD` | **Variable** | The **Application Audience (AUD) Tag** from your Zero Trust Access application. |

### 📨 Compose Page

After deployment, open the custom domain routed to this Worker:

```text
https://email.example.com/
```

This opens a webmail-like compose page for manually sending email. It supports:

- Multiple recipients with tag-style input.
- Cc, Bcc, and optional Reply-To.
- Subject and rich text body editing.
- Common formatting actions: headings, bold, italic, underline, strikethrough, lists, indentation, alignment, text color, highlight color, links, undo, redo, and clear formatting.
- Plain text fallback generated from the message body.
- Attachments, with a 10 MB total attachment limit in the UI.

Protect the custom domain with a Cloudflare Access application. The compose page sends through the same Worker at `POST /api/send`, so users only sign in with Access and do not need to enter `CLIENT_TOKEN`.

Recommended Access setup:

1. Go to **Zero Trust -> Access controls -> Applications**.
2. Create a **Self-hosted** application and add the public hostname, for example `email.luojie.dev`.
3. Allow only trusted users, groups, or email domains. Do not use Everyone or Bypass for this app.
4. Copy the **Application Audience (AUD) Tag** from the app's Additional settings into the Worker variable `ACCESS_AUD`.
5. Set `ACCESS_TEAM_DOMAIN` to your Access team domain, for example `https://<team>.cloudflareaccess.com`.
6. Keep `RESEND_API_KEY` and `FROM_EMAIL` configured on the Worker. Leave `CLIENT_TOKEN` unset if you only use the compose page.

`wrangler.toml` sets `workers_dev = false` so the default `*.workers.dev` URL cannot bypass the Access application on your custom domain.

### 🔀 Routes

| Route | Method | Purpose | Authentication |
| :--- | :--- | :--- | :--- |
| `/` | `GET` | Opens the compose page. | Worker validates the Cloudflare Access JWT. |
| `/api/send` | `POST` | Used by the compose page to send email. | Worker validates the Cloudflare Access JWT; no `CLIENT_TOKEN`. |
| `/` | `POST` | Legacy JSON API for programmatic sending. | Uses `Authorization: Bearer <CLIENT_TOKEN>` when `CLIENT_TOKEN` is configured. |

### 🚀 API Usage

The legacy token API remains available at `POST /`:

- **URL:** `https://email.example.com/`
- **Headers:**
  - `Content-Type: application/json`
  - `Authorization: Bearer <YOUR_CLIENT_TOKEN>`

- **Body Example (JSON):**
```json
{
  "to": "target_user@gmail.com",
  "subject": "System Alert",
  "text": "The server is running smoothly.",
  "html": "<h1>System Alert</h1><p>The server is running <strong>smoothly</strong>.</p>"
}
```
