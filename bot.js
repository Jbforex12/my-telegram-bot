const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
require("dotenv").config();

// File parsers
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { createCanvas } = require("@napi-rs/canvas");
const mammoth = require("mammoth");
const XLSX = require("xlsx");

const BOT_NAME = "Pathway Prep Assistant";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;
const USERS_FILE = path.join(__dirname, "users.json");
const CODES_FILE = path.join(__dirname, "codes.json");
const SUPPORT_EMAIL = "support@pathwayprep.com";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "change-this-secret-key";
const ADMIN_API_PORT = process.env.ADMIN_API_PORT || 3001;

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Stores conversation history per user
const conversations = {};
const firstMessage = {};
const lastProcessedMessageId = {};
const userLocations = {};
const userLanguages = {};

// Tracks users currently in the activation flow (waiting for their code)
const pendingActivation = {};

// ─── Activation code management ───────────────────────────────────────────────

function loadCodes() {
  try {
    if (fs.existsSync(CODES_FILE)) {
      return JSON.parse(fs.readFileSync(CODES_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load codes file:", e.message);
  }
  return { codes: {} };
}

function saveCodes(data) {
  try {
    fs.writeFileSync(CODES_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save codes file:", e.message);
  }
}

function generateCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase(); // e.g. A3F9C2B1
}

function createActivationCode(note = "") {
  const data = loadCodes();
  let code;
  do {
    code = generateCode();
  } while (data.codes[code]);

  data.codes[code] = {
    code,
    createdAt: new Date().toISOString(),
    usedBy: null,
    usedAt: null,
    note: note || ""
  };
  saveCodes(data);
  return code;
}

function isCodeValid(code) {
  const data = loadCodes();
  const entry = data.codes[code.toUpperCase()];
  return entry && !entry.usedBy;
}

function activateCode(code, chatId, userInfo) {
  const data = loadCodes();
  const entry = data.codes[code.toUpperCase()];
  if (!entry || entry.usedBy) return false;
  entry.usedBy = String(chatId);
  entry.usedAt = new Date().toISOString();
  entry.userInfo = userInfo || {};
  saveCodes(data);
  return true;
}

function isUserActivated(chatId) {
  const data = loadCodes();
  return Object.values(data.codes).some(c => c.usedBy === String(chatId));
}

// ─── User management ──────────────────────────────────────────────────────────

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load users file:", e.message);
  }
  return { users: {}, banned: {} };
}

function saveUsers(data) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save users file:", e.message);
  }
}

function registerUser(msg) {
  const data = loadUsers();
  const id = String(msg.chat.id);
  const now = new Date().toISOString();

  if (!data.users[id]) {
    data.users[id] = {
      chatId: id,
      firstName: msg.chat.first_name || "",
      lastName: msg.chat.last_name || "",
      username: msg.chat.username ? "@" + msg.chat.username : "none",
      firstSeen: now,
      lastSeen: now,
      messageCount: 1
    };
  } else {
    data.users[id].lastSeen = now;
    data.users[id].messageCount = (data.users[id].messageCount || 0) + 1;
    data.users[id].firstName = msg.chat.first_name || data.users[id].firstName;
    data.users[id].lastName = msg.chat.last_name || data.users[id].lastName;
    if (msg.chat.username) data.users[id].username = "@" + msg.chat.username;
  }

  saveUsers(data);
}

function isUserBanned(chatId) {
  const data = loadUsers();
  return !!data.banned[String(chatId)];
}

function banUser(chatId, reason) {
  const data = loadUsers();
  const id = String(chatId);
  data.banned[id] = { reason: reason || "No reason given", bannedAt: new Date().toISOString() };
  saveUsers(data);
}

function unbanUser(chatId) {
  const data = loadUsers();
  delete data.banned[String(chatId)];
  saveUsers(data);
}

function isAdmin(chatId) {
  return ADMIN_CHAT_ID && String(chatId) === ADMIN_CHAT_ID;
}

const MAX_FILE_CHARS = 6000;

