/**
 * line-server.js
 * JE?“ç?å¿«å‰ªå±?? LINE ?šçŸ¥ä¸­ç¹¼ä¼ºæ??? * ?¨ç½²??Railway ??https://railway.app
 *
 * ?°å?è®Šæ•¸ï¼ˆåœ¨ Railway Dashboard ??Variables è¨­å?ï¼‰ï?
 *   LINE_CHANNEL_ACCESS_TOKEN  LINE OA Channel Access Token
 *   LINE_CHANNEL_SECRET        LINE OA Channel Secret
 *   LINE_NOTIFY_TOKEN          LINE Notify Tokenï¼ˆå?ä¸»å³?‚é€šçŸ¥ï¼Œé¸å¡«ï?
 *   LINE_OA_ID                 å®˜æ–¹å¸³è?IDï¼Œä?å¦?@658qpvwi
 *   ALLOWED_ORIGIN             ?ç«¯ç¶²å?ï¼Œä?å¦?https://je-booking.vercel.app
 *   PORT                       Railway ?ªå?æ³¨å…¥ï¼Œä??€?‹å?å¡? */

const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const crypto  = require("crypto");
const line    = require("@line/bot-sdk");
const app     = express();

// ?€?€ CORS ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["POST", "GET", "OPTIONS"],
}));

// ?€?€ Webhook è·¯ç”±?€è¦?raw bodyï¼Œå…¶ä»–è·¯?±ç”¨ json ?€?€?€?€?€?€?€?€?€?€?€?€?€?€
app.use((req, res, next) => {
  if (req.path === "/webhook") {
    express.raw({ type: "*/*" })(req, res, next); // raw Bufferï¼Œä? signature é©—è?ä½¿ç”¨
  } else {
    express.json()(req, res, next);
  }
});

const LINE_API     = "https://api.line.me/v2/bot/message/push";
const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET  = process.env.LINE_CHANNEL_SECRET;
const NOTIFY_TOKEN = process.env.LINE_NOTIFY_TOKEN;
const LINE_OA_ID   = process.env.LINE_OA_ID || "@658qpvwi";

// ?€?€ userId ?«å?ï¼ˆé??Ÿå?æ¸…ç©ºï¼Œæ­£å¼å¯?¹ç”¨ Firebaseï¼‰â??€?€?€?€?€?€?€?€
const userIdCache = {};

// ?€?€ Flex Message ?šçŸ¥æ¨¡æ¿ ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
function buildFlexMessage(type, booking, svcName, stylistName, svcDuration, svcPrice, salonName) {
  const STATUS_MAP = {
    confirm:  { label: "???ç?ç¢ºè?",     color: "#06C755", alt: "?¨ç??ç?å·²ç¢ºèª? },
    reminder: { label: "???ç??é?",     color: "#c8a97e", alt: "?Žæ—¥?ç??é?" },
    cancel:   { label: "???ç??–æ??šçŸ¥", color: "#e05050", alt: "?ç?å·²å?æ¶? },
    test:     { label: "?? æ¸¬è©¦?šçŸ¥",     color: "#7a9aaa", alt: "?™æ˜¯æ¸¬è©¦è¨Šæ¯" },
  };
  const st = STATUS_MAP[type] || STATUS_MAP.confirm;

  const rows = [
    ["?å??…ç›®", `${svcName}ï¼?{svcDuration}?†é?ï¼‰`],
    ["è¨­è?å¸?,   stylistName],
    ["?ç??¥æ?", booking.date],
    ["?ç??‚é?", booking.time],
    ["è²»ç”¨",     svcPrice || "??],
    ...(booking.notes ? [["?™æ³¨", booking.notes]] : []),
  ];

  const footerMsg = type === "cancel"
    ? "å¦‚é??æ–°?ç?ï¼Œè?é»žé¸ä¸‹æ–¹?‰é?"
    : type === "reminder"
    ? "?Žæ—¥è«‹æ??‚åˆ°åº—ï??Ÿå??¨ç??°ä? ??"
    : "?‘å€‘å??¡å¿«?ºæ‚¨?å?ï¼Œæ?ä»»ä??é?è«‹è¯ç¹«æ???;

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
          { type: "text", text: salonName || "JE?“ç?å¿«å‰ªå±?, size: "xxs", color: "#7a6a5a", flex: 1 },
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
              label: type === "cancel" ? "?æ–°?ç?" : "?¥ç??‘ç??ç?",
              uri: `https://line.me/R/ti/p/${LINE_OA_ID}`,
            },
          },
        ],
      },
    },
  };
}

