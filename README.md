# Cloudflare Email Gateway

[English](#english) | [中文](./README_zh.md)

---

## English

A secure, lightweight serverless email gateway running on Cloudflare Workers, powered by the **Resend API**. It allows you to send transactional and notification emails via your custom domains safely and quickly.

### ✨ Features
- **Ultra-low Latency**: Powered by Cloudflare's global edge network.
- **Secure Authentication**: Built-in Client Token mechanism prevents unauthorized usage.
- **Environment Driven**: Fully decoupled configuration via environment variables—no hardcoded emails.
- **Mail Composer UI**: Visit the Worker URL to send email from a webmail-like compose page protected by Cloudflare Access.
- **Rich Format Support**: Supports multiple recipients, Cc, Bcc, Reply-To, rich text, plain text fallback, and attachments.

### ⚙️ Environment Variables Configuration

After deploying to Cloudflare Workers, configure the following variables in **Settings -> Variables**:

| Variable | Type | Description |
| :--- | :--- | :--- |
| `RESEND_API_KEY` | **Secret** | Your API Key generated from the Resend dashboard. |
| `CLIENT_TOKEN` | **Secret** | Optional. A secure random token used to authenticate the legacy `POST /` API. The Access-protected compose page does not use it. |
| `FROM_EMAIL` | **Variable** | The sender identity (e.g., `Notification <i@yourdomain.com>`). |

### 📨 Compose Page

After deployment, open your Worker URL in a browser:

```text
https://<your-worker>.<your-subdomain>.workers.dev/
```

This opens a webmail-like compose page for manually sending email. It supports:

- Multiple recipients with tag-style input.
- Cc, Bcc, and optional Reply-To.
- Subject and rich text body editing.
- Common formatting actions: headings, bold, italic, underline, strikethrough, lists, indentation, alignment, text color, highlight color, links, undo, redo, and clear formatting.
- Plain text fallback generated from the message body.
- Attachments, with a 10 MB total attachment limit in the UI.

Protect the Worker URL with a Cloudflare Access application. The compose page sends through the same Worker at `POST /api/send`, so users only sign in with Access and do not need to enter `CLIENT_TOKEN`.

Recommended Access setup:

1. Create a Cloudflare Zero Trust Access application for the Worker domain.
2. Limit access to your allowed users, groups, or email domains.
3. Keep `RESEND_API_KEY` and `FROM_EMAIL` configured on the Worker.
4. Leave `CLIENT_TOKEN` unset if you only use the Access-protected compose page.

### 🔀 Routes

| Route | Method | Purpose | Authentication |
| :--- | :--- | :--- | :--- |
| `/` | `GET` | Opens the compose page. | Cloudflare Access should protect the Worker URL. |
| `/api/send` | `POST` | Used by the compose page to send email. | No `CLIENT_TOKEN`; rely on Cloudflare Access. |
| `/` | `POST` | Legacy JSON API for programmatic sending. | Uses `Authorization: Bearer <CLIENT_TOKEN>` when `CLIENT_TOKEN` is configured. |

### 🚀 API Usage

The legacy token API remains available at `POST /`:

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