// ─── System prompt builder ────────────────────────────────────────────────────
function buildSystemPrompt(location, language) {
  const locationContext = location
    ? `The user is based in ${location}. When recommending resources, platforms, tools, job boards, certifications, or any opportunities — always tailor them specifically to ${location}. Mention locally relevant options first. If a resource is global but accessible, mention it after the local ones.`
    : `The user's location is not yet known. If they ask for resources, job boards, platforms, or opportunities, gently ask which country or city they are based in so you can give them the most relevant recommendations.`;

  const languageInstruction = language && language.toLowerCase() !== "english"
    ? `LANGUAGE — THIS IS YOUR TOP PRIORITY:\nThe user has requested to speak in ${language}. You MUST respond entirely in ${language} for the rest of this conversation. Every single reply must be in ${language} — do not switch back to English unless the user explicitly asks you to. If you are unsure how to say something in ${language}, do your best and keep going.`
    : `Respond in English unless the user requests a different language.`;

  return `
You are the Pathway Prep Assistant, a warm, intelligent and knowledgeable assistant built for Pathway Prep.

WHO YOU ARE — answer this clearly when asked "who are you", "what are you", or "are you an AI":

You are the Pathway Prep Assistant — a smart assistant built specifically for Pathway Prep to help people prepare for work and opportunities abroad. You are powered by AI, but you are not ChatGPT, Claude, or any other general AI tool. You were built to serve Pathway Prep users exclusively. You help with career preparation, skills building, workplace readiness, learning new topics, and anything else that supports someone's journey through the Pathway Prep programme.

ABOUT PATHWAY PREP — answer this when asked "what is Pathway Prep":

Pathway Prep is a programme designed to give individuals the knowledge, skills and confidence they need to prepare for work and opportunities abroad.

Whether someone is starting a new career, trying to understand what a job role involves, building professional skills, or simply growing their knowledge — Pathway Prep is here to support them every step of the way.

The programme covers areas like CV writing, interview preparation, workplace culture, communication skills, professional development, and more.

LOCATION-AWARE RECOMMENDATIONS:
${locationContext}

LANGUAGE:
${languageInstruction}

FILE AND DOCUMENT READING:
When a user shares a file or document, read and understand its contents fully. Use it to help them — whether that means reviewing a CV, summarising a document, explaining content, giving feedback, answering questions about it, or using it as learning material. Always acknowledge what the file is before responding. Be specific and refer to actual content from the file in your response.

ACCURACY — VERY IMPORTANT:
Only share information you are confident is correct. If you are unsure, say so honestly and redirect to the support team at ${SUPPORT_EMAIL}. Never guess or make up facts, figures, platforms, or details.

FORMATTING YOUR REPLIES — THIS IS CRITICAL, FOLLOW EXACTLY:
- Write in short paragraphs separated by a blank line between each one
- Never write more than 2 to 3 sentences in a single paragraph
- Never write a wall of text — break everything up
- Use plain text only. Absolutely no asterisks of any kind — not single (*), not double (**). Zero asterisks anywhere in your reply, ever.
- Do not use any other markdown symbols
- When listing things, always use a numbered list or bullet points — never dump them into a paragraph
- For numbered lists, format like this:

  1. First item
  2. Second item
  3. Third item

- For bullet lists, use a dash like this:

  - First item
  - Second item
  - Third item

- Always leave a blank line before and after any list
- Never begin a paragraph or sentence with an asterisk

REPLY STYLE:
- Do not end every reply with a question. Only ask a question when you genuinely need more information or it flows naturally. Most replies should help, explain, or respond — then stop.
- Keep replies focused and easy to read
- Never echo back what the user just said
- Never use corporate phrases like "certainly", "your request has been received", or "I have processed your query"
- When a user says "okay", "thanks", "bye", or signals they are done — respond briefly and warmly, then stop
- Always follow the user if they change topic
- When describing a photo, do it naturally — never open with "This image contains..."

TUTORING MODE:
If someone wants to learn something, become their tutor. Teach one concept at a time, use real-life examples, and build on what they know. Do not dump everything at once. Check understanding naturally every few exchanges.

TONE:
Warm, real, and human. Like a smart and supportive friend, not a customer service bot. Confident but never arrogant. Honest when you do not know something.

Always close conversations warmly, mentioning Pathway Prep by name.
`.trim();
}

// ─── Format reply ─────────────────────────────────────────────────────────────
function formatReply(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([.!?])\n(?!\n)/g, "$1\n\n")
    .trim();
}

// ─── Download a Telegram file to a temp path ──────────────────────────────────
async function downloadTelegramFile(fileId) {
  const fetch = (await import("node-fetch")).default;
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  const ext = path.extname(fileInfo.file_path) || "";
  const tmpPath = path.join(os.tmpdir(), `ppbot_${Date.now()}${ext}`);

  const res = await fetch(fileUrl);
  const buffer = await res.buffer();
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

// ─── Canvas factory for pdfjs-dist page rendering ────────────────────────────
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

// ─── Render scanned PDF pages to base64 images ────────────────────────────────
async function renderPDFPagesToImages(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const canvasFactory = new NodeCanvasFactory();
  const pdf = await pdfjsLib.getDocument({ data, canvasFactory }).promise;
  const images = [];
  const maxPages = Math.min(pdf.numPages, 4);

  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);

    await page.render({
      canvasContext: canvasAndContext.context,
      viewport,
      canvasFactory
    }).promise;

    const base64 = canvasAndContext.canvas.toDataURL("image/png").split(",")[1];
    images.push(base64);
    canvasFactory.destroy(canvasAndContext);
  }

  return { images, totalPages: pdf.numPages };
}

