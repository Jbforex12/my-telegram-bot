const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
require("dotenv").config();

// ─── Config ────────────────────────────────────────────────────────────────
const BOT_NAME = "Pathway Prep Assistant";
const SUPPORT_EMAIL = "support@pathwayprep.com";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "change-this-key";
const PORT = process.env.PORT || 3001;
const USERS_FILE = path.join(__dirname, "users.json");
const CODES_FILE = path.join(__dirname, "codes.json");

// ─── Data helpers ──────────────────────────────────────────────────────────
function loadJSON(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  return def;
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error("Save error:", e.message); }
}
function loadUsers() { return loadJSON(USERS_FILE, { users: {}, banned: {} }); }
function saveUsers(d) { saveJSON(USERS_FILE, d); }
function loadCodes() { return loadJSON(CODES_FILE, { codes: {} }); }
function saveCodes(d) { saveJSON(CODES_FILE, d); }

// ─── Code helpers ──────────────────────────────────────────────────────────
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "JB-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function createCode(note = "") {
  const data = loadCodes();
  let code;
  do { code = generateCode(); } while (data.codes[code]);
  data.codes[code] = { code, note, createdAt: new Date().toISOString(), usedBy: null, usedAt: null };
  saveCodes(data);
  return code;
}
function activateCode(code, chatId, userInfo) {
  const data = loadCodes();
  const entry = data.codes[code.toUpperCase()];
  if (!entry) return { ok: false, reason: "invalid" };
  if (entry.usedBy) return { ok: false, reason: "used" };
  entry.usedBy = String(chatId);
  entry.usedAt = new Date().toISOString();
  entry.userInfo = userInfo;
  saveCodes(data);
  return { ok: true };
}
function isActivated(chatId) {
  const data = loadCodes();
  return Object.values(data.codes).some(c => c.usedBy === String(chatId));
}
function isAdmin(chatId) { return ADMIN_CHAT_ID && String(chatId) === ADMIN_CHAT_ID; }
function isBanned(chatId) {
  const data = loadUsers();
  return !!data.banned[String(chatId)];
}
function saveUser(chatId, info) {
  const data = loadUsers();
  const id = String(chatId);
  data.users[id] = {
    ...( data.users[id] || {}),
    chatId: id,
    ...info,
    lastSeen: new Date().toISOString(),
    messageCount: ((data.users[id] || {}).messageCount || 0) + 1
  };
  saveUsers(data);
}

// ─── Telegram bot ──────────────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
console.log("TOKEN check — first 10 chars:", token ? token.substring(0, 10) : "MISSING", "| length:", token ? token.length : 0);

