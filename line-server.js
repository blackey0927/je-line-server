/**
 * line-server.js — JE染燙快剪屋 LINE 通知伺服器
 *
 * Railway 環境變數：
 *   LINE_CHANNEL_ACCESS_TOKEN
 *   LINE_CHANNEL_SECRET
 *   ALLOWED_ORIGIN        https://je-booking.vercel.app
 *   OWNER_USER_IDS        兩位店主的 LINE userId，逗號分隔
 */

const express = require("express");
const https   = require("https");
const crypto  = require("crypto");

// ── 環境變數 ──────────────────────────────────────────────
const TOKEN          = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const SECRET         = process.env.LINE_CHANNEL_SECRET       || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN            || "https://je-booking.vercel.app";
const OWNER_IDS      = (process.env.OWNER_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

console.log("=== line-server 啟動 ===");
console.log("TOKEN:", TOKEN ? `已設定 (${TOKEN.length}字)` : "未設定");
console.log("OWNER_IDS:", OWNER_IDS.length > 0 ? OWNER_IDS.map(id => id.slice(0,8)+"...").join(", ") : "未設定");

// ── Express ──────────────────────────────────────────────
const app = express();

// /webhook 需要 raw body；其他端點用 JSON
// 順序很重要：先 raw（限定路徑），再 json（其他路徑）
app.use("/webhook", express.raw({ type: "*/*" }));
app.use((req, res, next) => {
  if (req.path === "/webhook") return next();
  express.json()(req, res, next);
});

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════════
//  LINE Push 工具
// ══════════════════════════════════════════════════════════
function linePost(path, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: "api.line.me",
      path,
      method:  "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": buf.length,
        "Authorization":  `Bearer ${TOKEN}`,
      },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end",  () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

async function pushToOwners(messages) {
  if (!TOKEN)               throw new Error("LINE_CHANNEL_ACCESS_TOKEN 未設定");
  if (OWNER_IDS.length === 0) throw new Error("OWNER_USER_IDS 未設定或為空");

  const msgArr  = Array.isArray(messages) ? messages : [messages];
  const results = [];

  for (const uid of OWNER_IDS) {
    try {
      const r = await linePost("/v2/bot/message/push", { to: uid, messages: msgArr });
      console.log(`[push→${uid.slice(-8)}] HTTP ${r.status}: ${r.body.slice(0, 200)}`);
      if (r.status === 200) {
        results.push({ uid, ok: true });
      } else {
        let detail = r.body;
        try { detail = JSON.parse(r.body).message || r.body; } catch(_) {}
        results.push({ uid, ok: false, error: `HTTP ${r.status}: ${detail}` });
      }
    } catch (e) {
      console.error(`[push→${uid.slice(-8)}]`, e.message);
      results.push({ uid, ok: false, error: e.message });
    }
  }
  return results;
}

async function replyToUser(replyToken, messages) {
  if (!TOKEN) return;
  try {
    const r = await linePost("/v2/bot/message/reply", {
      replyToken,
      messages: Array.isArray(messages) ? messages : [messages],
    });
    if (r.status !== 200) console.error(`[reply] HTTP ${r.status}:`, r.body.slice(0,150));
  } catch(e) {
    console.error("[reply]", e.message);
  }
}

// ══════════════════════════════════════════════════════════
//  Flex Message 建構
// ══════════════════════════════════════════════════════════
function row(label, value) {
  return {
    type: "box", layout: "horizontal",
    contents: [
      { type: "text", text: label, color: "#a0948d", size: "sm", flex: 2 },
      { type: "text", text: String(value || "—"), size: "sm", flex: 5, wrap: true },
    ],
  };
}

function buildNewBookingFlex(booking, svcName, stylistName, cancelUrl) {
  const rows = [
    row("服務",   svcName),
    row("設計師", stylistName),
    row("日期",   `${booking.date || ""} ${booking.time || ""}`),
    row("顧客",   booking.customerName),
    row("電話",   booking.customerPhone),
  ];
  if (booking.notes)  rows.push(row("備注",   booking.notes));
  if (booking.lineId) rows.push(row("LINE ID", booking.lineId));

  return {
    type: "flex",
    altText: `✦ 新預約：${booking.customerName || ""} ${booking.date || ""} ${booking.time || ""}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#c4835a", paddingAll: "14px",
        contents: [{ type: "text", text: "✦ 新預約通知", color: "#ffffff", weight: "bold", size: "md" }],
      },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "14px", contents: rows },
      ...(cancelUrl ? {
        footer: {
          type: "box", layout: "vertical", paddingAll: "10px",
          contents: [{
            type: "button", style: "secondary", height: "sm",
            action: { type: "uri", label: "顧客取消預約連結", uri: cancelUrl },
          }],
        },
      } : {}),
    },
  };
}

function buildCancelFlex(booking) {
  return {
    type: "flex",
    altText: `⚠️ 預約取消：${booking.customerName || ""} ${booking.date || ""} ${booking.time || ""}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#c44a3a", paddingAll: "14px",
        contents: [{ type: "text", text: "⚠️ 預約已取消", color: "#ffffff", weight: "bold", size: "md" }],
      },
      body: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "14px",
        contents: [
          row("顧客", booking.customerName),
          row("電話", booking.customerPhone),
          row("日期", `${booking.date || ""} ${booking.time || ""}`),
        ],
      },
    },
  };
}