// ─── Extract text from a file based on its type ───────────────────────────────
async function extractTextFromFile(filePath, mimeType, fileName) {
  const ext = path.extname(fileName).toLowerCase();

  if (ext === ".pdf" || mimeType === "application/pdf") {
    try {
      const data = new Uint8Array(fs.readFileSync(filePath));
      const loadingTask = pdfjsLib.getDocument({ data });
      const pdf = await loadingTask.promise;

      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(" ");
        if (pageText.trim()) {
          fullText += `[Page ${i}]\n${pageText.trim()}\n\n`;
        }
      }

      const text = fullText.trim();
      if (!text) return { text: null, type: "PDF", scanned: true };
      return { text, type: "PDF" };
    } catch (err) {
      console.error("PDF parse error:", err.message);
      return { text: null, type: "PDF", error: err.message };
    }
  }

  if (ext === ".docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return { text: (result.value || "").trim(), type: "Word document" };
    } catch (err) {
      console.error("DOCX parse error:", err.message);
      return { text: null, type: "Word document", error: err.message };
    }
  }

  if (ext === ".xlsx" || ext === ".xls" || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    try {
      const workbook = XLSX.readFile(filePath);
      let allText = "";
      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        allText += `Sheet: ${sheetName}\n`;
        allText += XLSX.utils.sheet_to_csv(sheet) + "\n\n";
      });
      return { text: allText.trim(), type: "spreadsheet" };
    } catch (err) {
      console.error("XLSX parse error:", err.message);
      return { text: null, type: "spreadsheet", error: err.message };
    }
  }

  if (ext === ".csv" || mimeType === "text/csv") {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      return { text: text.trim(), type: "CSV file" };
    } catch (err) {
      return { text: null, type: "CSV file", error: err.message };
    }
  }

  const textExtensions = [".txt", ".md", ".js", ".py", ".json", ".html", ".css", ".ts", ".jsx", ".tsx", ".xml", ".yaml", ".yml", ".env"];
  if (textExtensions.includes(ext) || mimeType === "text/plain") {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      return { text: text.trim(), type: "text file" };
    } catch (err) {
      return { text: null, type: "text file", error: err.message };
    }
  }

  return null;
}

// ─── Detect location from text ────────────────────────────────────────────────
function detectLocationFromText(text) {
  const lower = text.toLowerCase();
  const triggers = ["i am in", "i'm in", "i live in", "i'm from", "i am from", "based in", "located in", "i stay in", "i reside in"];
  return triggers.some(trigger => lower.includes(trigger));
}

// ─── Detect language change request ──────────────────────────────────────────
function detectLanguageRequest(text) {
  const lower = text.toLowerCase();
  const triggers = [
    "speak", "talk", "respond", "reply", "write", "communicate",
    "change language", "switch language", "switch to", "change to",
    "in french", "in spanish", "in arabic", "in yoruba", "in igbo",
    "in hausa", "in portuguese", "in german", "in chinese", "in japanese",
    "in korean", "in italian", "in russian", "in hindi", "in swahili",
    "en français", "en español"
  ];
  const languageWords = [
    "french", "spanish", "arabic", "yoruba", "igbo", "hausa",
    "portuguese", "german", "chinese", "japanese", "korean",
    "italian", "russian", "hindi", "swahili", "english",
    "français", "español", "deutsch", "português", "italiano"
  ];
  return triggers.some(t => lower.includes(t)) && languageWords.some(l => lower.includes(l));
}

// ─── Admin: /gencode [note] — generate activation code ───────────────────────
bot.onText(/\/gencode(.*)/, function (msg, match) {
  if (!isAdmin(msg.chat.id)) return;
  const note = (match[1] || "").trim();
  const code = createActivationCode(note);
  bot.sendMessage(
    msg.chat.id,
    `New activation code generated:\n\n<code>${code}</code>\n\n${note ? "Note: " + note + "\n\n" : ""}This code can be used by exactly one Telegram account.`,
    { parse_mode: "HTML" }
  );
});

// ─── Admin: /codes — list all codes ─────────────────────────────────────────
bot.onText(/\/codes/, function (msg) {
  if (!isAdmin(msg.chat.id)) return;
  const data = loadCodes();
  const allCodes = Object.values(data.codes);
  if (allCodes.length === 0) {
    return bot.sendMessage(msg.chat.id, "No activation codes have been generated yet.\n\nUse /gencode to create one.");
  }

  const unused = allCodes.filter(c => !c.usedBy);
  const used = allCodes.filter(c => c.usedBy);

  let msg_text = `Activation Codes (${allCodes.length} total)\n`;
  msg_text += `Unused: ${unused.length} | Used: ${used.length}\n\n`;

  if (unused.length > 0) {
    msg_text += "UNUSED CODES:\n";
    unused.forEach(c => {
      msg_text += `• ${c.code}${c.note ? " — " + c.note : ""}\n  Created: ${new Date(c.createdAt).toLocaleString()}\n\n`;
    });
  }

  if (used.length > 0) {
    msg_text += "USED CODES:\n";
    used.forEach(c => {
      const userData = loadUsers().users[c.usedBy];
      const name = userData ? [userData.firstName, userData.lastName].filter(Boolean).join(" ") || "Unknown" : c.usedBy;
      msg_text += `• ${c.code} — used by ${name} (${c.usedBy})\n  Used: ${new Date(c.usedAt).toLocaleString()}\n\n`;
    });
  }

  bot.sendMessage(msg.chat.id, msg_text);
});