const bot = new TelegramBot(token, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const conversations = {};
const firstMessage = {};
const lastProcessedMessageId = {};
const pendingActivation = {};

const systemPrompt = `
You are ${BOT_NAME}, a warm, intelligent and deeply knowledgeable assistant for Pathway Prep — a programme that gives individuals the knowledge, skills and confidence they need to prepare for work and opportunities abroad.

ABOUT PATHWAY PREP:
When asked "Who are you?" or "What is Pathway Prep?", respond exactly:
"Pathway Prep is a programme designed to give individuals the knowledge, skills and confidence they need to prepare for work and opportunities abroad. Whether you're looking to start a new career, understand what a job role involves, or simply build on what you already know — Pathway Prep is here to guide you every step of the way 🎓"

YOUR INTELLIGENCE AND TEACHING ABILITY:
- You are highly capable of handling complex topics — career advice, CV writing, interview preparation, workplace culture, professional skills, communication, finance basics, personal development, and more
- When someone wants to learn something, become their tutor. Break topics down step by step, use simple real-life examples, check understanding naturally, and build on what they know
- Adapt your depth to the user — if they seem advanced, go deeper; if they seem new to a topic, start from the basics
- You can explain complex ideas in plain everyday language without dumbing it down
- If a topic is outside Pathway Prep's scope or you genuinely don't know, say: "That's a great question — the support team would be best placed to help you with that. You can reach them at ${SUPPORT_EMAIL}"

REPLY STYLE — VERY IMPORTANT:
- Do NOT end every reply with a question. Only ask a question when you genuinely need more information to help, or when it naturally fits the conversation.
- Keep replies concise and conversational — no long walls of text
- Split information into short paragraphs if needed, but keep it digestible
- Never use markdown formatting — no asterisks, no bullet dashes. Plain text only.
- Never echo back what the user just said
- Never use robotic or corporate phrases
- Never expose technical language to the user
- When a user says "okay", "thanks", "bye", or signals the conversation is ending — respond warmly and briefly, then stop.
- Always follow the user's lead if they change topic

TUTORING MODE:
- If a user wants to learn or study something, guide them through it like a patient, encouraging tutor
- Teach one concept at a time, use relatable examples
- Occasionally check understanding naturally
- Celebrate progress with genuine warmth

TONE:
- Warm, human, encouraging and real
- Like a smart, supportive friend who genuinely wants to help — not a customer service bot
- Honest when you don't know something

Always end conversations warmly, mentioning Pathway Prep by name.
`.trim();

// ─── Bot handlers ──────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  firstMessage[chatId] = true;

  if (isBanned(chatId)) {
    return bot.sendMessage(chatId, `Sorry, your access has been restricted. Contact ${SUPPORT_EMAIL} if you think this is a mistake.`);
  }

  if (isAdmin(chatId)) {
    return bot.sendMessage(chatId, `Welcome back, Admin! Use /help to see admin commands.`);
  }

  if (isActivated(chatId)) {
    return bot.sendMessage(chatId, `Hello! I'm the ${BOT_NAME} 👋\n\nI'm here to help you build the knowledge, skills and confidence you need to prepare for work and opportunities abroad.\n\nHow can I help you today?`);
  }

  pendingActivation[chatId] = true;
  bot.sendMessage(chatId, `Welcome to ${BOT_NAME} 👋\n\nTo get started, please enter your activation code.\n\nIf you don't have one, contact ${SUPPORT_EMAIL} to get access.`);
});

bot.onText(/\/forget/, (msg) => {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  firstMessage[chatId] = true;
  bot.sendMessage(chatId, "Done — I've cleared our conversation history. How can I help you today?");
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  bot.sendMessage(chatId,
    "Admin commands:\n\n" +
    "/gencode [note] — generate an activation code\n" +
    "/codes — list all codes\n" +
    "/users — list all users\n" +
    "/ban [chatId] [reason] — ban a user\n" +
    "/unban [chatId] — unban a user"
  );
});

bot.onText(/\/gencode(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const note = match[1] || "";
  const code = createCode(note);
  bot.sendMessage(chatId, `New activation code:\n\n${code}\n\n${note ? "Note: " + note : ""}\n\nThis code can only be used once.`);
});

bot.onText(/\/codes/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const data = loadCodes();
  const codes = Object.values(data.codes);
  if (!codes.length) return bot.sendMessage(chatId, "No codes generated yet. Use /gencode to create one.");
  const unused = codes.filter(c => !c.usedBy);
  const used = codes.filter(c => c.usedBy);
  let text = `Codes: ${codes.length} total\n✅ Used: ${used.length} | ⏳ Unused: ${unused.length}\n\n`;
  unused.forEach(c => { text += `⏳ ${c.code}${c.note ? " — " + c.note : ""}\n`; });
  used.forEach(c => { text += `✅ ${c.code} → ${c.userInfo ? c.userInfo.firstName : c.usedBy}\n`; });
  bot.sendMessage(chatId, text);
});

