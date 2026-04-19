/**
 * line-server.js
 * JE染燙快剪屋 × LINE 通知中繼伺服器
 * 部署至 Railway → https://railway.app
 *
 * 環境變數（在 Railway Dashboard → Variables 設定）：
 *   LINE_CHANNEL_ACCESS_TOKEN  LINE OA Channel Access Token
 *   LINE_CHANNEL_SECRET        LINE OA Channel Secret
 *   LINE_OA_ID                 官方帳號ID，例如 @658qpvwi
 *   OWNER_USER_IDS             店主 LINE userId，多人用逗號分隔
 *                              例如：U2e018a856892515a06a7fa2302e1754a,Ua0459c59a57479c68db36038f57a59e2
 *   ALLOWED_ORIGIN             前端網址，例如 https://je-booking.vercel.app
 *   PORT                       Railway 自動注入，不需手動填
 *
 * ⚠️  LINE Notify 已於 2025/3/31 終止服務，本檔案已改用 Messaging API 通知店主
 */

const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const crypto  = require("crypto");
const line    = require("@line/bot-sdk");
const app     = express();

// ── CORS ──────────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["POST", "GET", "OPTIONS"],
}));

// ── Webhook 路由需要 raw body，其他路由用 json ──────────────
app.use((req, res, next) => {
  if (req.path === "/webhook") {
    express.raw({ type: "*/*" })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

const LINE_API    = "https://api.line.me/v2/bot/message/push";
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_OA_ID  = process.env.LINE_OA_ID || "@658qpvwi";

// 店主 userId 清單（支援多人，逗號分隔）
const OWNER_USER_IDS = (process.env.OWNER_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ── userId 暫存 ───────────────────────────────────────────
const userIdCache = {};

// ── Flex Message 模板（顧客通知）─────────────────────────
function buildFlexMessage(type, booking, svcName, stylistName, svcDuration, svcPrice, salonName) {
  const STATUS_MAP = {
    confirm:  { label: "✅ 預約確認",     color: "#06C755", alt: "您的預約已確認" },
    reminder: { label: "⏰ 預約提醒",     color: "#c8a97e", alt: "明日預約提醒" },
    cancel:   { label: "❌ 預約取消通知", color: "#e05050", alt: "預約已取消" },
    test:     { label: "🔔 測試通知",     color: "#7a9aaa", alt: "這是測試訊息" },
  };
  const st = STATUS_MAP[type] || STATUS_MAP.confirm;

  const rows = [
    ["服務項目", `${svcName}（${svcDuration}分鐘）`],
    ["設計師",   stylistName],
    ["預約日期", booking.date],
    ["預約時間", booking.time],
    ["費用",     svcPrice || "—"],
    ...(booking.notes ? [["備注", booking.notes]] : []),
  ];

  const footerMsg = type === "cancel"
    ? "如需重新預約，請點選下方按鈕"
    : type === "reminder"
    ? "明日請準時到店，期待您的到來 🙏"
    : "我們將盡快為您服務，有任何問題請聯繫我們";

  return {
    type: "flex",
    altText: st.alt,
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "horizontal",
        backgroundColor: "#0d0b08",
        paddingAll: "14px",
        contents: [
          { type: "text", text: salonName || "JE染燙快剪屋", size: "xxs", color: "#7a6a5a", flex: 1 },
          { type: "text", text: st.label, size: "sm", color: st.color, align: "end", weight: "bold" },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#12100d",
        paddingAll: "14px",
        spacing: "xs",
        contents: [
          { type: "separator", color: "#2a2018", margin: "none" },
          ...rows.map(([k, v]) => ({
            type: "box",
            layout: "horizontal",
            margin: "sm",
            contents: [
              { type: "text", text: k, size: "xxs", color: "#5a4a3a", flex: 2 },
              { type: "text", text: String(v), size: "xs", color: "#e8ddd0", flex: 3, wrap: true },
            ],
          })),
          { type: "separator", color: "#2a2018", margin: "sm" },
          { type: "text", text: footerMsg, size: "xxs", color: "#5a4a3a", wrap: true, margin: "sm" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0d0b08",
        paddingAll: "10px",
        contents: [
          {
            type: "button",
            style: "primary",
            color: type === "cancel" ? "#c8a97e" : "#06C755",
            height: "sm",
            action: {
              type: "uri",
              label: type === "cancel" ? "重新預約" : "查看我的預約",
              uri: `https://line.me/R/ti/p/${LINE_OA_ID}`,
            },
          },
        ],
      },
    },
  };
}

// ── 店主通知 Flex Message 模板 ────────────────────────────
function buildOwnerFlexMessage(type, booking, svcName, stylistName) {
  const icons  = { confirm: "📌", reminder: "⏰", cancel: "❌", test: "🔔", new: "🆕" };
  const labels = { confirm: "顧客通知已發送", reminder: "提醒通知已發送", cancel: "取消通知已發送", test: "測試通知", new: "新預約通知" };
  const colors = { confirm: "#06C755", reminder: "#c8a97e", cancel: "#e05050", test: "#7a9aaa", new: "#c4835a" };

  const icon  = icons[type]  || "📌";
  const label = labels[type] || "通知";
  const color = colors[type] || "#c4835a";

  const rows = [
    ["顧客姓名", booking.customerName || "—"],
    ["聯絡電話", booking.customerPhone || "—"],
    ["服務項目", svcName || "—"],
    ["負責設計師", stylistName || "—"],
    ["預約日期", booking.date || "—"],
    ["預約時間", booking.time || "—"],
    ...(booking.lineId ? [["LINE ID", booking.lineId]] : []),
    ...(booking.notes  ? [["備注",    booking.notes]]  : []),
  ];

  return {
    type: "flex",
    altText: `${icon} ${label}｜${booking.customerName} ${booking.date} ${booking.time}`,
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "horizontal",
        backgroundColor: "#1a1208",
        paddingAll: "14px",
        contents: [
          { type: "text", text: "JE 染燙快剪屋 · 後台", size: "xxs", color: "#7a6a5a", flex: 1 },
          { type: "text", text: `${icon} ${label}`, size: "sm", color: color, align: "end", weight: "bold" },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#100e0a",
        paddingAll: "14px",
        spacing: "xs",
        contents: [
          { type: "separator", color: "#2a2018", margin: "none" },
          ...rows.map(([k, v]) => ({
            type: "box",
            layout: "horizontal",
            margin: "sm",
            contents: [
              { type: "text", text: k,      size: "xxs", color: "#6a5a4a", flex: 3 },
              { type: "text", text: String(v), size: "xs", color: "#f0e8d8", flex: 4, wrap: true },
            ],
          })),
          { type: "separator", color: "#2a2018", margin: "sm" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1a1208",
        paddingAll: "10px",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#c4835a",
            height: "sm",
            action: {
              type: "uri",
              label: "前往管理後台",
              uri: process.env.ALLOWED_ORIGIN || "https://je-booking.vercel.app",
            },
          },
        ],
      },
    },
  };
}

// ── 推播訊息給店主（所有 OWNER_USER_IDS）────────────────
async function notifyOwner(type, booking, svcName, stylistName) {
  if (!LINE_TOKEN || OWNER_USER_IDS.length === 0) return;

  const flexMsg = buildOwnerFlexMessage(type, booking, svcName, stylistName);

  const results = await Promise.allSettled(
    OWNER_USER_IDS.map(userId =>
      axios.post(
        LINE_API,
        { to: userId, messages: [flexMsg] },
        { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
      )
    )
  );

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const msg = r.reason?.response?.data?.message || r.reason?.message;
      console.error(`[Owner Notify] 發送給 ${OWNER_USER_IDS[i]} 失敗: ${msg}`);
    } else {
      console.log(`[Owner Notify] 發送給 ${OWNER_USER_IDS[i]} 成功`);
    }
  });
}

// ── POST /notify — 發送通知給顧客（並同步通知店主）────────
app.post("/notify", async (req, res) => {
  const {
    type = "confirm",
    booking,
    svcName = "—", stylistName = "—",
    svcDuration = "—", svcPrice = "—",
    salonName = "JE染燙快剪屋",
  } = req.body || {};

  if (!booking)    return res.status(400).json({ ok: false, msg: "缺少 booking 資料" });
  if (!LINE_TOKEN) return res.status(500).json({ ok: false, msg: "伺服器未設定 LINE_CHANNEL_ACCESS_TOKEN" });

  const errors  = [];
  let pushSent  = false;

  // ── Push Flex Message 給顧客 ──
  if (booking.lineId) {
    let lineUserId = null;

    if (/^U[0-9a-zA-Z]{20,}/i.test(booking.lineId)) {
      lineUserId = booking.lineId;
    } else {
      const found = Object.entries(userIdCache).find(([, v]) =>
        v.lineId === booking.lineId || v.displayName === booking.lineId
      );
      if (found) lineUserId = found[0];
    }

    if (lineUserId) {
      try {
        await axios.post(
          LINE_API,
          { to: lineUserId, messages: [buildFlexMessage(type, booking, svcName, stylistName, svcDuration, svcPrice, salonName)] },
          { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
        );
        pushSent = true;
      } catch (e) {
        const errMsg = e.response?.data?.message || e.message;
        errors.push(`顧客通知失敗: ${errMsg}`);
        console.error("[Push Error]", errMsg);
      }
    } else {
      errors.push(`lineId「${booking.lineId}」非 userId 格式`);
    }
  }

  // ── 通知所有店主 ──
  try {
    await notifyOwner(type, booking, svcName, stylistName);
  } catch (e) {
    errors.push(`店主通知失敗: ${e.message}`);
    console.error("[Owner Notify Error]", e.message);
  }

  return res.json({
    ok: errors.length === 0 || pushSent,
    pushSent,
    msg: errors.length > 0 ? errors.join(" / ") : "通知已發送",
  });
});

// ── POST /notify-new — 新預約時自動通知店主（由 App.jsx 呼叫）─
app.post("/notify-new", async (req, res) => {
  const { booking, svcName = "—", stylistName = "—" } = req.body || {};
  if (!booking) return res.status(400).json({ ok: false, msg: "缺少 booking 資料" });
  if (!LINE_TOKEN) return res.status(500).json({ ok: false, msg: "伺服器未設定 LINE_CHANNEL_ACCESS_TOKEN" });

  try {
    await notifyOwner("new", booking, svcName, stylistName);
    return res.json({ ok: true, msg: "店主通知已發送" });
  } catch (e) {
    console.error("[notify-new Error]", e.message);
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

// ── POST /webhook — 接收 LINE 事件，捕捉 userId ──────────
app.post("/webhook", async (req, res) => {
  res.status(200).end();

  try {
    const signature = req.headers["x-line-signature"];
    const rawBody   = req.body;

    if (LINE_SECRET && signature) {
      const hash = crypto
        .createHmac("sha256", LINE_SECRET)
        .update(rawBody)
        .digest("base64");
      if (hash !== signature) {
        console.warn("[Webhook] signature 驗證失敗，略過");
        return;
      }
    }

    const body   = JSON.parse(rawBody.toString("utf8"));
    const events = body.events || [];

    for (const event of events) {
      const userId = event.source?.userId;
      if (!userId) continue;

      try {
        const client  = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN });
        const profile = await client.getProfile(userId);
        userIdCache[userId] = {
          displayName: profile.displayName,
          pictureUrl:  profile.pictureUrl,
          lineId:      userId,
          updatedAt:   new Date().toISOString(),
        };
        console.log(`[Webhook] userId=${userId} name=${profile.displayName}`);
      } catch (e) {
        console.error("[Profile Error]", e.message);
      }

      if (event.type === "message" && event.message?.type === "text" && event.message.text === "查詢我的預約") {
        try {
          const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN });
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: "text",
              text: `您的 LINE userId：\n${userId}\n\n請將此 ID 提供給店家，即可接收預約推播通知。\n\n預約請前往：\n${process.env.ALLOWED_ORIGIN || "https://je-booking.vercel.app"}`,
            }],
          });
        } catch (e) {
          console.error("[Reply Error]", e.message);
        }
      }
    }
  } catch (e) {
    console.error("[Webhook Error]", e.message);
  }
});

// ── GET /health ───────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status:         "ok",
    salonName:      "JE染燙快剪屋",
    lineOaId:       LINE_OA_ID,
    hasLineToken:   !!LINE_TOKEN,
    hasLineSecret:  !!LINE_SECRET,
    ownerCount:     OWNER_USER_IDS.length,
    cachedUsers:    Object.keys(userIdCache).length,
    time:           new Date().toISOString(),
  });
});

// ── GET /users ────────────────────────────────────────────
app.get("/users", (_req, res) => {
  res.json({
    count: Object.keys(userIdCache).length,
    users: userIdCache,
  });
});

// ── 啟動 ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[JE line-server] running on port ${PORT}`);
  console.log(`  LINE Token  : ${LINE_TOKEN  ? "✓ set" : "✗ missing"}`);
  console.log(`  LINE Secret : ${LINE_SECRET ? "✓ set" : "✗ missing"}`);
  console.log(`  Owner IDs   : ${OWNER_USER_IDS.length > 0 ? OWNER_USER_IDS.map(id => id.slice(0,8)+"…").join(", ") : "✗ not set"}`);
  console.log(`  OA ID       : ${LINE_OA_ID}`);
});