// ─── Admin: /users — list all users ─────────────────────────────────────────
bot.onText(/\/users/, function (msg) {
  if (!isAdmin(msg.chat.id)) return;
  const data = loadUsers();
  const userList = Object.values(data.users);
  if (userList.length === 0) {
    return bot.sendMessage(msg.chat.id, "No users have interacted with the bot yet.");
  }
  const lines = userList.map(function(u, i) {
    const banned = data.banned[u.chatId] ? " [BANNED]" : "";
    const activated = isUserActivated(u.chatId) ? " ✓" : " [NOT ACTIVATED]";
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "Unknown";
    return (i + 1) + ". " + name + " (" + u.username + ")" + banned + activated + "\n   ID: " + u.chatId + " | Messages: " + u.messageCount + "\n   Last seen: " + new Date(u.lastSeen).toLocaleString();
  });
  const header = "Users (" + userList.length + " total, " + Object.keys(data.banned).length + " banned):\n\n";

  let chunk = header;
  for (let i = 0; i < lines.length; i++) {
    if (chunk.length + lines[i].length > 3800) {
      bot.sendMessage(msg.chat.id, chunk);
      chunk = "";
    }
    chunk += lines[i] + "\n\n";
  }
  if (chunk.trim()) bot.sendMessage(msg.chat.id, chunk);
});

// ─── Admin: /ban <chatId> [reason] ───────────────────────────────────────────
bot.onText(/\/ban (.+)/, function (msg, match) {
  if (!isAdmin(msg.chat.id)) return;
  const parts = match[1].trim().split(" ");
  const targetId = parts[0];
  const reason = parts.slice(1).join(" ") || "No reason given";
  if (!targetId || isNaN(targetId)) {
    return bot.sendMessage(msg.chat.id, "Usage: /ban <chatId> [reason]\nExample: /ban 123456789 spamming");
  }
  banUser(targetId, reason);
  bot.sendMessage(msg.chat.id, "User " + targetId + " has been banned.\nReason: " + reason);
  bot.sendMessage(targetId, "Your access to this bot has been restricted. If you believe this is a mistake, contact " + SUPPORT_EMAIL + ".").catch(function() {});
});

// ─── Admin: /unban <chatId> ───────────────────────────────────────────────────
bot.onText(/\/unban (.+)/, function (msg, match) {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = match[1].trim();
  if (!targetId || isNaN(targetId)) {
    return bot.sendMessage(msg.chat.id, "Usage: /unban <chatId>\nExample: /unban 123456789");
  }
  unbanUser(targetId);
  bot.sendMessage(msg.chat.id, "User " + targetId + " has been unbanned and can use the bot again.");
  bot.sendMessage(targetId, "Your access to this bot has been restored. Welcome back!").catch(function() {});
});

// ─── Admin: /userinfo <chatId> ────────────────────────────────────────────────
bot.onText(/\/userinfo (.+)/, function (msg, match) {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = match[1].trim();
  const data = loadUsers();
  const user = data.users[targetId];
  if (!user) {
    return bot.sendMessage(msg.chat.id, "No user found with ID: " + targetId);
  }
  const banned = data.banned[targetId];
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown";
  const activated = isUserActivated(targetId);
  const codesData = loadCodes();
  const userCode = Object.values(codesData.codes).find(c => c.usedBy === targetId);

  var infoLines = [];
  infoLines.push("User Info");
  infoLines.push("");
  infoLines.push("Name: " + name);
  infoLines.push("Username: " + user.username);
  infoLines.push("Chat ID: " + user.chatId);
  infoLines.push("Messages sent: " + user.messageCount);
  infoLines.push("First seen: " + new Date(user.firstSeen).toLocaleString());
  infoLines.push("Last seen: " + new Date(user.lastSeen).toLocaleString());
  infoLines.push("");
  infoLines.push("Activation: " + (activated ? "ACTIVATED (code: " + userCode.code + ")" : "NOT ACTIVATED"));
  if (banned) {
    infoLines.push("");
    infoLines.push("Status: BANNED");
    infoLines.push("Ban reason: " + banned.reason);
    infoLines.push("Banned at: " + new Date(banned.bannedAt).toLocaleString());
  } else {
    infoLines.push("Status: Active");
  }
  bot.sendMessage(msg.chat.id, infoLines.join("\n"));
});

