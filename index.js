const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
};

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_SENDER_NAME_LENGTH = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/") {
      return jsonResponse({ error: "Not Found" }, 404);
    }

    return handleSendRequest(request, env);
  },
};

async function handleSendRequest(request, env) {
  try {
    if (env.CLIENT_TOKEN) {
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
        from: normalized.from,
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
  const sender = normalizeSender(payload.from);
  const to = normalizeAddressList(payload.to);
  const cc = normalizeAddressList(payload.cc);
  const bcc = normalizeAddressList(payload.bcc);
  const replyTo = normalizeAddressList(payload.replyTo || payload.reply_to);
  const subject = String(payload.subject || "").trim();
  const html = String(payload.html || "").trim();
  const text = String(payload.text || "").trim();
  const attachments = normalizeAttachments(payload.attachments);

  if (sender.error) return { error: sender.error };
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
    from: sender.value,
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

function normalizeSender(value) {
  const sender = String(value ?? "").trim();
  if (!sender) return { error: "Sender is required." };
  if (/[\u0000-\u001f\u007f]/.test(sender)) {
    return { error: "Sender contains invalid control characters." };
  }
  if (isValidEmail(sender)) return { value: sender };

  const match = sender.match(/^([^<>]+?)\s*<([^<>]+)>$/);
  if (!match) {
    return { error: 'Invalid sender format. Use "email@example.com" or "Name <email@example.com>".' };
  }

  const displayName = match[1].trim();
  const email = match[2].trim();
  if (!displayName) {
    return { error: 'Invalid sender format. Use "email@example.com" or "Name <email@example.com>".' };
  }
  if (!isValidEmail(email)) return { error: `Invalid sender email address: ${email}` };
  if (displayName.length > MAX_SENDER_NAME_LENGTH) {
    return { error: `Sender name must be ${MAX_SENDER_NAME_LENGTH} characters or fewer.` };
  }

  return { value: formatFromAddress(email, displayName) };
}

function formatFromAddress(fromEmail, fromName) {
  if (!fromName) return fromEmail;

  const escapedName = fromName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escapedName}" <${fromEmail}>`;
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