// ══════════════════════════════════════════════════════════
//  GET /health
// ══════════════════════════════════════════════════════════
app.get("/health", (_, res) => {
  res.json({
    ok:            true,
    ts:            new Date().toISOString(),
    token:         TOKEN ? `已設定 (${TOKEN.length}字)` : "❌ 未設定",
    ownerIds:      OWNER_IDS.length > 0
                    ? OWNER_IDS.map(id => "..."+id.slice(-8))
                    : "❌ 未設定",
    allowedOrigin: ALLOWED_ORIGIN,
  });
});

// ══════════════════════════════════════════════════════════
//  POST /notify-new
// ══════════════════════════════════════════════════════════
app.post("/notify-new", async (req, res) => {
  try {
    const { booking, svcName, stylistName, cancelUrl } = req.body || {};
    if (!booking) return res.status(400).json({ error: "booking 欄位必填" });

    console.log(`[notify-new] ${booking.customerName} ${booking.date} ${booking.time}`);
    const results = await pushToOwners(buildNewBookingFlex(booking, svcName, stylistName, cancelUrl));
    const failed  = results.filter(r => !r.ok);

    if (failed.length > 0) {
      const errMsg = failed.map(r => r.error).join(" | ");
      console.error("[notify-new] 失敗:", errMsg);
      return res.status(500).json({ error: errMsg });
    }
    console.log(`[notify-new] 成功 → ${results.length} 位店主`);
    res.json({ ok: true, sent: results.length });
  } catch (e) {
    console.error("[notify-new]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /notify-cancel
// ══════════════════════════════════════════════════════════
app.post("/notify-cancel", async (req, res) => {
  try {
    const { booking } = req.body || {};
    if (!booking) return res.status(400).json({ error: "booking 欄位必填" });

    console.log(`[notify-cancel] ${booking.customerName} ${booking.date}`);
    const results = await pushToOwners(buildCancelFlex(booking));
    const failed  = results.filter(r => !r.ok);
    if (failed.length > 0) return res.status(500).json({ error: failed.map(r => r.error).join(" | ") });
    res.json({ ok: true });
  } catch (e) {
    console.error("[notify-cancel]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /webhook  LINE Messaging API Webhook
// ══════════════════════════════════════════════════════════
function verifySignature(rawBody, signature) {
  if (!SECRET) return true; // 開發環境略過驗證
  const hash = crypto.createHmac("SHA256", SECRET).update(rawBody).digest("base64");
  return hash === signature;
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const sig = req.headers["x-line-signature"];
    if (!verifySignature(req.body, sig)) {
      console.warn("[webhook] 簽章驗證失敗");
      return;
    }
    const body   = JSON.parse(req.body.toString());
    const events = body.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;
      const text = (event.message.text || "").trim();
      if (text === "取消" || text === "取消預約") {
        await replyToUser(event.replyToken, { type:"text", text:"如需取消預約，請使用預約確認信中的取消連結，或致電 📞 0981-425-802" });
      } else if (text === "查詢" || text === "查詢預約" || text === "查詢我的預約") {
        await replyToUser(event.replyToken, { type:"text", text:"請至預約網站查詢：https://je-booking.vercel.app\n如需協助請致電 📞 0981-425-802" });
      } else {
        await replyToUser(event.replyToken, { type:"text", text:"您好！如需預約：https://je-booking.vercel.app\n如需取消請致電 📞 0981-425-802" });
      }
    }
  } catch (e) {
    console.error("[webhook]", e.message);
  }
});

// ── 啟動 ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[line-server] port ${PORT} 就緒`));