// ─── /start command ───────────────────────────────────────────────────────────
bot.onText(/\/start/, function (msg) {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  firstMessage[chatId] = true;

  // Check if user is banned
  if (isUserBanned(chatId)) {
    return bot.sendMessage(chatId, "Your access to this bot has been restricted. If you believe this is a mistake, contact " + SUPPORT_EMAIL + ".");
  }

  // Check if already activated
  if (isUserActivated(chatId)) {
    return bot.sendMessage(
      chatId,
      `Hello! I'm the ${BOT_NAME} 👋\n\nI'm here to help you build the knowledge, skills and confidence you need to prepare for work and opportunities abroad.\n\nYou can chat with me, ask questions, or even send me a file — like your CV, a document, or a spreadsheet — and I'll read it and help you from there.\n\nHow can I help you today?`
    );
  }

  // New user — require activation
  pendingActivation[chatId] = true;
  bot.sendMessage(
    chatId,
    `Welcome to the ${BOT_NAME}! 👋\n\nTo access this service, you need an activation code.\n\nPlease type your activation code now to get started.`
  );
});

// ─── /activate command ────────────────────────────────────────────────────────
bot.onText(/\/activate (.+)/, function (msg, match) {
  const chatId = msg.chat.id;
  const code = match[1].trim().toUpperCase();
  handleActivationAttempt(chatId, msg, code);
});

// ─── Handle activation code submission ────────────────────────────────────────
function handleActivationAttempt(chatId, msg, code) {
  if (isUserBanned(chatId)) {
    return bot.sendMessage(chatId, "Your access to this bot has been restricted. Contact " + SUPPORT_EMAIL + ".");
  }

  if (isUserActivated(chatId)) {
    delete pendingActivation[chatId];
    return bot.sendMessage(chatId, "Your account is already activated. How can I help you today?");
  }

  const data = loadCodes();
  const entry = data.codes[code];

  if (!entry) {
    return bot.sendMessage(chatId, "That code isn't valid. Please check it and try again, or contact support at " + SUPPORT_EMAIL + ".");
  }

  if (entry.usedBy && entry.usedBy !== String(chatId)) {
    return bot.sendMessage(chatId, "That code has already been used by another account. Each activation code works for one account only.\n\nContact " + SUPPORT_EMAIL + " if you need a new code.");
  }

  // Activate the user
  const userInfo = {
    firstName: msg.chat.first_name || "",
    lastName: msg.chat.last_name || "",
    username: msg.chat.username ? "@" + msg.chat.username : "none"
  };

  activateCode(code, chatId, userInfo);
  registerUser(msg);
  delete pendingActivation[chatId];

  // Notify admin
  if (ADMIN_CHAT_ID) {
    const name = [userInfo.firstName, userInfo.lastName].filter(Boolean).join(" ") || "Unknown";
    bot.sendMessage(
      ADMIN_CHAT_ID,
      `New user activated!\n\nName: ${name}\nUsername: ${userInfo.username}\nChat ID: ${chatId}\nCode used: ${code}`
    ).catch(() => {});
  }

  conversations[chatId] = [];
  firstMessage[chatId] = true;

  bot.sendMessage(
    chatId,
    `Your code has been accepted — welcome to Pathway Prep! 🎉\n\nI'm the ${BOT_NAME}, and I'm here to help you build the skills and confidence you need to prepare for work and opportunities abroad.\n\nYou can chat with me, ask questions, or send files like your CV or documents.\n\nHow can I help you today?`
  );
}

// ─── /forget command ──────────────────────────────────────────────────────────
bot.onText(/\/forget/, function (msg) {
  const chatId = msg.chat.id;
  if (!isUserActivated(chatId) && !isAdmin(chatId)) return;
  conversations[chatId] = [];
  firstMessage[chatId] = true;
  bot.sendMessage(chatId, "Done — I've cleared our conversation history.\n\nHow can I help you today?");
});

// ─── /location command ────────────────────────────────────────────────────────
bot.onText(/\/location/, function (msg) {
  const chatId = msg.chat.id;
  if (!isUserActivated(chatId) && !isAdmin(chatId)) return;
  const current = userLocations[chatId];
  if (current) {
    bot.sendMessage(chatId, `Your current location is set to: ${current}\n\nYou can update it anytime by telling me where you are or sharing your location.`);
  } else {
    bot.sendMessage(chatId, "I don't have your location saved yet.\n\nYou can share it by typing something like \"I'm based in Lagos, Nigeria\" or by using the attachment button to share your location.");
  }
});

// ─── /lang command ────────────────────────────────────────────────────────────
bot.onText(/\/lang/, function (msg) {
  const chatId = msg.chat.id;
  if (!isUserActivated(chatId) && !isAdmin(chatId)) return;
  const current = userLanguages[chatId] || "English";
  bot.sendMessage(
    chatId,
    `Your current language is set to: ${current}\n\nTo change it, just say something like "speak to me in French" or "switch to Spanish" and I will switch right away.`
  );
});

