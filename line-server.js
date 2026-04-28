/**
 * line-server.js — JE染燙快剪屋 LINE 通知伺服器
 *
 * 端點：
 *   POST /notify-new      顧客預約成功 → 通知店主
 *   POST /notify-cancel   顧客取消預約 → 通知店主
 *   POST /webhook         LINE Messaging API Webhook
 *                         顧客傳「取消」→ 自動查詢並取消預約
 *                         顧客傳「查詢」→ 回傳目前最近一筆預約
 *
 * Railway 環境變數：
 *   LINE_CHANNEL_ACCESS_TOKEN  Messaging API channel access token
 *   LINE_CHANNEL_SECRET        Messaging API channel secret（Webhook 驗證用）
 *   LINE_OA_ID                 @658qpvwi
 *   ALLOWED_ORIGIN             https://je-booking.vercel.app
 *   OWNER_USER_IDS             兩位店主的 LINE userId，逗號分隔
 *   FIREBASE_DB_URL            https://je-booking-default-rtdb.asia-southeast1.firebasedatabase.app
 *   FIREBASE_SERVICE_ACCOUNT   Firebase Admin SDK JSON（base64 編碼）
 */

const express    = require("express");
const https      = require("https");
const crypto     = require("crypto");

const app  = express();
app.use(express.json());

// ── 環境變數 ──────────────────────────────────────────────
const TOKEN          = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const SECRET         = process.env.LINE_CHANNEL_SECRET       || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN            || "https://je-booking.vercel.app";
const OWNER_IDS      = (process.env.OWNER_USER_IDS || "").split(",").map(s=>s.trim()).filter(Boolean);
const FB_DB_URL      = process.env.FIREBASE_DB_URL           || "https://je-booking-default-rtdb.asia-southeast1.firebasedatabase.app";
const FB_SA_B64      = process.env.FIREBASE_SERVICE_ACCOUNT  || "";

// ── CORS ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════════
//  Firebase Admin（REST fallback：不需 Admin SDK npm 套件）
// ══════════════════════════════════════════════════════════
// 使用 Firebase REST API + Service Account，不需要 firebase-admin npm。
// 取得 access token via Google OAuth2。

let _fbTokenCache = null;

