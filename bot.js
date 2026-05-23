const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
require("dotenv").config();

// ─── Config ────────────────────────────────────────────────────────────────
const BOT_NAME = "Pathway Prep Assistant";
const SUPPORT_EMAIL = "support@pathwayprep.com";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "change-this-key";
const PORT = process.env.PORT || 3001;
// DATA_DIR keeps codes/users across deploys (set to Render disk path in production)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CODES_FILE = path.join(DATA_DIR, "codes.json");
const TEXT_MODEL = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_TOKENS = 2048;
const MAX_HISTORY = 24;
const MAX_DOC_CHARS = 14000;

function requireEnv() {
  const placeholders = [
    "your_telegram_bot_token_here",
    "your_groq_api_key_here",
    "your_telegram_chat_id_here",
    "change-this-to-a-strong-secret-key"
  ];
  const missing = [];
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groqKey = process.env.GROQ_API_KEY;
  if (!token || placeholders.includes(token)) missing.push("TELEGRAM_BOT_TOKEN");
  if (!groqKey || placeholders.includes(groqKey)) missing.push("GROQ_API_KEY");
  if (missing.length) {
    console.error("\n❌ Bot cannot start — missing environment variables:\n");
    missing.forEach((key) => console.error(`   • ${key}`));
    console.error("\nEdit the .env file in the project folder and add your real API keys.");
    console.error("(Copy from .env.example if .env does not exist yet.)\n");
    process.exit(1);
  }
}
requireEnv();

// ─── Data helpers (codes/users are NEVER wiped by code edits — only by explicit actions) ──
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJSON(file, def) {
  ensureDataDir();
  const backup = file + ".bak";
  const tryParse = (raw) => {
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  };
  try {
    if (fs.existsSync(file)) {
      const data = tryParse(fs.readFileSync(file, "utf8"));
      if (data !== null) return data;
      console.error(`Data file empty or invalid, trying backup: ${file}`);
    }
  } catch (e) {
    console.error(`Load error ${path.basename(file)}:`, e.message);
  }
  try {
    if (fs.existsSync(backup)) {
      const data = tryParse(fs.readFileSync(backup, "utf8"));
      if (data !== null) {
        console.log(`Restored ${path.basename(file)} from backup`);
        saveJSON(file, data, { allowEmpty: true });
        return data;
      }
    }
  } catch (e) {
    console.error(`Backup load error ${path.basename(file)}:`, e.message);
  }
  return JSON.parse(JSON.stringify(def));
}

function saveJSON(file, data, opts = {}) {
  ensureDataDir();
  try {
    if (file === CODES_FILE && data.codes && !opts.allowEmpty) {
      const count = Object.keys(data.codes).length;
      if (count === 0 && fs.existsSync(file)) {
        try {
          const existing = JSON.parse(fs.readFileSync(file, "utf8"));
          if (existing.codes && Object.keys(existing.codes).length > 0) {
            console.error("Refused to save empty codes.json over existing codes");
            return;
          }
        } catch (e) { /* proceed if unreadable */ }
      }
    }
    const tmp = file + ".tmp";
    const backup = file + ".bak";
    if (fs.existsSync(file)) fs.copyFileSync(file, backup);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error("Save error:", e.message);
  }
}

function loadUsers() {
  const data = loadJSON(USERS_FILE, { users: {}, banned: {} });
  if (!data.users) data.users = {};
  if (!data.banned) data.banned = {};
  return data;
}
function saveUsers(d) { saveJSON(USERS_FILE, d); }
function loadCodes() {
  const data = loadJSON(CODES_FILE, { codes: {} });
  if (!data.codes) data.codes = {};
  return data;
}
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
    ...(data.users[id] || {}),
    chatId: id,
    ...info,
    lastSeen: new Date().toISOString(),
    messageCount: ((data.users[id] || {}).messageCount || 0) + 1
  };
  saveUsers(data);
}