// ─── Handle shared GPS location ───────────────────────────────────────────────
bot.on("location", async function (msg) {
  const chatId = msg.chat.id;

  if (isUserBanned(chatId)) return;
  if (!isUserActivated(chatId) && !isAdmin(chatId)) return;

  const { latitude, longitude } = msg.location;

  try {
    const fetch = (await import("node-fetch")).default;
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
      { headers: { "User-Agent": "PathwayPrepBot/1.0" } }
    );
    const geoData = await geoRes.json();
    const city = geoData.address.city || geoData.address.town || geoData.address.village || "";
    const country = geoData.address.country || "";
    const locationLabel = city ? `${city}, ${country}` : country;

    if (locationLabel) {
      userLocations[chatId] = locationLabel;
      bot.sendMessage(chatId, `Got it — I've noted that you're in ${locationLabel}.\n\nFrom now on I'll tailor any recommendations and resources to your location.`);
    } else {
      bot.sendMessage(chatId, "I received your location but couldn't read the details. You can also just type your city or country and I'll save it.");
    }
  } catch (err) {
    console.error("Geocoding error:", err);
    bot.sendMessage(chatId, "I got your pin but had trouble reading the location. You can just type your city or country and I'll save it.");
  }
});

// ─── Handle document/file uploads ─────────────────────────────────────────────
bot.on("document", async function (msg) {
  const chatId = msg.chat.id;

  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;

  registerUser(msg);
  if (isUserBanned(chatId)) {
    return bot.sendMessage(chatId, "Your access to this bot has been restricted. If you believe this is a mistake, contact " + SUPPORT_EMAIL + ".");
  }

  if (!isUserActivated(chatId) && !isAdmin(chatId)) {
    pendingActivation[chatId] = true;
    return bot.sendMessage(chatId, "You need an activation code to use this service.\n\nPlease type your activation code to get started.");
  }

  bot.sendChatAction(chatId, "typing");

  const doc = msg.document;
  const fileName = doc.file_name || "uploaded_file";
  const mimeType = doc.mime_type || "";
  const caption = msg.caption || "";

  if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
    return bot.sendMessage(chatId, "That file is a bit too large for me to read — could you try sending something under 20MB?");
  }

  let tmpPath = null;

  try {
    await bot.sendMessage(chatId, `Got it — reading your ${fileName} now...`);

    tmpPath = await downloadTelegramFile(doc.file_id);
    const extracted = await extractTextFromFile(tmpPath, mimeType, fileName);

    if (!extracted) {
      return bot.sendMessage(
        chatId,
        `I don't support that file type yet.\n\nHere's what I can read:\n\n- PDF\n- Word documents (.docx)\n- Excel spreadsheets (.xlsx, .xls)\n- CSV files\n- Plain text files (.txt, .md, .js, .py, .json, etc.)\n\nCould you try converting it to one of those?`
      );
    }

    if (extracted.scanned) {
      await bot.sendMessage(chatId, "This looks like a scanned document. Let me take a look at it visually...");
      bot.sendChatAction(chatId, "typing");

      try {
        const { images, totalPages } = await renderPDFPagesToImages(tmpPath);
        const prompt = buildSystemPrompt(userLocations[chatId] || null, userLanguages[chatId] || null);
        const userCaption = caption || "Please read this document carefully and tell me what it contains. Then ask how I can help.";

        const contentParts = images.map(b64 => ({
          type: "image_url",
          image_url: { url: "data:image/png;base64," + b64 }
        }));
        contentParts.push({ type: "text", text: userCaption });

        const visionResponse = await groq.chat.completions.create({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          max_tokens: 1024,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: contentParts }
          ]
        });

        const rawReply = visionResponse.choices[0].message.content;
        const reply = formatReply(rawReply);

        if (!conversations[chatId]) conversations[chatId] = [];
        conversations[chatId].push({ role: "assistant", content: reply });

        const pageNote = totalPages > 4 ? "\n\n(Note: I read the first 4 pages of " + totalPages + " total)" : "";
        return bot.sendMessage(chatId, reply + pageNote);

      } catch (visionErr) {
        console.error("Scanned PDF vision error:", visionErr.message);
        return bot.sendMessage(
          chatId,
          "I could see the document is scanned but had trouble reading the contents visually. Could you try sending a clearer scan or a text-based version?"
        );
      }
    }

    if (!extracted.text) {
      return bot.sendMessage(
        chatId,
        `I received your ${extracted.type} but had trouble reading the content inside it. This sometimes happens with protected or unusual file formats.\n\nCould you try saving it as a plain .txt or .docx file and sending that instead?`
      );
    }

    const fileContent = extracted.text.length > MAX_FILE_CHARS
      ? extracted.text.substring(0, MAX_FILE_CHARS) + "\n\n[File content trimmed to fit — only the first portion was read]"
      : extracted.text;

    if (!conversations[chatId]) conversations[chatId] = [];

    const userMessage = caption
      ? `The user has shared a ${extracted.type} called "${fileName}". Here is its content:\n\n${fileContent}\n\nThe user's message about this file: ${caption}`
      : `The user has shared a ${extracted.type} called "${fileName}". Here is its content:\n\n${fileContent}\n\nPlease acknowledge the file, summarise what it contains briefly, and ask the user how they would like you to help with it.`;

    conversations[chatId].push({ role: "user", content: userMessage });

    const prompt = buildSystemPrompt(userLocations[chatId] || null, userLanguages[chatId] || null);

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [
        { role: "system", content: prompt },
        ...conversations[chatId]
      ]
    });

    const rawReply = response.choices[0].message.content;
    const reply = formatReply(rawReply);

    conversations[chatId].push({ role: "assistant", content: reply });

    if (conversations[chatId].length > 30) {
      conversations[chatId] = conversations[chatId].slice(-30);
    }

    await bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error("Document handler error:", err);
    await bot.sendMessage(chatId, "I had trouble reading that file — could you try again or send it in a different format?");
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  }
});

