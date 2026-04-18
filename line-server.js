/**
 * line-server.js
 * JE??敹怠撅?? LINE ?銝剔匱隡箸??? * ?函蔡??Railway ??https://railway.app
 *
 * ?啣?霈嚗 Railway Dashboard ??Variables 閮剖?嚗?
 *   LINE_CHANNEL_ACCESS_TOKEN  LINE OA Channel Access Token
 *   LINE_CHANNEL_SECRET        LINE OA Channel Secret
 *   LINE_NOTIFY_TOKEN          LINE Notify Token嚗?銝餃?嚗憛恬?
 *   LINE_OA_ID                 摰撣唾?ID嚗?憒?@658qpvwi
 *   ALLOWED_ORIGIN             ?垢蝬脣?嚗?憒?https://je-booking.vercel.app
 *   PORT                       Railway ?芸?瘜典嚗????憛? */

const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const crypto  = require("crypto");
const line    = require("@line/bot-sdk");
const app     = express();

// ?? CORS ??????????????????????????????????????????????????
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["POST", "GET", "OPTIONS"],
}));

// ?? Webhook 頝舐?閬?raw body嚗隞楝?梁 json ??????????????
app.use((req, res, next) => {
  if (req.path === "/webhook") {
    express.raw({ type: "*/*" })(req, res, next); // raw Buffer嚗? signature 撽?雿輻
  } else {
    express.json()(req, res, next);
  }
});

const LINE_API     = "https://api.line.me/v2/bot/message/push";
const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET  = process.env.LINE_CHANNEL_SECRET;
const NOTIFY_TOKEN = process.env.LINE_NOTIFY_TOKEN;
const LINE_OA_ID   = process.env.LINE_OA_ID || "@658qpvwi";

// ?? userId ?怠?嚗???皜征嚗迤撘?寧 Firebase嚗?????????
const userIdCache = {};

// ?? Flex Message ?璅⊥ ?????????????????????????????????
function buildFlexMessage(type, booking, svcName, stylistName, svcDuration, svcPrice, salonName) {
  const STATUS_MAP = {
    confirm:  { label: "????蝣箄?",     color: "#06C755", alt: "?函???撌脩Ⅱ隤? },
    reminder: { label: "??????",     color: "#c8a97e", alt: "?????" },
    cancel:   { label: "???????", color: "#e05050", alt: "??撌脣?瘨? },
    test:     { label: "?? 皜祈岫?",     color: "#7a9aaa", alt: "?皜祈岫閮" },
  };
  const st = STATUS_MAP[type] || STATUS_MAP.confirm;

  const rows = [
    ["???", `${svcName}嚗?{svcDuration}??嚗],
    ["閮剛?撣?,   stylistName],
    ["???交?", booking.date],
    ["????", booking.time],
    ["鞎餌",     svcPrice || "??],
    ...(booking.notes ? [["?釣", booking.notes]] : []),
  ];

  const footerMsg = type === "cancel"
    ? "憒????嚗?暺銝??"
    : type === "reminder"
    ? "?隢??摨????函??唬? ??"
    : "???∪翰?箸??嚗?隞颱???隢蝜急???;

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
          { type: "text", text: salonName || "JE??敹怠撅?, size: "xxs", color: "#7a6a5a", flex: 1 },
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
              label: type === "cancel" ? "???" : "?亦?????",
              uri: `https://line.me/R/ti/p/${LINE_OA_ID}`,
            },
          },
        ],
      },
    },
  };
}