function looksLikeActivationCode(text) {
  const t = text.trim();
  return /^JB-/i.test(t) || /^[A-Z0-9]{2,}-[A-Z0-9]{4,}$/i.test(t);
}

function welcomeMessage() {
  return (
    `Welcome to ${BOT_NAME} 👋\n\n` +
    `I'm here to help you build the knowledge, skills and confidence you need to prepare for work and opportunities abroad.\n\n` +
    `I can help with career guidance, CV and interview prep, workplace skills, learning new topics, and reviewing documents or images you send me.\n\n` +
    `To get started, please enter your activation code (for example: JB-XXXXXX).\n\n` +
    `If you don't have one, contact ${SUPPORT_EMAIL} to get access.`
  );
}

function activationSuccessMessage() {
  return (
    `You're in! Welcome to ${BOT_NAME} 🎉\n\n` +
    `I'm your personal learning and career assistant for Pathway Prep.\n\n` +
    `You can ask me questions, send images, or upload files like PDFs, Word documents, and spreadsheets — I'll read them and help based on our conversation.\n\n` +
    `How can I help you today?`
  );
}

// ─── Reply formatting ──────────────────────────────────────────────────────
function formatReply(text) {
  if (!text) return text;
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/^\s*[-*•]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendLongMessage(chatId, text) {
  const formatted = formatReply(text);
  if (formatted.length <= 4000) {
    await bot.sendMessage(chatId, formatted);
    return;
  }
  const parts = [];
  let remaining = formatted;
  while (remaining.length > 0) {
    if (remaining.length <= 4000) {
      parts.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n\n", 4000);
    if (splitAt < 1500) splitAt = remaining.lastIndexOf("\n", 4000);
    if (splitAt < 1500) splitAt = 4000;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  for (const part of parts) {
    if (part) await bot.sendMessage(chatId, part);
  }
}

// ─── File helpers ──────────────────────────────────────────────────────────
function downloadTelegramFile(filePath) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/file/bot${token}/${filePath}`, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed (${res.statusCode})`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function extractPdfText(buffer) {
  const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages.join("\n\n");
}

async function extractDocumentText(fileName, buffer) {
  const ext = path.extname(fileName || "").toLowerCase();
  let text = "";

  if ([".txt", ".md", ".csv", ".json", ".log"].includes(ext)) {
    text = buffer.toString("utf8");
  } else if (ext === ".pdf") {
    text = await extractPdfText(buffer);
  } else if (ext === ".docx") {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else if ([".xlsx", ".xls"].includes(ext)) {
    const XLSX = require("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    text = wb.SheetNames.map((name) => {
      const sheet = wb.Sheets[name];
      return `Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`;
    }).join("\n\n");
  } else {
    throw new Error(`unsupported:${ext || "unknown"}`);
  }

  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("empty");
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS) + "\n\n[Document truncated due to length — ask if you need a specific section analysed further.]";
  }
  return text;
}

// ─── Telegram bot ──────────────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
console.log("TOKEN check — first 10 chars:", token ? token.substring(0, 10) : "MISSING", "| length:", token ? token.length : 0);

const bot = new TelegramBot(token, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const conversations = {};
const firstMessage = {};
const lastProcessedMessageId = {};
const welcomedUsers = {};

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
- When the user sends an image or document, analyse it carefully in the context of the ongoing conversation. Give thorough, specific, and actionable feedback — not vague summaries
- If a topic is outside Pathway Prep's scope or you genuinely don't know, say: "That's a great question — the support team would be best placed to help you with that. You can reach them at ${SUPPORT_EMAIL}"

REPLY STYLE — VERY IMPORTANT:
- Write in a professional, polished tone with clear visual spacing
- Use a blank line between every paragraph (double line break)
- When listing points, use the bullet character • at the start of each line — never use asterisks, dashes, or markdown
- Structure longer answers with a brief opening line, then spaced sections, then a clear closing if helpful
- Do NOT end every reply with a question. Only ask when you genuinely need more information
- Never echo back what the user just said
- Never use robotic or corporate phrases
- Never expose technical language to the user
- When a user says "okay", "thanks", "bye", or signals the conversation is ending — respond warmly and briefly, then stop
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

function getHistory(chatId) {
  if (!conversations[chatId]) conversations[chatId] = [];
  return conversations[chatId];
}

function trimHistory(chatId) {
  const history = getHistory(chatId);
  if (history.length > MAX_HISTORY) {
    conversations[chatId] = history.slice(-MAX_HISTORY);
  }
}

async function chatText(chatId, userText, options = {}) {
  const history = getHistory(chatId);
  history.push({ role: "user", content: userText });

  const response = await groq.chat.completions.create({
    model: TEXT_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: systemPrompt },
      ...history
    ]
  });

  const reply = response.choices[0].message.content;
  history.push({ role: "assistant", content: reply });
  trimHistory(chatId);
  return reply;
}

