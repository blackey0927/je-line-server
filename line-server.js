/**
 * line-server.js
 * JE染燙快剪屋 × LINE 通知中繼伺服器
 * 部署至 Railway → https://railway.app
 *
 * 環境變數（在 Railway Dashboard → Variables 設定）：
 *   LINE_CHANNEL_ACCESS_TOKEN  LINE OA Channel Access Token
 *   LINE_CHANNEL_SECRET        LINE OA Channel Secret
 *   LINE_NOTIFY_TOKEN          LINE Notify Token（店主即時通知，選填）
 *   LINE_OA_ID                 官方帳號ID，例如 @658qpvwi
 *   ALLOWED_ORIGIN             前端網址，例如 https://je-booking.vercel.app
 *   PORT                       Railway 自動注入，不需手動填
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
    express.raw({ type: "*/*" })(req, res, next); // raw Buffer，供 signature 驗證使用
  } else {
    express.json()(req, res, next);
  }
});

const LINE_API     = "https://api.line.me/v2/bot/message/push";
const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET  = process.env.LINE_CHANNEL_SECRET;
const NOTIFY_TOKEN = process.env.LINE_NOTIFY_TOKEN;
const LINE_OA_ID   = process.env.LINE_OA_ID || "@658qpvwi";

// ── userId 暫存（重啟後清空，正式可改用 Firebase）─────────
const userIdCache = {};

// ── Flex Message 通知模板 ─────────────────────────────────
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

// ── LINE Notify 店主通知 ──────────────────────────────────
async function notifyOwner(type, booking, svcName, stylistName) {
  if (!NOTIFY_TOKEN) return;
  const icon = { confirm: "📌", reminder: "⏰", cancel: "❌", test: "🔔" }[type] || "📌";
  const typeLabel = { confirm: "預約確認已發送", reminder: "提醒已發送", cancel: "取消通知已發送", test: "測試通知" }[type] || "通知";
  const msg = [
    `\n${icon} ${typeLabel}`,
    `顧客：${booking.customerName}（${booking.customerPhone}）`,
    `服務：${svcName} ／ ${stylistName}`,
    `時間：${booking.date} ${booking.time}`,
    ...(booking.lineId ? [`LINE：${booking.lineId}`] : []),
  ].join("\n");

  await axios.post(
    "https://notify-api.line.me/api/notify",
    new URLSearchParams({ message: msg }),
    {
      headers: {
        Authorization: `Bearer ${NOTIFY_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
}

// ── POST /notify — 發送通知給顧客 ────────────────────────
app.post("/notify", async (req, res) => {
  const { type = "confirm", booking, svcName = "—", stylistName = "—", svcDuration = "—", svcPrice = "—", salonName = "JE染燙快剪屋" } = req.body || {};

  if (!booking) return res.status(400).json({ ok: false, msg: "缺少 booking 資料" });
  if (!LINE_TOKEN) return res.status(500).json({ ok: false, msg: "伺服器未設定 LINE_CHANNEL_ACCESS_TOKEN" });

  const errors = [];
  let pushSent = false;

  // ── Push Flex Message 給顧客 ──
  if (booking.lineId) {
    // lineId 若為 U 開頭 32 字元則為 userId，可直接推播
    // 若為 @handle 或一般 ID，需先從 userIdCache 查找
    let lineUserId = null;

    if (/^U[0-9a-zA-Z]{20,}/i.test(booking.lineId)) {
      lineUserId = booking.lineId;
    } else {
      // 嘗試從 cache 反查（依 displayName 或 lineId 對應）
      const found = Object.entries(userIdCache).find(([, v]) =>
        v.lineId === booking.lineId || v.displayName === booking.lineId
      );
      if (found) lineUserId = found[0];
    }

    if (lineUserId) {
      try {
        await axios.post(
          LINE_API,
          {
            to: lineUserId,
            messages: [buildFlexMessage(type, booking, svcName, stylistName, svcDuration, svcPrice, salonName)],
          },
          { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
        );
        pushSent = true;
      } catch (e) {
        const errMsg = e.response?.data?.message || e.message;
        errors.push(`Push 失敗: ${errMsg}`);
        console.error("[Push Error]", errMsg);
      }
    } else {
      errors.push(`lineId「${booking.lineId}」非 userId 格式，請引導顧客加入官方帳號後輸入「查詢我的預約」取得 userId`);
    }
  }

  // ── Notify 店主 ──
  try {
    await notifyOwner(type, booking, svcName, stylistName);
  } catch (e) {
    errors.push(`店主通知失敗: ${e.message}`);
    console.error("[Notify Error]", e.message);
  }

  return res.json({
    ok: errors.length === 0 || pushSent,
    pushSent,
    msg: errors.length > 0 ? errors.join(" / ") : "通知已發送",
  });
});

// ── POST /webhook — 接收 LINE 事件，捕捉 userId ──────────
app.post("/webhook", async (req, res) => {
  // ✅ 必須先回 200，否則 LINE 會判定失敗並重試
  res.status(200).end();

  try {
    // 手動驗證 x-line-signature（rawBody 為 Buffer）
    const signature = req.headers["x-line-signature"];
    const rawBody   = req.body; // express.raw() 產生的 Buffer

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

      // 取得並儲存 profile
      try {
        const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN });
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

      // 回應「查詢我的預約」指令
      if (event.type === "message" && event.message?.type === "text" && event.message.text === "查詢我的預約") {
        try {
          const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN });
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: "text",
              text: `您的 LINE userId：\n${userId}\n\n請將此 ID 提供給店家，即可接收預約推播通知。\n\n預約請前往：\nhttps://je-booking.vercel.app`,
            }],
          });
        } catch (e) {
          console.error("[Reply Error]", e.message);
        }
      }
    }
  } catch (e) {
    // 不 throw！res 已回了 200，這裡只記錄 log
    console.error("[Webhook Error]", e.message);
  }
});

// ── GET /health — Railway 健康檢查 ───────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status:          "ok",
    salonName:       "JE染燙快剪屋",
    lineOaId:        LINE_OA_ID,
    hasLineToken:    !!LINE_TOKEN,
    hasLineSecret:   !!LINE_SECRET,
    hasNotifyToken:  !!NOTIFY_TOKEN,
    cachedUsers:     Object.keys(userIdCache).length,
    time:            new Date().toISOString(),
  });
});

// ── GET /users — 查詢已捕捉的 userId 列表 ───────────────
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
  console.log(`  LINE Token : ${LINE_TOKEN ? "✓ set" : "✗ missing"}`);
  console.log(`  LINE Secret: ${LINE_SECRET ? "✓ set" : "✗ missing"}`);
  console.log(`  Notify     : ${NOTIFY_TOKEN ? "✓ set" : "✗ not set (optional)"}`);
  console.log(`  OA ID      : ${LINE_OA_ID}`);
});