bot.onText(/\/users/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const data = loadUsers();
  const users = Object.values(data.users);
  if (!users.length) return bot.sendMessage(chatId, "No users yet.");
  let text = `Users: ${users.length}\n\n`;
  users.forEach(u => {
    const banned = data.banned[u.chatId] ? " 🚫" : "";
    const activated = isActivated(u.chatId) ? " ✓" : " ⏳";
    text += `${u.firstName || "Unknown"} (@${u.username || "—"})${activated}${banned}\nID: ${u.chatId}\n\n`;
  });
  bot.sendMessage(chatId, text);
});

bot.onText(/\/ban(?:\s+(\d+))?(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const targetId = match[1];
  if (!targetId) return bot.sendMessage(chatId, "Usage: /ban [chatId] [reason]");
  const reason = match[2] || "Banned by admin";
  const data = loadUsers();
  data.banned[targetId] = { reason, at: new Date().toISOString() };
  saveUsers(data);
  bot.sendMessage(chatId, `User ${targetId} banned.`);
  bot.sendMessage(targetId, `Your access has been restricted. Contact ${SUPPORT_EMAIL} if you think this is a mistake.`).catch(() => {});
});

bot.onText(/\/unban(?:\s+(\d+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const targetId = match[1];
  if (!targetId) return bot.sendMessage(chatId, "Usage: /unban [chatId]");
  const data = loadUsers();
  delete data.banned[targetId];
  saveUsers(data);
  bot.sendMessage(chatId, `User ${targetId} unbanned.`);
  bot.sendMessage(targetId, "Your access has been restored. Welcome back!").catch(() => {});
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;
  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;

  saveUser(chatId, {
    firstName: msg.from.first_name,
    lastName: msg.from.last_name,
    username: msg.from.username
  });

  if (isBanned(chatId)) return bot.sendMessage(chatId, `Your access has been restricted. Contact ${SUPPORT_EMAIL}.`);

  // Activation flow
  if (!isAdmin(chatId) && (!isActivated(chatId) || pendingActivation[chatId])) {
    const code = text.trim().toUpperCase();
    const result = activateCode(code, chatId, { firstName: msg.from.first_name, username: msg.from.username });
    if (result.ok) {
      delete pendingActivation[chatId];
      if (ADMIN_CHAT_ID) {
        bot.sendMessage(ADMIN_CHAT_ID, `New user activated: ${msg.from.first_name} (@${msg.from.username || "—"}) | Code: ${code}`).catch(() => {});
      }
      return bot.sendMessage(chatId, `You're in! Welcome to ${BOT_NAME} 🎉\n\nI'm here to help you build the knowledge, skills and confidence you need to prepare for work and opportunities abroad.\n\nHow can I help you today?`);
    } else if (result.reason === "used") {
      return bot.sendMessage(chatId, `That code has already been used. Each code works for one account only.\n\nContact ${SUPPORT_EMAIL} if you need a new one.`);
    } else {
      return bot.sendMessage(chatId, `That code isn't valid. Please check it and try again, or contact ${SUPPORT_EMAIL} for help.`);
    }
  }

  bot.sendChatAction(chatId, "typing");
  if (!conversations[chatId]) conversations[chatId] = [];

  let intro = "";
  if (!firstMessage[chatId]) {
    firstMessage[chatId] = true;
    intro = `[The user has opened the chat without using /start. Greet them briefly and warmly as ${BOT_NAME}, then respond to their message below naturally.]\n\n`;
  }

  conversations[chatId].push({ role: "user", content: intro + text });

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...conversations[chatId]
      ]
    });
    const reply = response.choices[0].message.content;
    conversations[chatId].push({ role: "assistant", content: reply });
    if (conversations[chatId].length > 30) conversations[chatId] = conversations[chatId].slice(-30);
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Message error:", err.message);
    await bot.sendMessage(chatId, "Something went wrong on my end — please try again in a moment.");
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;
  if (!isAdmin(chatId) && !isActivated(chatId)) return;
  bot.sendChatAction(chatId, "typing");
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const imageUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: msg.caption || "What do you see here?" }
        ]}
      ]
    });
    const reply = response.choices[0].message.content;
    if (!conversations[chatId]) conversations[chatId] = [];
    conversations[chatId].push({ role: "assistant", content: reply });
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Photo error:", err.message);
    await bot.sendMessage(chatId, "I couldn't read that image — could you try sending it again?");
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