async function chatVision(chatId, imageUrl, userText) {
  const history = getHistory(chatId);
  const prior = history.slice(-MAX_HISTORY);

  const response = await groq.chat.completions.create({
    model: VISION_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: systemPrompt },
      ...prior,
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: userText }
        ]
      }
    ]
  });

  const reply = response.choices[0].message.content;
  history.push({ role: "user", content: `[Image uploaded] ${userText}` });
  history.push({ role: "assistant", content: reply });
  trimHistory(chatId);
  return reply;
}

function buildIntro(chatId) {
  if (firstMessage[chatId] === false) {
    firstMessage[chatId] = true;
    return `[The user is chatting with you for the first time after activation. Briefly introduce yourself as ${BOT_NAME} in one warm sentence, then respond to their message below naturally and helpfully.]\n\n`;
  }
  return "";
}

async function handleActivationAttempt(msg, text) {
  const chatId = msg.chat.id;

  if (!looksLikeActivationCode(text)) {
    if (!welcomedUsers[chatId]) {
      welcomedUsers[chatId] = true;
      return bot.sendMessage(chatId, welcomeMessage());
    }
    return bot.sendMessage(
      chatId,
      `When you're ready, enter your activation code to continue (for example: JB-XXXXXX).\n\nIf you don't have one, contact ${SUPPORT_EMAIL}.`
    );
  }

  const code = text.trim().toUpperCase();
  const result = activateCode(code, chatId, {
    firstName: msg.from.first_name,
    lastName: msg.from.last_name,
    username: msg.from.username
  });

  if (result.ok) {
    delete welcomedUsers[chatId];
    firstMessage[chatId] = false;
    if (ADMIN_CHAT_ID) {
      bot.sendMessage(ADMIN_CHAT_ID, `New user activated: ${msg.from.first_name} (@${msg.from.username || "—"}) | Code: ${code}`).catch(() => {});
    }
    return bot.sendMessage(chatId, activationSuccessMessage());
  }
  if (result.reason === "used") {
    return bot.sendMessage(chatId, `That code has already been used. Each code works for one account only.\n\nContact ${SUPPORT_EMAIL} if you need a new one.`);
  }
  return bot.sendMessage(chatId, `That code isn't valid. Please check it and try again, or contact ${SUPPORT_EMAIL} for help.`);
}