async function getFBToken() {
  if (_fbTokenCache && _fbTokenCache.expires > Date.now() + 60_000) {
    return _fbTokenCache.token;
  }
  if (!FB_SA_B64) throw new Error("FIREBASE_SERVICE_ACCOUNT 未設定");

  const sa  = JSON.parse(Buffer.from(FB_SA_B64, "base64").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);

  const header  = Buffer.from(JSON.stringify({ alg:"RS256", typ:"JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
  })).toString("base64url");

  const signing   = `${header}.${payload}`;
  const privateKey = sa.private_key;
  const sign      = crypto.createSign("RSA-SHA256");
  sign.update(signing);
  const sig       = sign.sign(privateKey, "base64url");
  const jwt       = `${signing}.${sig}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const data = await httpPost("oauth2.googleapis.com", "/token", body, "application/x-www-form-urlencoded");
  const json = JSON.parse(data);
  _fbTokenCache = { token: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
  return json.access_token;
}

async function fbGet(path) {
  const token = await getFBToken();
  const url   = new URL(FB_DB_URL);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      path: `${path}.json`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(opts, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.end();
  });
}

async function fbPatch(path, data) {
  const token = await getFBToken();
  const url   = new URL(FB_DB_URL);
  const body  = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      path: `${path}.json`,
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getAllBookings() {
  const data = await fbGet("/je_bookings");
  if (!data) return [];
  return Object.values(data);
}

// ══════════════════════════════════════════════════════════
//  LINE Push 工具
// ══════════════════════════════════════════════════════════
function httpPost(hostname, path, body, contentType = "application/json", extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const buf  = typeof body === "string" ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    const opts = {
      hostname, path, method: "POST",
      headers: {
        "Content-Type":   contentType,
        "Content-Length": buf.length,
        ...extraHeaders,
      },
    };
    const req = https.request(opts, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

function pushLine(userId, messages) {
  if (!TOKEN) { console.error("[pushLine] LINE_CHANNEL_ACCESS_TOKEN 未設定"); return Promise.resolve(); }
  return httpPost("api.line.me", "/v2/bot/message/push",
    { to: userId, messages: Array.isArray(messages) ? messages : [messages] },
    "application/json",
    { Authorization: `Bearer ${TOKEN}` }
  ).then(res => { console.log(`[pushLine→${userId.slice(-6)}]`, res.slice(0,120)); return res; });
}

function replyLine(replyToken, messages) {
  if (!TOKEN) { console.error("[replyLine] LINE_CHANNEL_ACCESS_TOKEN 未設定"); return Promise.resolve(); }
  return httpPost("api.line.me", "/v2/bot/message/reply",
    { replyToken, messages: Array.isArray(messages) ? messages : [messages] },
    "application/json",
    { Authorization: `Bearer ${TOKEN}` }
  );
}

// ── 新預約 Flex Message ──────────────────────────────────
function buildNewBookingFlex(booking, svcName, stylistName, cancelUrl) {
  const body = {
    type: "bubble",
    header: {
      type: "box", layout: "vertical", backgroundColor: "#c4835a",
      contents: [{ type: "text", text: "✦ 新預約通知", color: "#fff", weight: "bold", size: "md" }],
    },
    body: {
      type: "box", layout: "vertical", spacing: "sm",
      contents: [
        { type: "box", layout: "horizontal", contents: [
          { type: "text", text: "服務", color: "#a0948d", size: "sm", flex: 2 },
          { type: "text", text: svcName || "—", size: "sm", flex: 5, wrap: true },
        ]},
        { type: "box", layout: "horizontal", contents: [
          { type: "text", text: "設計師", color: "#a0948d", size: "sm", flex: 2 },
          { type: "text", text: stylistName || "—", size: "sm", flex: 5 },
        ]},
        { type: "box", layout: "horizontal", contents: [
          { type: "text", text: "日期", color: "#a0948d", size: "sm", flex: 2 },
          { type: "text", text: `${booking.date} ${booking.time}`, size: "sm", flex: 5 },
        ]},
        { type: "box", layout: "horizontal", contents: [
          { type: "text", text: "顧客", color: "#a0948d", size: "sm", flex: 2 },
          { type: "text", text: booking.customerName || "—", size: "sm", flex: 5 },
        ]},
        { type: "box", layout: "horizontal", contents: [
          { type: "text", text: "電話", color: "#a0948d", size: "sm", flex: 2 },
          { type: "text", text: booking.customerPhone || "—", size: "sm", flex: 5 },
        ]},
        ...(booking.notes ? [{ type: "box", layout: "horizontal", contents: [
          { type: "text", text: "備注", color: "#a0948d", size: "sm", flex: 2 },
          { type: "text", text: booking.notes, size: "sm", flex: 5, wrap: true },
        ]}] : []),
      ],
    },
    ...(cancelUrl ? {
      footer: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [{
          type: "button", style: "secondary", height: "sm",
          action: { type: "uri", label: "顧客取消預約連結", uri: cancelUrl },
        }],
      },
    } : {}),
  };
  return { type: "flex", altText: `新預約：${booking.customerName} ${booking.date} ${booking.time}`, contents: body };
}

// ── 取消通知 Flex Message ───────────────────────────────
function buildCancelFlex(booking) {
  return {
    type: "flex",
    altText: `⚠️ 預約取消：${booking.customerName} ${booking.date} ${booking.time}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#c44a3a",
        contents: [{ type: "text", text: "⚠️ 預約已取消", color: "#fff", weight: "bold", size: "md" }],
      },
      body: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "box", layout: "horizontal", contents: [
            { type: "text", text: "顧客", color: "#a0948d", size: "sm", flex: 2 },
            { type: "text", text: booking.customerName || "—", size: "sm", flex: 5 },
          ]},
          { type: "box", layout: "horizontal", contents: [
            { type: "text", text: "電話", color: "#a0948d", size: "sm", flex: 2 },
            { type: "text", text: booking.customerPhone || "—", size: "sm", flex: 5 },
          ]},
          { type: "box", layout: "horizontal", contents: [
            { type: "text", text: "日期", color: "#a0948d", size: "sm", flex: 2 },
            { type: "text", text: `${booking.date} ${booking.time}`, size: "sm", flex: 5 },
          ]},
        ],
      },
    },
  };
}

