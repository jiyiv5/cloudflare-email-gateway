import { createRemoteJWKSet, jwtVerify } from "jose";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
};

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ACCESS_JWKS_CACHE = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      const access = await requireAccess(request, env);
      if (!access.ok) return access.response;
      return htmlResponse(renderComposePage(request, env, access.userEmail));
    }

    if (request.method === "POST" && url.pathname === "/api/send") {
      const access = await requireAccess(request, env);
      if (!access.ok) return access.response;
      return handleSendRequest(request, env, { requireClientToken: false });
    }

    if (request.method === "POST" && url.pathname === "/") {
      return handleSendRequest(request, env, { requireClientToken: Boolean(env.CLIENT_TOKEN) });
    }

    return jsonResponse({ error: "Not Found" }, 404);
  },
};

async function requireAccess(request, env) {
  const teamDomain = normalizeAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audience = String(env.ACCESS_AUD || "").trim();

  if (!teamDomain || !audience) {
    return {
      ok: false,
      response: jsonResponse({
        error: "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD.",
      }, 403),
    };
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return {
      ok: false,
      response: jsonResponse({ error: "Cloudflare Access authentication is required." }, 401),
    };
  }

  try {
    const jwks = getAccessJwks(teamDomain);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience,
    });

    return {
      ok: true,
      userEmail: String(
        payload.email ||
        request.headers.get("Cf-Access-Authenticated-User-Email") ||
        "已认证用户",
      ),
    };
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "Invalid Cloudflare Access token." }, 403),
    };
  }
}

function normalizeAccessTeamDomain(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.startsWith("https://")) return raw;
  if (raw.startsWith("http://")) return raw.replace(/^http:\/\//, "https://");
  return `https://${raw}`;
}

function getAccessJwks(teamDomain) {
  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
  let jwks = ACCESS_JWKS_CACHE.get(certsUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(certsUrl));
    ACCESS_JWKS_CACHE.set(certsUrl, jwks);
  }
  return jwks;
}