function gateAccess(msg) {
  const chatId = msg.chat.id;
  if (isBanned(chatId)) {
    bot.sendMessage(chatId, `Your access has been restricted. Contact ${SUPPORT_EMAIL}.`);
    return false;
  }
  if (!isAdmin(chatId) && !isActivated(chatId)) {
    const text = msg.text || msg.caption || "";
    handleActivationAttempt(msg, text || " ");
    return false;
  }
  return true;
}

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
    return bot.sendMessage(chatId, activationSuccessMessage());
  }

  welcomedUsers[chatId] = true;
  bot.sendMessage(chatId, welcomeMessage());
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

  if (!isAdmin(chatId) && !isActivated(chatId)) {
    return handleActivationAttempt(msg, text);
  }

  bot.sendChatAction(chatId, "typing");

  try {
    const intro = buildIntro(chatId);
    const reply = await chatText(chatId, intro + text);
    await sendLongMessage(chatId, reply);
  } catch (err) {
    console.error("Message error:", err.message);
    await bot.sendMessage(chatId, "Something went wrong on my end — please try again in a moment.");
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;

  saveUser(chatId, {
    firstName: msg.from.first_name,
    lastName: msg.from.last_name,
    username: msg.from.username
  });

  if (!gateAccess(msg)) return;

  bot.sendChatAction(chatId, "typing");
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const imageUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const intro = buildIntro(chatId);
    const prompt = intro + (msg.caption || "Please analyse this image in detail based on our conversation. Describe what you see and give helpful, specific feedback.");
    const reply = await chatVision(chatId, imageUrl, prompt);
    await sendLongMessage(chatId, reply);
  } catch (err) {
    console.error("Photo error:", err.message);
    await bot.sendMessage(chatId, "I couldn't read that image — could you try sending it again?");
  }
});

bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;

  saveUser(chatId, {
    firstName: msg.from.first_name,
    lastName: msg.from.last_name,
    username: msg.from.username
  });

  if (!gateAccess(msg)) return;

  const doc = msg.document;
  const fileName = doc.file_name || "file.bin";

  bot.sendChatAction(chatId, "typing");
  try {
    const file = await bot.getFile(doc.file_id);
    const buffer = await downloadTelegramFile(file.file_path);
    const extracted = await extractDocumentText(fileName, buffer);
    const intro = buildIntro(chatId);
    const userPrompt =
      intro +
      (msg.caption
        ? `${msg.caption}\n\n`
        : "Please read the following document carefully and give a detailed, helpful response based on our conversation.\n\n") +
      `File name: ${fileName}\n\n--- Document content ---\n${extracted}`;

    const reply = await chatText(chatId, userPrompt);
    await sendLongMessage(chatId, reply);
  } catch (err) {
    console.error("Document error:", err.message);
    if (err.message.startsWith("unsupported:")) {
      await bot.sendMessage(
        chatId,
        `I can't read that file type yet. Please send PDF, Word (.docx), Excel (.xlsx/.xls), or plain text files.\n\nYou can also paste the content as a message, or send a screenshot as an image.`
      );
    } else if (err.message === "empty") {
      await bot.sendMessage(chatId, "That file appears to be empty or I couldn't extract any text from it. Could you try a different format?");
    } else {
      await bot.sendMessage(chatId, "I had trouble reading that file — could you try sending it again or in a different format?");
    }
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

  if (req.method === "GET" && p === "/manifest.json") {
    return sendJSON(res, 200, {
      name: "Pathway Prep Admin",
      short_name: "PP Admin",
      description: "Manage activation codes and users",
      start_url: "/admin",
      display: "standalone",
      background_color: "#0c1220",
      theme_color: "#2563eb",
      orientation: "portrait"
    });
  }

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

  if (req.method === "GET" && p === "/health") {
    return sendJSON(res, 200, { status: "ok" });
  }

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
  const codeCount = Object.keys(loadCodes().codes).length;
  const userCount = Object.keys(loadUsers().users).length;
  console.log(`✅ Pathway Prep Bot is running!`);
  console.log(`✅ Admin panel: http://localhost:${PORT}/admin`);
  console.log(`📁 Data folder: ${DATA_DIR} (${codeCount} codes, ${userCount} users loaded)`);
}).on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${PORT} is already in use. Stop the other process or set a different PORT in .env\n`);
  } else {
    console.error("\n❌ Server failed to start:", err.message, "\n");
  }
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled error:", err.message || err);
});