// ─── Handle text messages ─────────────────────────────────────────────────────
bot.on("message", async function (msg) {
  const chatId = msg.chat.id;
  const userText = msg.text;

  if (!userText || userText.startsWith("/")) return;

  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;

  registerUser(msg);

  if (isUserBanned(chatId)) {
    return bot.sendMessage(chatId, "Your access to this bot has been restricted. If you believe this is a mistake, contact " + SUPPORT_EMAIL + ".");
  }

  // If user is in activation flow, treat any text as potential activation code
  if (pendingActivation[chatId] || (!isUserActivated(chatId) && !isAdmin(chatId))) {
    pendingActivation[chatId] = true;
    const potentialCode = userText.trim().toUpperCase();
    // Try it as an activation code
    const data = loadCodes();
    const entry = data.codes[potentialCode];

    if (entry) {
      return handleActivationAttempt(chatId, msg, potentialCode);
    } else {
      return bot.sendMessage(
        chatId,
        "To use this service, you need a valid activation code.\n\nPlease enter your code — it looks something like A3F9C2B1.\n\nIf you don't have one, contact " + SUPPORT_EMAIL + " to get access."
      );
    }
  }

  // Detect location mention
  if (detectLocationFromText(userText)) {
    try {
      const extractRes = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        max_tokens: 50,
        messages: [
          { role: "system", content: "Extract only the city and/or country from the user's message. Reply with just the location, e.g. 'Lagos, Nigeria' or 'London, UK'. Nothing else." },
          { role: "user", content: userText }
        ]
      });
      const extractedLocation = extractRes.choices[0].message.content.trim();
      if (extractedLocation) userLocations[chatId] = extractedLocation;
    } catch (e) {
      console.error("Location extraction error:", e);
    }
  }

  // Detect language change request
  if (detectLanguageRequest(userText)) {
    try {
      const langRes = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        max_tokens: 20,
        messages: [
          {
            role: "system",
            content: "Extract only the language name from the user's message. Reply with just the language name in English, e.g. 'French', 'Spanish', 'Yoruba', 'Arabic', 'English'. Nothing else. One word only."
          },
          { role: "user", content: userText }
        ]
      });
      const detectedLang = langRes.choices[0].message.content.trim();
      if (detectedLang) {
        userLanguages[chatId] = detectedLang;
        console.log("Language set to " + detectedLang + " for chat " + chatId);
      }
    } catch (e) {
      console.error("Language extraction error:", e);
    }
  }

  bot.sendChatAction(chatId, "typing");

  if (!conversations[chatId]) conversations[chatId] = [];

  let intro = "";
  if (!firstMessage[chatId]) {
    firstMessage[chatId] = true;
    intro = `[The user has opened the chat without using /start. Greet them briefly and warmly as ${BOT_NAME}, then respond to their message naturally. Do not ask "How can I help you?" if they have already asked something.]\n\n`;
  }

  conversations[chatId].push({ role: "user", content: intro + userText });

  try {
    const prompt = buildSystemPrompt(userLocations[chatId] || null, userLanguages[chatId] || null);

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [
        { role: "system", content: prompt },
        ...conversations[chatId]
      ]
    });

    const rawReply = response.choices[0].message.content;
    const reply = formatReply(rawReply);

    conversations[chatId].push({ role: "assistant", content: reply });

    if (conversations[chatId].length > 30) {
      conversations[chatId] = conversations[chatId].slice(-30);
    }

    await bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error("Text message error:", err);
    await bot.sendMessage(chatId, "Something went wrong on my end — please try again in a moment.");
  }
});