async function handleSendRequest(request, env, options) {
  try {
    if (options.requireClientToken) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.CLIENT_TOKEN}`) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
    }

    const payload = await request.json();
    const normalized = normalizeEmailPayload(payload);
    if (normalized.error) {
      return jsonResponse({ error: normalized.error }, 400);
    }

    const fromEmail = env.FROM_EMAIL;
    if (!fromEmail) {
      return jsonResponse({
        error: "Configuration Error: FROM_EMAIL environment variable is not defined.",
      }, 500);
    }

    if (!env.RESEND_API_KEY) {
      return jsonResponse({
        error: "Configuration Error: RESEND_API_KEY secret is not defined.",
      }, 500);
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: normalized.to,
        cc: normalized.cc,
        bcc: normalized.bcc,
        reply_to: normalized.replyTo,
        subject: normalized.subject,
        text: normalized.text,
        html: normalized.html,
        attachments: normalized.attachments,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return jsonResponse({ success: false, error: data }, response.status);
    }

    return jsonResponse({ success: true, id: data.id });
  } catch (error) {
    return jsonResponse({ error: error.message || "Unexpected error" }, 500);
  }
}

function normalizeEmailPayload(payload) {
  const to = normalizeAddressList(payload.to);
  const cc = normalizeAddressList(payload.cc);
  const bcc = normalizeAddressList(payload.bcc);
  const replyTo = normalizeAddressList(payload.replyTo || payload.reply_to);
  const subject = String(payload.subject || "").trim();
  const html = String(payload.html || "").trim();
  const text = String(payload.text || "").trim();
  const attachments = normalizeAttachments(payload.attachments);

  if (!to.length) return { error: "At least one recipient is required." };
  if (!subject) return { error: "Subject is required." };
  if (!html && !text) return { error: "Email content is required." };
  if (to.length + cc.length + bcc.length > 50) {
    return { error: "Too many recipients. Please keep To, Cc, and Bcc under 50 total addresses." };
  }

  const invalid = [...to, ...cc, ...bcc, ...replyTo].find((email) => !isValidEmail(email));
  if (invalid) return { error: `Invalid email address: ${invalid}` };

  if (attachments.error) return { error: attachments.error };

  return {
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    replyTo: replyTo.length ? replyTo : undefined,
    subject,
    html: html || undefined,
    text: text || stripHtml(html),
    attachments: attachments.files.length ? attachments.files : undefined,
  };
}

function normalizeAddressList(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : String(value).split(/[,\n;]/);
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return { files: [] };

  let totalBytes = 0;
  const files = [];
  for (const item of value) {
    const filename = String(item.filename || "").trim();
    const content = String(item.content || "");
    if (!filename || !content) continue;

    const size = Number(item.size || 0);
    totalBytes += size;
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      return { error: "Attachments are too large. Please keep the total under 10 MB." };
    }

    files.push({
      filename,
      content,
      content_type: String(item.contentType || item.content_type || "application/octet-stream"),
    });
  }

  return { files };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function htmlResponse(body) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function renderComposePage(request, env, accessUser) {
  const fromEmail = env.FROM_EMAIL || "未配置 FROM_EMAIL";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>写邮件</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d8dee8;
      --line-strong: #bac5d3;
      --text: #1d2733;
      --muted: #637083;
      --accent: #1463ff;
      --accent-weak: #e8f0ff;
      --danger: #b42318;
      --success: #067647;
      --shadow: 0 16px 36px rgba(22, 34, 51, 0.10);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        linear-gradient(180deg, #eef3fa 0, var(--bg) 260px),
        var(--bg);
    }

    button,
    input,
    textarea,
    select {
      font: inherit;
    }

    .app {
      display: grid;
      grid-template-rows: auto 1fr;
      min-height: 100vh;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.86);
      backdrop-filter: blur(16px);
      position: sticky;
      top: 0;
      z-index: 5;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .brand-mark {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border-radius: 8px;
      color: #fff;
      background: #111827;
      font-weight: 800;
    }

    .brand-title {
      display: grid;
      gap: 1px;
      min-width: 0;
    }

    .brand-title strong {
      font-size: 15px;
      line-height: 1.2;
    }

    .brand-title span,
    .identity {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .identity {
      text-align: right;
      max-width: 40vw;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 18px;
      width: min(1360px, 100%);
      margin: 0 auto;
      padding: 20px 24px 24px;
    }

    .composer,
    .side {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      min-width: 0;
    }

    .composer {
      display: grid;
      grid-template-rows: auto auto auto minmax(360px, 1fr) auto;
      min-height: calc(100vh - 110px);
    }

    .message-row {
      display: grid;
      grid-template-columns: 86px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
      min-height: 54px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
    }

    .message-row label {
      color: var(--muted);
      font-size: 13px;
      padding-top: 9px;
    }

    .recipient-box {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-height: 34px;
      padding: 2px 0;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-height: 28px;
      padding: 3px 8px;
      border-radius: 6px;
      background: var(--accent-weak);
      color: #0d3f9f;
      font-size: 13px;
    }

    .chip[data-invalid="true"] {
      background: #fff0ef;
      color: var(--danger);
    }

    .chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chip button,
    .icon-button {
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }

    .chip button {
      width: 18px;
      height: 18px;
      padding: 0;
      line-height: 18px;
      border-radius: 4px;
    }

    .address-input,
    .subject-input,
    .reply-input {
      min-width: 160px;
      flex: 1 1 180px;
      height: 32px;
      border: 0;
      outline: 0;
      color: var(--text);
      background: transparent;
    }

    .subject-input,
    .reply-input {
      width: 100%;
      flex: none;
      font-size: 15px;
    }

    .field-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-end;
    }

    .link-button {
      border: 0;
      padding: 0;
      background: transparent;
      color: var(--accent);
      cursor: pointer;
      font-size: 13px;
    }

    .optional-row[hidden] {
      display: none;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
    }

    .toolbar-group {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding-right: 7px;
      margin-right: 1px;
      border-right: 1px solid var(--line);
    }

    .toolbar-group:last-child {
      border-right: 0;
    }

    .icon-button {
      display: inline-grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 6px;
      color: #2f3a4a;
    }

    .icon-button:hover,
    .icon-button.is-active {
      background: #e9edf5;
    }

    .icon-button svg {
      width: 17px;
      height: 17px;
      stroke: currentColor;
      stroke-width: 2;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .toolbar-select,
    .color-input {
      height: 32px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
    }

    .toolbar-select {
      max-width: 132px;
      padding: 0 8px;
    }

    .color-input {
      width: 34px;
      padding: 3px;
      cursor: pointer;
    }

    .editor-wrap {
      min-height: 360px;
      overflow: auto;
    }

    .editor {
      min-height: 100%;
      padding: 24px 28px 40px;
      outline: 0;
      line-height: 1.6;
      font-size: 15px;
      word-break: break-word;
    }

    .editor:empty::before {
      content: attr(data-placeholder);
      color: #9aa5b5;
    }

    .editor blockquote {
      margin: 1em 0;
      padding-left: 14px;
      border-left: 3px solid var(--line-strong);
      color: #4b596b;
    }

    .composer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-top: 1px solid var(--line);
      background: #fbfcfe;
      border-radius: 0 0 8px 8px;
    }

    .send-group {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .send-button {
      min-width: 116px;
      height: 38px;
      border: 0;
      border-radius: 7px;
      color: #fff;
      background: var(--accent);
      font-weight: 700;
      cursor: pointer;
    }

    .send-button:disabled {
      cursor: wait;
      opacity: 0.65;
    }

    .secondary-button {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: #253247;
      background: #fff;
      cursor: pointer;
    }

    .status {
      min-width: 0;
      color: var(--muted);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status.error { color: var(--danger); }
    .status.success { color: var(--success); }

    .side {
      display: flex;
      flex-direction: column;
      align-self: start;
      overflow: hidden;
    }

    .side-section {
      padding: 16px;
      border-bottom: 1px solid var(--line);
    }

    .side-section:last-child {
      border-bottom: 0;
    }

    .side-section h2 {
      margin: 0 0 10px;
      font-size: 13px;
      line-height: 1.3;
      color: #344054;
    }

    .side-section p,
    .meta-list {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .meta-list {
      display: grid;
      gap: 8px;
    }

    .meta-list div {
      display: grid;
      gap: 2px;
    }

    .meta-list strong {
      color: var(--text);
      font-weight: 650;
      overflow-wrap: anywhere;
    }

    .file-input {
      width: 100%;
      color: var(--muted);
      font-size: 13px;
    }

    .attachments {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }

    .attachment {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fbfcfe;
      font-size: 13px;
    }

    .attachment span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .attachment button {
      border: 0;
      background: transparent;
      color: var(--danger);
      cursor: pointer;
    }

    @media (max-width: 980px) {
      .workspace {
        grid-template-columns: 1fr;
      }

      .composer {
        min-height: 680px;
      }

      .side {
        order: -1;
      }
    }

    @media (max-width: 640px) {
      .topbar {
        align-items: flex-start;
        padding: 12px 14px;
      }

      .identity {
        display: none;
      }

      .workspace {
        padding: 12px;
      }

      .message-row {
        grid-template-columns: 1fr;
        gap: 4px;
        padding: 10px 12px;
      }

      .message-row label {
        padding-top: 0;
      }

      .composer-footer {
        align-items: stretch;
        flex-direction: column;
      }

      .send-group {
        width: 100%;
      }

      .send-button,
      .secondary-button {
        flex: 1;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">M</div>
        <div class="brand-title">
          <strong>写邮件</strong>
          <span>Cloudflare Access 保护的发信入口</span>
        </div>
      </div>
      <div class="identity">${escapeHtml(accessUser || "Access 用户")}</div>
    </header>

    <main class="workspace">
      <form class="composer" id="composeForm">
        <div class="message-row">
          <label for="toInput">收件人</label>
          <div>
            <div class="recipient-box" data-field="to">
              <input class="address-input" id="toInput" autocomplete="off" placeholder="输入邮箱后按 Enter">
            </div>
            <div class="field-actions">
              <button class="link-button" type="button" data-toggle="ccRow">Cc</button>
              <button class="link-button" type="button" data-toggle="bccRow">Bcc</button>
            </div>
          </div>
        </div>

        <div class="message-row optional-row" id="ccRow" hidden>
          <label for="ccInput">Cc</label>
          <div class="recipient-box" data-field="cc">
            <input class="address-input" id="ccInput" autocomplete="off" placeholder="抄送">
          </div>
        </div>

        <div class="message-row optional-row" id="bccRow" hidden>
          <label for="bccInput">Bcc</label>
          <div class="recipient-box" data-field="bcc">
            <input class="address-input" id="bccInput" autocomplete="off" placeholder="密送">
          </div>
        </div>

        <div class="message-row">
          <label for="subjectInput">主题</label>
          <input class="subject-input" id="subjectInput" autocomplete="off" placeholder="邮件主题">
        </div>

        <div class="toolbar" aria-label="格式工具栏">
          <div class="toolbar-group">
            <select class="toolbar-select" id="blockFormat" title="段落格式">
              <option value="P">正文</option>
              <option value="H1">标题 1</option>
              <option value="H2">标题 2</option>
              <option value="H3">标题 3</option>
              <option value="BLOCKQUOTE">引用</option>
            </select>
          </div>
          <div class="toolbar-group">
            <button class="icon-button" type="button" data-command="bold" title="加粗"><strong>B</strong></button>
            <button class="icon-button" type="button" data-command="italic" title="斜体"><em>I</em></button>
            <button class="icon-button" type="button" data-command="underline" title="下划线"><u>U</u></button>
            <button class="icon-button" type="button" data-command="strikeThrough" title="删除线"><s>S</s></button>
          </div>
          <div class="toolbar-group">
            <button class="icon-button" type="button" data-command="insertUnorderedList" title="项目符号">
              <svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>
            </button>
            <button class="icon-button" type="button" data-command="insertOrderedList" title="编号列表">
              <svg viewBox="0 0 24 24"><path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 6h1v4M4 10h2M4 14h2l-2 4h2"/></svg>
            </button>
            <button class="icon-button" type="button" data-command="outdent" title="减少缩进">
              <svg viewBox="0 0 24 24"><path d="M11 6h10M11 12h10M11 18h10"/><path d="m7 8-4 4 4 4"/></svg>
            </button>
            <button class="icon-button" type="button" data-command="indent" title="增加缩进">
              <svg viewBox="0 0 24 24"><path d="M11 6h10M11 12h10M11 18h10"/><path d="m3 8 4 4-4 4"/></svg>
            </button>
          </div>
          <div class="toolbar-group">
            <button class="icon-button" type="button" data-command="justifyLeft" title="左对齐">
              <svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h12M3 18h16"/></svg>
            </button>
            <button class="icon-button" type="button" data-command="justifyCenter" title="居中">
              <svg viewBox="0 0 24 24"><path d="M3 6h18M7 12h10M5 18h14"/></svg>
            </button>
            <button class="icon-button" type="button" data-command="justifyRight" title="右对齐">
              <svg viewBox="0 0 24 24"><path d="M3 6h18M9 12h12M5 18h16"/></svg>
            </button>
          </div>
          <div class="toolbar-group">
            <input class="color-input" id="foreColor" type="color" value="#1d2733" title="文字颜色">
            <input class="color-input" id="backColor" type="color" value="#fff2a8" title="背景颜色">
            <button class="icon-button" type="button" id="linkButton" title="插入链接">
              <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </button>
            <button class="icon-button" type="button" data-command="removeFormat" title="清除格式">
              <svg viewBox="0 0 24 24"><path d="m4 7 7 7"/><path d="m9 5 10 10"/><path d="M6 19h12"/><path d="m14 4-9 9 5 5 9-9z"/></svg>
            </button>
          </div>
          <div class="toolbar-group">
            <button class="icon-button" type="button" data-command="undo" title="撤销">
              <svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-1"/></svg>
            </button>
            <button class="icon-button" type="button" data-command="redo" title="重做">
              <svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h1"/></svg>
            </button>
          </div>
        </div>

        <div class="editor-wrap">
          <div class="editor" id="editor" contenteditable="true" data-placeholder="输入邮件正文..."></div>
        </div>

        <footer class="composer-footer">
          <div class="send-group">
            <button class="send-button" id="sendButton" type="submit">发送</button>
            <button class="secondary-button" id="clearButton" type="button">清空</button>
          </div>
          <div class="status" id="status" role="status">准备就绪</div>
        </footer>
      </form>

      <aside class="side">
        <section class="side-section">
          <h2>发件信息</h2>
          <div class="meta-list">
            <div>
              <span>From</span>
              <strong>${escapeHtml(fromEmail)}</strong>
            </div>
            <div>
              <span>Reply-To</span>
              <input class="reply-input" id="replyToInput" autocomplete="off" placeholder="可选">
            </div>
          </div>
        </section>

        <section class="side-section">
          <h2>附件</h2>
          <input class="file-input" id="fileInput" type="file" multiple>
          <div class="attachments" id="attachments"></div>
        </section>

        <section class="side-section">
          <h2>发送说明</h2>
          <p>此页面已要求 Cloudflare Access JWT 验证；页面提交到同一个 Worker 的 <strong>/api/send</strong>，不会要求填写 CLIENT_TOKEN。</p>
        </section>
      </aside>
    </main>
  </div>

  <script>
    const state = {
      to: [],
      cc: [],
      bcc: [],
      attachments: [],
    };

    const editor = document.getElementById("editor");
    const statusEl = document.getElementById("status");
    const sendButton = document.getElementById("sendButton");
    const subjectInput = document.getElementById("subjectInput");
    const replyToInput = document.getElementById("replyToInput");
    const fileInput = document.getElementById("fileInput");
    const attachmentsEl = document.getElementById("attachments");

    document.querySelectorAll("[data-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const row = document.getElementById(button.dataset.toggle);
        row.hidden = false;
        const input = row.querySelector("input");
        input.focus();
        button.hidden = true;
      });
    });

    document.querySelectorAll(".recipient-box").forEach((box) => {
      const field = box.dataset.field;
      const input = box.querySelector("input");

      input.addEventListener("keydown", (event) => {
        if (["Enter", "Tab", ",", ";"].includes(event.key)) {
          event.preventDefault();
          addAddresses(field, input.value);
          input.value = "";
        }

        if (event.key === "Backspace" && !input.value && state[field].length) {
          state[field].pop();
          renderRecipients(field);
        }
      });

      input.addEventListener("paste", (event) => {
        const text = event.clipboardData.getData("text");
        if (/[\\n,;]/.test(text)) {
          event.preventDefault();
          addAddresses(field, text);
          input.value = "";
        }
      });

      input.addEventListener("blur", () => {
        addAddresses(field, input.value);
        input.value = "";
      });
    });

    document.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => runCommand(button.dataset.command));
    });

    document.getElementById("blockFormat").addEventListener("change", (event) => {
      runCommand("formatBlock", event.target.value);
      event.target.value = "P";
    });

    document.getElementById("foreColor").addEventListener("input", (event) => {
      runCommand("foreColor", event.target.value);
    });

    document.getElementById("backColor").addEventListener("input", (event) => {
      runCommand("hiliteColor", event.target.value);
    });

    document.getElementById("linkButton").addEventListener("click", () => {
      const url = prompt("输入链接地址");
      if (!url) return;
      runCommand("createLink", url);
    });

    document.getElementById("clearButton").addEventListener("click", () => {
      if (!confirm("清空当前邮件内容？")) return;
      state.to = [];
      state.cc = [];
      state.bcc = [];
      state.attachments = [];
      ["to", "cc", "bcc"].forEach(renderRecipients);
      attachmentsEl.innerHTML = "";
      subjectInput.value = "";
      replyToInput.value = "";
      editor.innerHTML = "";
      fileInput.value = "";
      setStatus("已清空");
    });

    fileInput.addEventListener("change", async () => {
      const selected = Array.from(fileInput.files || []);
      const existingBytes = state.attachments.reduce((sum, file) => sum + file.size, 0);
      const selectedBytes = selected.reduce((sum, file) => sum + file.size, 0);
      if (existingBytes + selectedBytes > ${MAX_ATTACHMENT_BYTES}) {
        setStatus("附件总大小不能超过 10 MB", "error");
        fileInput.value = "";
        return;
      }

      for (const file of selected) {
        const content = await readFileAsBase64(file);
        state.attachments.push({
          filename: file.name,
          content,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        });
      }
      fileInput.value = "";
      renderAttachments();
    });

    document.getElementById("composeForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      flushAddressInputs();

      const payload = {
        to: state.to,
        cc: state.cc,
        bcc: state.bcc,
        replyTo: replyToInput.value.trim(),
        subject: subjectInput.value.trim(),
        html: normalizeHtml(editor.innerHTML),
        text: editor.innerText.trim(),
        attachments: state.attachments,
      };

      if (!payload.to.length) return setStatus("请至少填写一个收件人", "error");
      if (!payload.subject) return setStatus("请填写主题", "error");
      if (!payload.text && !payload.html) return setStatus("请填写正文", "error");

      sendButton.disabled = true;
      setStatus("正在发送...");

      try {
        const response = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(readableError(data));
        }
        setStatus("发送成功" + (data.id ? "：" + data.id : ""), "success");
      } catch (error) {
        setStatus(error.message || "发送失败", "error");
      } finally {
        sendButton.disabled = false;
      }
    });

    function runCommand(command, value = null) {
      editor.focus();
      document.execCommand(command, false, value);
    }

    function addAddresses(field, raw) {
      const items = String(raw || "")
        .split(/[\\n,;]/)
        .map((item) => item.trim())
        .filter(Boolean);
      for (const item of items) {
        if (!state[field].includes(item)) state[field].push(item);
      }
      renderRecipients(field);
    }

    function renderRecipients(field) {
      const box = document.querySelector('[data-field="' + field + '"]');
      const input = box.querySelector("input");
      box.querySelectorAll(".chip").forEach((chip) => chip.remove());
      for (const email of state[field]) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.dataset.invalid = String(!isValidEmail(email));

        const text = document.createElement("span");
        text.textContent = email;

        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "移除";
        remove.addEventListener("click", () => {
          state[field] = state[field].filter((item) => item !== email);
          renderRecipients(field);
        });

        chip.append(text, remove);
        box.insertBefore(chip, input);
      }
    }

    function flushAddressInputs() {
      document.querySelectorAll(".recipient-box").forEach((box) => {
        const input = box.querySelector("input");
        addAddresses(box.dataset.field, input.value);
        input.value = "";
      });
    }

    function renderAttachments() {
      attachmentsEl.innerHTML = "";
      state.attachments.forEach((file, index) => {
        const row = document.createElement("div");
        row.className = "attachment";

        const name = document.createElement("span");
        name.textContent = file.filename + " · " + formatBytes(file.size);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "移除";
        remove.addEventListener("click", () => {
          state.attachments.splice(index, 1);
          renderAttachments();
        });

        row.append(name, remove);
        attachmentsEl.append(row);
      });
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    }

    function normalizeHtml(html) {
      const cleaned = String(html || "").trim();
      if (!cleaned || cleaned === "<br>") return "";
      return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1d2733">' + cleaned + "</div>";
    }

    function isValidEmail(email) {
      return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
    }

    function setStatus(message, type = "") {
      statusEl.textContent = message;
      statusEl.className = "status" + (type ? " " + type : "");
    }

    function readableError(data) {
      if (typeof data.error === "string") return data.error;
      if (data.error && data.error.message) return data.error.message;
      return JSON.stringify(data.error || data);
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / 1024 / 1024).toFixed(1) + " MB";
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