// ─── Admin HTTP API ─────────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost`);
  const p = url.pathname;

  // Serve admin panel (no API key needed for the HTML itself)
  if (req.method === "GET" && (p === "/" || p === "/admin")) {
    try {
      const html = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Admin panel not found.");
    }
  }

  // Health check for deployment platforms
  if (req.method === "GET" && p === "/health") {
    return sendJSON(res, 200, { status: "ok" });
  }

  // All API routes require the admin API key
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== ADMIN_API_KEY) return sendJSON(res, 401, { error: "Unauthorized" });

  if (req.method === "GET" && p === "/api/stats") {
    const u = loadUsers(); const c = loadCodes();
    const all = Object.values(c.codes);
    return sendJSON(res, 200, {
      totalUsers: Object.keys(u.users).length,
      bannedUsers: Object.keys(u.banned).length,
      totalCodes: all.length,
      usedCodes: all.filter(x => x.usedBy).length,
      unusedCodes: all.filter(x => !x.usedBy).length
    });
  }

  if (req.method === "GET" && p === "/api/users") {
    const u = loadUsers(); const c = loadCodes();
    const users = Object.values(u.users).map(user => {
      const code = Object.values(c.codes).find(x => x.usedBy === user.chatId);
      return { ...user, activated: !!code, activationCode: code ? code.code : null, banned: !!u.banned[user.chatId] };
    });
    return sendJSON(res, 200, { users });
  }

  if (req.method === "GET" && p === "/api/codes") {
    const c = loadCodes(); const u = loadUsers();
    const codes = Object.values(c.codes).map(code => {
      const user = code.usedBy ? u.users[code.usedBy] : null;
      return { ...code, userName: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : null, userUsername: user ? user.username : null };
    });
    return sendJSON(res, 200, { codes });
  }

  if (req.method === "POST" && p === "/api/codes/generate") {
    const body = await parseBody(req);
    const count = Math.min(parseInt(body.count) || 1, 50);
    const note = body.note || "";
    const codes = [];
    for (let i = 0; i < count; i++) codes.push(createCode(note));
    return sendJSON(res, 200, { codes });
  }

  if (req.method === "DELETE" && p.startsWith("/api/codes/")) {
    const code = p.split("/api/codes/")[1].toUpperCase();
    const data = loadCodes();
    if (!data.codes[code]) return sendJSON(res, 404, { error: "Not found" });
    if (data.codes[code].usedBy) return sendJSON(res, 400, { error: "Code already used" });
    delete data.codes[code];
    saveCodes(data);
    return sendJSON(res, 200, { success: true });
  }

  if (req.method === "POST" && p.match(/^\/api\/users\/\d+\/ban$/)) {
    const id = p.split("/")[3];
    const body = await parseBody(req);
    const data = loadUsers();
    data.banned[id] = { reason: body.reason || "Blocked via admin panel", at: new Date().toISOString() };
    saveUsers(data);
    bot.sendMessage(id, `Your access has been restricted. Contact ${SUPPORT_EMAIL} if you think this is a mistake.`).catch(() => {});
    return sendJSON(res, 200, { success: true });
  }

  if (req.method === "POST" && p.match(/^\/api\/users\/\d+\/unban$/)) {
    const id = p.split("/")[3];
    const data = loadUsers();
    delete data.banned[id];
    saveUsers(data);
    bot.sendMessage(id, "Your access has been restored. Welcome back!").catch(() => {});
    return sendJSON(res, 200, { success: true });
  }

  return sendJSON(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`✅ Pathway Prep Bot is running!`);
  console.log(`✅ Admin API running on port ${PORT}`);
});