// ─── Handle images/photos ─────────────────────────────────────────────────────
bot.on("photo", async function (msg) {
  const chatId = msg.chat.id;

  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;

  registerUser(msg);
  if (isUserBanned(chatId)) {
    return bot.sendMessage(chatId, "Your access to this bot has been restricted. If you believe this is a mistake, contact " + SUPPORT_EMAIL + ".");
  }

  if (!isUserActivated(chatId) && !isAdmin(chatId)) {
    pendingActivation[chatId] = true;
    return bot.sendMessage(chatId, "You need an activation code to use this service.\n\nPlease type your activation code to get started.");
  }

  bot.sendChatAction(chatId, "typing");

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const prompt = buildSystemPrompt(userLocations[chatId] || null, userLanguages[chatId] || null);

    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 1024,
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: msg.caption || "What do you see here?" }
          ]
        }
      ]
    });

    const rawReply = response.choices[0].message.content;
    const reply = formatReply(rawReply);

    if (!conversations[chatId]) conversations[chatId] = [];
    conversations[chatId].push({ role: "assistant", content: reply });

    await bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error("Photo handler error:", err);
    await bot.sendMessage(chatId, "I couldn't read that image — could you try sending it again?");
  }
});

// ─── Admin HTTP API Server ────────────────────────────────────────────────────
// This powers the admin website. Protect with ADMIN_API_KEY in your .env

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (e) { resolve({}); }
    });
    req.on("error", reject);
  });
}

const apiServer = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
    });
    return res.end();
  }

  // Check API key
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== ADMIN_API_KEY) {
    return sendJSON(res, 401, { error: "Unauthorized" });
  }

  const url = new URL(req.url, `http://localhost:${ADMIN_API_PORT}`);
  const pathname = url.pathname;

  // GET /api/users
  if (req.method === "GET" && pathname === "/api/users") {
    const usersData = loadUsers();
    const codesData = loadCodes();
    const users = Object.values(usersData.users).map(u => {
      const code = Object.values(codesData.codes).find(c => c.usedBy === u.chatId);
      return {
        ...u,
        activated: !!code,
        activationCode: code ? code.code : null,
        banned: !!usersData.banned[u.chatId],
        banReason: usersData.banned[u.chatId] ? usersData.banned[u.chatId].reason : null
      };
    });
    return sendJSON(res, 200, { users });
  }

  // GET /api/codes
  if (req.method === "GET" && pathname === "/api/codes") {
    const data = loadCodes();
    const usersData = loadUsers();
    const codes = Object.values(data.codes).map(c => {
      const user = c.usedBy ? usersData.users[c.usedBy] : null;
      return {
        ...c,
        userName: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown" : null,
        userUsername: user ? user.username : null
      };
    });
    return sendJSON(res, 200, { codes });
  }

  // POST /api/codes/generate
  if (req.method === "POST" && pathname === "/api/codes/generate") {
    const body = await parseBody(req);
    const count = Math.min(parseInt(body.count) || 1, 50);
    const note = body.note || "";
    const generated = [];
    for (let i = 0; i < count; i++) {
      generated.push(createActivationCode(note));
    }
    return sendJSON(res, 200, { codes: generated });
  }

  // DELETE /api/codes/:code
  if (req.method === "DELETE" && pathname.startsWith("/api/codes/")) {
    const code = pathname.split("/api/codes/")[1].toUpperCase();
    const data = loadCodes();
    if (!data.codes[code]) return sendJSON(res, 404, { error: "Code not found" });
    if (data.codes[code].usedBy) return sendJSON(res, 400, { error: "Cannot delete a code that has already been used" });
    delete data.codes[code];
    saveCodes(data);
    return sendJSON(res, 200, { success: true });
  }

  // POST /api/users/:id/ban
  if (req.method === "POST" && pathname.match(/^\/api\/users\/\d+\/ban$/)) {
    const id = pathname.split("/")[3];
    const body = await parseBody(req);
    banUser(id, body.reason || "Blocked via admin panel");
    // Notify user
    bot.sendMessage(id, "Your access to this bot has been restricted. If you believe this is a mistake, contact " + SUPPORT_EMAIL + ".").catch(() => {});
    return sendJSON(res, 200, { success: true });
  }

  // POST /api/users/:id/unban
  if (req.method === "POST" && pathname.match(/^\/api\/users\/\d+\/unban$/)) {
    const id = pathname.split("/")[3];
    unbanUser(id);
    bot.sendMessage(id, "Your access to this bot has been restored. Welcome back!").catch(() => {});
    return sendJSON(res, 200, { success: true });
  }

  // GET /api/stats
  if (req.method === "GET" && pathname === "/api/stats") {
    const usersData = loadUsers();
    const codesData = loadCodes();
    const allCodes = Object.values(codesData.codes);
    return sendJSON(res, 200, {
      totalUsers: Object.keys(usersData.users).length,
      bannedUsers: Object.keys(usersData.banned).length,
      totalCodes: allCodes.length,
      usedCodes: allCodes.filter(c => c.usedBy).length,
      unusedCodes: allCodes.filter(c => !c.usedBy).length
    });
  }

  return sendJSON(res, 404, { error: "Not found" });
});

apiServer.listen(ADMIN_API_PORT, () => {
  console.log(`Admin API running on port ${ADMIN_API_PORT}`);
});

console.log("✅Bot is running...");