// ?€?€ LINE Notify åº—ä¸»?šçŸ¥ ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
async function notifyOwner(type, booking, svcName, stylistName) {
  if (!NOTIFY_TOKEN) return;
  const icon = { confirm: "??", reminder: "??, cancel: "??, test: "??" }[type] || "??";
  const typeLabel = { confirm: "?ç?ç¢ºè?å·²ç™¼??, reminder: "?é?å·²ç™¼??, cancel: "?–æ??šçŸ¥å·²ç™¼??, test: "æ¸¬è©¦?šçŸ¥" }[type] || "?šçŸ¥";
  const msg = [
    `\n${icon} ${typeLabel}`,
    `é¡§å®¢ï¼?{booking.customerName}ï¼?{booking.customerPhone}ï¼‰`,
    `?å?ï¼?{svcName} ï¼?${stylistName}`,
    `?‚é?ï¼?{booking.date} ${booking.time}`,
    ...(booking.lineId ? [`LINEï¼?{booking.lineId}`] : []),
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

// ?€?€ POST /notify ???¼é€é€šçŸ¥çµ¦é¡§å®??€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
app.post("/notify", async (req, res) => {
  const { type = "confirm", booking, svcName = "??, stylistName = "??, svcDuration = "??, svcPrice = "??, salonName = "JE?“ç?å¿«å‰ªå±? } = req.body || {};

  if (!booking) return res.status(400).json({ ok: false, msg: "ç¼ºå? booking è³‡æ?" });
  if (!LINE_TOKEN) return res.status(500).json({ ok: false, msg: "ä¼ºæ??¨æœªè¨­å? LINE_CHANNEL_ACCESS_TOKEN" });

  const errors = [];
  let pushSent = false;

  // ?€?€ Push Flex Message çµ¦é¡§å®??€?€
  if (booking.lineId) {
    // lineId ?¥ç‚º U ?‹é ­ 32 å­—å??‡ç‚º userIdï¼Œå¯?´æŽ¥?¨æ’­
    // ?¥ç‚º @handle ?–ä???IDï¼Œé??ˆå? userIdCache ?¥æ‰¾
    let lineUserId = null;

    if (/^U[0-9a-f]{32,33}$/i.test(booking.lineId)) {
      lineUserId = booking.lineId;
    } else {
      // ?—è©¦å¾?cache ?æŸ¥ï¼ˆä? displayName ??lineId å°æ?ï¼?      const found = Object.entries(userIdCache).find(([, v]) =>
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
        errors.push(`Push å¤±æ?: ${errMsg}`);
        console.error("[Push Error]", errMsg);
      }
    } else {
      errors.push(`lineId??{booking.lineId}?é? userId ?¼å?ï¼Œè?å¼•å?é¡§å®¢? å…¥å®˜æ–¹å¸³è?å¾Œè¼¸?¥ã€ŒæŸ¥è©¢æ??„é?ç´„ã€å?å¾?userId`);
    }
  }

  // ?€?€ Notify åº—ä¸» ?€?€
  try {
    await notifyOwner(type, booking, svcName, stylistName);
  } catch (e) {
    errors.push(`åº—ä¸»?šçŸ¥å¤±æ?: ${e.message}`);
    console.error("[Notify Error]", e.message);
  }

  return res.json({
    ok: errors.length === 0 || pushSent,
    pushSent,
    msg: errors.length > 0 ? errors.join(" / ") : "?šçŸ¥å·²ç™¼??,
  });
});

// ?€?€ POST /webhook ???¥æ”¶ LINE äº‹ä»¶ï¼Œæ???userId ?€?€?€?€?€?€?€?€?€?€
app.post("/webhook", async (req, res) => {
  // ??å¿…é??ˆå? 200ï¼Œå¦??LINE ?ƒåˆ¤å®šå¤±?—ä¸¦?è©¦
  res.status(200).end();

  try {
    // ?‹å?é©—è? x-line-signatureï¼ˆrawBody ??Bufferï¼?    const signature = req.headers["x-line-signature"];
    const rawBody   = req.body; // express.raw() ?¢ç???Buffer

    if (LINE_SECRET && signature) {
      const hash = crypto
        .createHmac("sha256", LINE_SECRET)
        .update(rawBody)
        .digest("base64");
      if (hash !== signature) {
        console.warn("[Webhook] signature é©—è?å¤±æ?ï¼Œç•¥??);
        return;
      }
    }

    const body   = JSON.parse(rawBody.toString("utf8"));
    const events = body.events || [];

    for (const event of events) {
      const userId = event.source?.userId;
      if (!userId) continue;

      // ?–å?ä¸¦å„²å­?profile
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

      // ?žæ??ŒæŸ¥è©¢æ??„é?ç´„ã€æ?ä»?      if (event.type === "message" && event.message?.type === "text" && event.message.text === "?¥è©¢?‘ç??ç?") {
        try {
          const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN });
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: "text",
              text: `?¨ç? LINE userIdï¼š\n${userId}\n\nè«‹å?æ­?ID ?ä?çµ¦å?å®¶ï??³å¯?¥æ”¶?ç??¨æ’­?šçŸ¥?‚\n\n?ç?è«‹å?å¾€ï¼š\nhttps://je-booking.vercel.app`,
            }],
          });
        } catch (e) {
          console.error("[Reply Error]", e.message);
        }
      }
    }
  } catch (e) {
    // ä¸?throwï¼res å·²å?äº?200ï¼Œé€™è£¡?ªè???log
    console.error("[Webhook Error]", e.message);
  }
});

// ?€?€ GET /health ??Railway ?¥åº·æª¢æŸ¥ ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
app.get("/health", (_req, res) => {
  res.json({
    status:          "ok",
    salonName:       "JE?“ç?å¿«å‰ªå±?,
    lineOaId:        LINE_OA_ID,
    hasLineToken:    !!LINE_TOKEN,
    hasLineSecret:   !!LINE_SECRET,
    hasNotifyToken:  !!NOTIFY_TOKEN,
    cachedUsers:     Object.keys(userIdCache).length,
    time:            new Date().toISOString(),
  });
});

// ?€?€ GET /users ???¥è©¢å·²æ??‰ç? userId ?—è¡¨ ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
app.get("/users", (_req, res) => {
  res.json({
    count: Object.keys(userIdCache).length,
    users: userIdCache,
  });
});

// ?€?€ ?Ÿå? ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[JE line-server] running on port ${PORT}`);
  console.log(`  LINE Token : ${LINE_TOKEN ? "??set" : "??missing"}`);
  console.log(`  LINE Secret: ${LINE_SECRET ? "??set" : "??missing"}`);
  console.log(`  Notify     : ${NOTIFY_TOKEN ? "??set" : "??not set (optional)"}`);
  console.log(`  OA ID      : ${LINE_OA_ID}`);
});