// ══════════════════════════════════════════════════════════
//  POST /notify-new  （顧客預約 → 通知店主）
// ══════════════════════════════════════════════════════════
app.post("/notify-new", async (req, res) => {
  try {
    const { booking, svcName, stylistName, cancelUrl } = req.body;
    if (!booking) return res.status(400).json({ error: "booking required" });
    if (!TOKEN)   return res.status(500).json({ error: "LINE_CHANNEL_ACCESS_TOKEN 未設定" });
    if (OWNER_IDS.length === 0) return res.status(500).json({ error: "OWNER_USER_IDS 未設定或為空" });

    console.log(`[notify-new] 新預約 ${booking.customerName} ${booking.date} ${booking.time} → 推送給 ${OWNER_IDS.length} 位店主`);
    const msg = buildNewBookingFlex(booking, svcName, stylistName, cancelUrl);
    const results = await Promise.allSettled(OWNER_IDS.map(uid => pushLine(uid, msg)));
    results.forEach((r, i) => {
      if (r.status === "rejected") console.error(`[notify-new] 推送給 ${OWNER_IDS[i]} 失敗:`, r.reason);
    });
    res.json({ ok: true, sent: OWNER_IDS.length });
  } catch (e) {
    console.error("[notify-new]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /notify-cancel  （顧客取消 → 通知店主）
// ══════════════════════════════════════════════════════════
app.post("/notify-cancel", async (req, res) => {
  try {
    const { booking } = req.body;
    if (!booking) return res.status(400).json({ error: "booking required" });
    if (!TOKEN)   return res.status(500).json({ error: "LINE_CHANNEL_ACCESS_TOKEN 未設定" });
    if (OWNER_IDS.length === 0) return res.status(500).json({ error: "OWNER_USER_IDS 未設定或為空" });

    console.log(`[notify-cancel] 取消預約 ${booking.customerName} ${booking.date}`);
    const msg = buildCancelFlex(booking);
    await Promise.all(OWNER_IDS.map(uid => pushLine(uid, msg)));
    res.json({ ok: true });
  } catch (e) {
    console.error("[notify-cancel]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /webhook  （LINE Messaging API Webhook）
// ══════════════════════════════════════════════════════════

// LINE Webhook 簽章驗證
function verifySignature(rawBody, signature) {
  if (!SECRET) return true; // 開發環境略過
  const hash = crypto.createHmac("SHA256", SECRET).update(rawBody).digest("base64");
  return hash === signature;
}

// 取得用戶最近一筆未取消預約
async function getLatestBookingByLineId(lineUserId) {
  const all = await getAllBookings();
  return all
    .filter(b => b.lineId === lineUserId && b.status !== "cancelled")
    .sort((a, b) => (a.date + a.time) < (b.date + b.time) ? 1 : -1)[0] || null;
}

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  // 立即回 200，LINE 要求快速回應
  res.sendStatus(200);

  try {
    const signature = req.headers["x-line-signature"];
    if (!verifySignature(req.body, signature)) {
      console.warn("[webhook] 簽章驗證失敗");
      return;
    }

    const body   = JSON.parse(req.body.toString());
    const events = body.events || [];

    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const text        = (event.message.text || "").trim();
      const userId      = event.source?.userId;
      const replyToken  = event.replyToken;

      if (!userId) continue;

      // ── 指令：取消 ────────────────────────────────────
      if (text === "取消" || text === "取消預約" || text.toLowerCase() === "cancel") {
        const booking = await getLatestBookingByLineId(userId);

        if (!booking) {
          await replyLine(replyToken, {
            type: "text",
            text: "找不到您目前的預約記錄。\n如需協助，請直接來電 📞 " + (process.env.SALON_PHONE || "0981-425-802"),
          });
          continue;
        }

        // 取消預約
        await fbPatch(`/je_bookings/${booking.id}`, { status: "cancelled" });

        // 回覆顧客
        await replyLine(replyToken, {
          type: "flex",
          altText: "您的預約已取消",
          contents: {
            type: "bubble",
            header: {
              type: "box", layout: "vertical", backgroundColor: "#a0c4b8",
              contents: [{ type: "text", text: "✓ 預約取消成功", color: "#fff", weight: "bold", size: "md" }],
            },
            body: {
              type: "box", layout: "vertical", spacing: "sm",
              contents: [
                { type: "text", text: `${booking.date} ${booking.time}`, size: "lg", weight: "bold", color: "#1c1816" },
                { type: "text", text: `${booking.customerName} 的預約已成功取消`, size: "sm", color: "#a0948d", wrap: true },
                { type: "separator", margin: "md" },
                { type: "text", text: "如需重新預約，請至預約網站或傳訊息給我們 😊", size: "sm", color: "#a0948d", wrap: true, margin: "md" },
              ],
            },
          },
        });

        // 通知店主
        await Promise.all(OWNER_IDS.map(uid => pushLine(uid, buildCancelFlex(booking))));
        continue;
      }

      // ── 指令：查詢 ───────────────────────────────────
      if (text === "查詢" || text === "查詢預約" || text === "查詢我的預約") {
        const booking = await getLatestBookingByLineId(userId);

        if (!booking) {
          await replyLine(replyToken, {
            type: "text",
            text: "查無您目前的預約記錄。\n如需預約請至：https://je-booking.vercel.app",
          });
          continue;
        }

        const cancelUrl = booking.cancelToken
          ? `https://je-booking.vercel.app/?cancel=${booking.id}&token=${booking.cancelToken}`
          : null;

        await replyLine(replyToken, {
          type: "flex",
          altText: `您的預約：${booking.date} ${booking.time}`,
          contents: {
            type: "bubble",
            header: {
              type: "box", layout: "vertical", backgroundColor: "#c4835a",
              contents: [{ type: "text", text: "✦ 您的預約資訊", color: "#fff", weight: "bold", size: "md" }],
            },
            body: {
              type: "box", layout: "vertical", spacing: "sm",
              contents: [
                { type: "box", layout: "horizontal", contents: [
                  { type: "text", text: "日期", color: "#a0948d", size: "sm", flex: 2 },
                  { type: "text", text: `${booking.date} ${booking.time}`, size: "sm", flex: 5 },
                ]},
                { type: "box", layout: "horizontal", contents: [
                  { type: "text", text: "狀態", color: "#a0948d", size: "sm", flex: 2 },
                  { type: "text", text: booking.status === "confirmed" ? "✅ 已確認" : "⏳ 待確認", size: "sm", flex: 5 },
                ]},
              ],
            },
            ...(cancelUrl ? {
              footer: {
                type: "box", layout: "vertical",
                contents: [{
                  type: "button", style: "secondary", height: "sm",
                  action: { type: "uri", label: "取消此預約", uri: cancelUrl },
                }],
              },
            } : {}),
          },
        });
        continue;
      }

      // ── 其他訊息：自動回覆說明 ───────────────────────
      await replyLine(replyToken, {
        type: "text",
        text: "您好！請輸入以下指令：\n\n📋 查詢預約 — 查看您目前的預約\n❌ 取消預約 — 取消目前最近一筆預約\n\n線上預約：https://je-booking.vercel.app",
      });
    }
  } catch (e) {
    console.error("[webhook error]", e.message, e.stack);
  }
});

// ══════════════════════════════════════════════════════════
//  Health check
// ══════════════════════════════════════════════════════════
app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[line-server] running on port ${PORT}`));
