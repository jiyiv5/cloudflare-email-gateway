# Cloudflare Email Gateway

[English](#english) | [中文](#中文)

---

## English

A secure, lightweight serverless email gateway running on Cloudflare Workers, powered by the **Resend API**. It allows you to send transactional and notification emails via your custom domains safely and quickly.

### ✨ Features
- **Ultra-low Latency**: Powered by Cloudflare's global edge network.
- **Secure Authentication**: Built-in Client Token mechanism prevents unauthorized usage.
- **Environment Driven**: Fully decoupled configuration via environment variables—no hardcoded emails.
- **Rich Format Support**: Supports both plain text and HTML emails.

### ⚙️ Environment Variables Configuration

After deploying to Cloudflare Workers, configure the following variables in **Settings -> Variables**:

| Variable | Type | Description |
| :--- | :--- | :--- |
| `RESEND_API_KEY` | **Secret** | Your API Key generated from the Resend dashboard. |
| `CLIENT_TOKEN` | **Secret** | A secure random token used to authenticate incoming API requests. |
| `FROM_EMAIL` | **Variable** | The sender identity (e.g., `Notification <i@yourdomain.com>`). |

### 🚀 API Usage

Send a `POST` request to your Worker URL:

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