// ?? LINE Notify 摨蜓? ??????????????????????????????????
async function notifyOwner(type, booking, svcName, stylistName) {
  if (!NOTIFY_TOKEN) return;
  const icon = { confirm: "??", reminder: "??, cancel: "??, test: "??" }[type] || "??";
  const typeLabel = { confirm: "??蝣箄?撌脩??, reminder: "??撌脩??, cancel: "???撌脩??, test: "皜祈岫?" }[type] || "?";
  const msg = [
    `\n${icon} ${typeLabel}`,
    `憿批恥嚗?{booking.customerName}嚗?{booking.customerPhone}嚗,
    `??嚗?{svcName} 嚗?${stylistName}`,
    `??嚗?{booking.date} ${booking.time}`,
    ...(booking.lineId ? [`LINE嚗?{booking.lineId}`] : []),
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

// ?? POST /notify ???潮蝯阡“摰?????????????????????????
app.post("/notify", async (req, res) => {
  const { type = "confirm", booking, svcName = "??, stylistName = "??, svcDuration = "??, svcPrice = "??, salonName = "JE??敹怠撅? } = req.body || {};

  if (!booking) return res.status(400).json({ ok: false, msg: "蝻箏? booking 鞈?" });
  if (!LINE_TOKEN) return res.status(500).json({ ok: false, msg: "隡箸??冽閮剖? LINE_CHANNEL_ACCESS_TOKEN" });

  const errors = [];
  let pushSent = false;

  // ?? Push Flex Message 蝯阡“摰???
  if (booking.lineId) {
    // lineId ?亦 U ? 32 摮?? userId嚗?湔?冽
    // ?亦 @handle ????ID嚗??? userIdCache ?交
    let lineUserId = null;

    if (/^U[0-9a-f]{32,33}$/i.test(booking.lineId)) {
      lineUserId = booking.lineId;
    } else {
      // ?岫敺?cache ?嚗? displayName ??lineId 撠?嚗?      const found = Object.entries(userIdCache).find(([, v]) =>
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
        errors.push(`Push 憭望?: ${errMsg}`);
        console.error("[Push Error]", errMsg);
      }
    } else {
      errors.push(`lineId??{booking.lineId}?? userId ?澆?嚗?撘?憿批恥?摰撣唾?敺撓?乓閰Ｘ???蝝?敺?userId`);
    }
  }

  // ?? Notify 摨蜓 ??
  try {
    await notifyOwner(type, booking, svcName, stylistName);
  } catch (e) {
    errors.push(`摨蜓?憭望?: ${e.message}`);
    console.error("[Notify Error]", e.message);
  }

  return res.json({
    ok: errors.length === 0 || pushSent,
    pushSent,
    msg: errors.length > 0 ? errors.join(" / ") : "?撌脩??,
  });
});

// ?? POST /webhook ???交 LINE 鈭辣嚗???userId ??????????
app.post("/webhook", async (req, res) => {
  // ??敹??? 200嚗??LINE ?摰仃?蒂?岫
  res.status(200).end();

  try {
    // ??撽? x-line-signature嚗awBody ??Buffer嚗?    const signature = req.headers["x-line-signature"];
    const rawBody   = req.body; // express.raw() ?Ｙ???Buffer

    if (LINE_SECRET && signature) {
      const hash = crypto
        .createHmac("sha256", LINE_SECRET)
        .update(rawBody)
        .digest("base64");
      if (hash !== signature) {
        console.warn("[Webhook] signature 撽?憭望?嚗??);
        return;
      }
    }

    const body   = JSON.parse(rawBody.toString("utf8"));
    const events = body.events || [];

    for (const event of events) {
      const userId = event.source?.userId;
      if (!userId) continue;

      // ??銝血摮?profile
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

      // ???閰Ｘ???蝝?隞?      if (event.type === "message" && event.message?.type === "text" && event.message.text === "?亥岷????") {
        try {
          const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN });
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: "text",
              text: `?函? LINE userId嚗n${userId}\n\n隢?甇?ID ??蝯血?摰塚??喳?交???冽??n\n??隢?敺嚗nhttps://je-booking.vercel.app`,
            }],
          });
        } catch (e) {
          console.error("[Reply Error]", e.message);
        }
      }
    }
  } catch (e) {
    // 銝?throw嚗es 撌脣?鈭?200嚗ㄐ?芾???log
    console.error("[Webhook Error]", e.message);
  }
});

// ?? GET /health ??Railway ?亙熒瑼Ｘ ???????????????????????
app.get("/health", (_req, res) => {
  res.json({
    status:          "ok",
    salonName:       "JE??敹怠撅?,
    lineOaId:        LINE_OA_ID,
    hasLineToken:    !!LINE_TOKEN,
    hasLineSecret:   !!LINE_SECRET,
    hasNotifyToken:  !!NOTIFY_TOKEN,
    cachedUsers:     Object.keys(userIdCache).length,
    time:            new Date().toISOString(),
  });
});

// ?? GET /users ???亥岷撌脫??? userId ?” ???????????????
app.get("/users", (_req, res) => {
  res.json({
    count: Object.keys(userIdCache).length,
    users: userIdCache,
  });
});

// ?? ?? ?????????????????????????????????????????????????
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[JE line-server] running on port ${PORT}`);
  console.log(`  LINE Token : ${LINE_TOKEN ? "??set" : "??missing"}`);
  console.log(`  LINE Secret: ${LINE_SECRET ? "??set" : "??missing"}`);
  console.log(`  Notify     : ${NOTIFY_TOKEN ? "??set" : "??not set (optional)"}`);
  console.log(`  OA ID      : ${LINE_OA_ID}`);
});
