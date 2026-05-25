const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
require("dotenv").config();

function env(name) {
  let v = (process.env[name] || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

// ─── Config ────────────────────────────────────────────────────────────────
const BOT_NAME = "Pathway Prep Assistant";
const SUPPORT_EMAIL = "pathway.prep.programme@gmail.com";
const ADMIN_CHAT_ID = env("ADMIN_CHAT_ID") || null;
const ADMIN_API_KEY = env("ADMIN_API_KEY") || "change-this-key";
const PORT = Number(process.env.PORT) || 3001;

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const base = __dirname;
  if (process.platform === "win32" && /\\System32\\|\\SysWOW64\\/i.test(base)) {
    const dir = path.join(process.env.APPDATA || os.homedir(), "pathway-prep-bot");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    for (const name of ["users.json", "codes.json"]) {
      const src = path.join(base, name);
      const dst = path.join(dir, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); } catch { /* ignore */ }
      }
    }
    console.log(`Using writable data folder: ${dir}`);
    return dir;
  }
  return base;
}

const DATA_DIR = resolveDataDir();
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CODES_FILE = path.join(DATA_DIR, "codes.json");
const TEXT_MODEL = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_TOKENS = 2048;
const MAX_HISTORY = 24;
const MAX_DOC_CHARS = 14000;
const MAX_IMAGES_PER_USER_PER_DAY = 5;
const MAX_PDFS_PER_USER_PER_DAY = 5;
const POLLINATIONS_MIN_GAP_MS = 16000; // free tier ~1 request per 15s

function hasImageGen() {
  return env("IMAGE_GEN") !== "false";
}

let lastPollinationsAt = 0;

function requireEnv() {
  const placeholders = [
    "your_telegram_bot_token_here",
    "your_groq_api_key_here",
    "your_telegram_chat_id_here",
    "change-this-to-a-strong-secret-key"
  ];
  const missing = [];
  const token = env("TELEGRAM_BOT_TOKEN");
  const groqKey = env("GROQ_API_KEY");
  if (!token || placeholders.includes(token)) missing.push("TELEGRAM_BOT_TOKEN");
  if (!groqKey || placeholders.includes(groqKey)) missing.push("GROQ_API_KEY");
  if (missing.length) {
    console.error("\n❌ Bot cannot start — missing environment variables:\n");
    missing.forEach((key) => console.error(`   • ${key}`));
    console.error("\nSet these in Railway → Variables (no extra quotes), then Redeploy.\n");
    process.exit(1);
  }
  console.log(`Env OK — PORT=${PORT}, token length=${token.length}, groq length=${groqKey.length}`);
  if (hasImageGen()) console.log("Image generation: enabled (Pollinations.ai — free, no API key)");
  else console.log("Image generation: disabled (IMAGE_GEN=false)");
  console.log("PDF generation: enabled");
}
requireEnv();

// ─── Data helpers ──────────────────────────────────────────────────────────
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

function countRecords(file, data) {
  if (file === CODES_FILE) return Object.keys((data.codes || {})).length;
  if (file === USERS_FILE) return Object.keys((data.users || {})).length;
  return 0;
}

function saveJSON(file, data, opts = {}) {
  ensureDataDir();
  try {
    if ((file === CODES_FILE || file === USERS_FILE) && !opts.allowEmpty) {
      const count = countRecords(file, data);
      if (count === 0 && fs.existsSync(file)) {
        try {
          const existing = JSON.parse(fs.readFileSync(file, "utf8"));
          if (countRecords(file, existing) > 0) {
            console.error(`Refused to save empty ${path.basename(file)} over existing records`);
            return;
          }
        } catch (e) { /* proceed if unreadable */ }
      }
    }
    const tmp = file + ".tmp";
    const backup = file + ".bak";
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, backup); } catch { /* backup optional if folder is read-only */ }
    }
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

function mergeCodes(into, from) {
  if (!from?.codes) return into;
  for (const [key, entry] of Object.entries(from.codes)) {
    const normalized = key.toUpperCase();
    const existing = into.codes[normalized];
    if (!existing) {
      into.codes[normalized] = entry;
      continue;
    }
    if (entry.usedAt && !existing.usedAt) into.codes[normalized] = entry;
  }
  return into;
}

function mergeUsers(into, from) {
  if (!from?.users) return into;
  for (const [id, user] of Object.entries(from.users)) {
    if (!into.users[id]) into.users[id] = user;
  }
  if (from.banned) {
    into.banned = into.banned || {};
    for (const [id, ban] of Object.entries(from.banned)) {
      if (!into.banned[id]) into.banned[id] = ban;
    }
  }
  return into;
}

function readJSONFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Could not read ${file}:`, e.message);
    return null;
  }
}

function migrateLegacyData() {
  ensureDataDir();
  const legacyFiles = [
    path.join(__dirname, "codes.json"),
    path.join(__dirname, "users.json"),
    path.join(__dirname, "data", "codes.json"),
    path.join(__dirname, "data", "users.json")
  ];

  let codes = readJSONFile(CODES_FILE) || { codes: {} };
  let users = readJSONFile(USERS_FILE) || { users: {}, banned: {} };
  if (!codes.codes) codes.codes = {};
  if (!users.users) users.users = {};
  if (!users.banned) users.banned = {};

  let merged = false;
  for (const file of legacyFiles) {
    if (path.resolve(file) === path.resolve(CODES_FILE) || path.resolve(file) === path.resolve(USERS_FILE)) continue;
    const data = readJSONFile(file);
    if (!data) continue;
    if (file.includes("codes.json")) {
      const before = Object.keys(codes.codes).length;
      codes = mergeCodes(codes, data);
      if (Object.keys(codes.codes).length > before) {
        console.log(`Merged codes from ${file}`);
        merged = true;
      }
    } else if (file.includes("users.json")) {
      const before = Object.keys(users.users).length;
      users = mergeUsers(users, data);
      if (Object.keys(users.users).length > before) {
        console.log(`Merged users from ${file}`);
        merged = true;
      }
    }
  }

  if (merged) {
    saveJSON(CODES_FILE, codes, { allowEmpty: true });
    saveJSON(USERS_FILE, users, { allowEmpty: true });
  }

  const marker = path.join(DATA_DIR, ".storage-ready");
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, new Date().toISOString());
    if (process.env.DATA_DIR && Object.keys(codes.codes).length === 0) {
      console.warn(
        "⚠️  Persistent storage is empty. On Render: open your service → Disks → confirm 'bot-data' is mounted at /var/data, then redeploy."
      );
    }
  }
}

migrateLegacyData();

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
    `I can help with career guidance, CV and interview prep, workplace skills, learning new topics, and I can send you real PDF files (CVs, cover letters) and generated images when you need them.\n\n` +
    `To get started, please enter your activation code (for example: JB-XXXXXX).\n\n` +
    `If you don't have one, contact ${SUPPORT_EMAIL} to get access.`
  );
}

function activationSuccessMessage() {
  return (
    `You're in! Welcome to ${BOT_NAME} 🎉\n\n` +
    `I'm your personal learning and career assistant for Pathway Prep.\n\n` +
    `You can ask questions, request a PDF (e.g. "give me a sample CV as a PDF"), request an image (e.g. "generate an image explaining…"), or send me files to review.\n\n` +
    `How can I help you today?`
  );
}

// ─── Reply formatting ──────────────────────────────────────────────────────
function formatReply(text) {
  if (!text) return text;
  let out = text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/([^\n])\n(•|\d+\.)/g, "$1\n\n$2")
    .replace(/(•[^\n]*|^\d+\.[^\n]*)\n([^•\n\d])/gm, "$1\n\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
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
const token = env("TELEGRAM_BOT_TOKEN");
let bot;
let groq;

function initTelegramBot() {
  console.log("Starting Telegram polling…");
  bot = new TelegramBot(token, { polling: true });
  groq = new Groq({ apiKey: env("GROQ_API_KEY") });

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
- When the user asks for a generated illustration or diagram to understand a concept, the system may create one for them — after it is sent, briefly explain what it shows and how it helps their learning
- When the user asks for a PDF file (CV, resume, cover letter, study guide), the system generates and sends a real PDF in the chat — never tell them to copy text into Word or that you cannot create PDFs
- FILE CREATION — CRITICAL: You CAN deliver PDF documents and illustration images directly in Telegram. Never say you are unable to generate PDFs, images, or files. For a PDF, users can say "give me a CV as a PDF" or use /pdf. For an image, say "generate an image explaining…" or use /image
- If a topic is outside Pathway Prep's scope or you genuinely don't know, say: "That's a great question — the support team would be best placed to help you with that. You can reach them at ${SUPPORT_EMAIL}"

QUALITY OF ANSWERS — VERY IMPORTANT:
- Never give generic, surface-level, or cliché responses. Phrases like "I've always been passionate about helping others" or "I'm a team player" are weak and meaningless — never produce them
- Every answer must feel specific, credible, and well-reasoned — the kind of answer that makes an interviewer or reader pause and think "that's a good point"
- When giving example interview answers, make them sound like a real, thoughtful person speaking — grounded, specific, and confident. Not a template
- For interview prep, always explain the thinking behind the answer: what the interviewer is really looking for, why this answer works, and what to avoid saying
- Use real-world knowledge, frameworks, and insight — for example, use the STAR method (Situation, Task, Action, Result) when relevant to structure experience-based answers
- When listing questions and answers, give a sharp, well-constructed example answer followed by a brief coaching note on why it lands well
- Never pad responses. Every sentence should earn its place

RESPONSE LENGTH:
- Keep responses detailed and substantive, but never padded — every sentence must add real value
- For simple questions, 2–4 tight paragraphs is ideal
- For bigger topics (e.g. "give me interview questions and answers"), go deeper — cover the topic properly with enough detail to be genuinely useful, but stop as soon as you've said what matters
- Never add filler sentences, summaries of what you just said, or unnecessary sign-offs at the end of a detailed answer

REPLY STYLE — VERY IMPORTANT:
- Write in a professional, polished tone with generous visual spacing — never let text feel cramped or compressed
- Always put a blank line between every paragraph, and between every list item
- For unordered lists, use the bullet character • at the start of each line
- For ordered or step-by-step lists, use numbers: 1. 2. 3.
- Never use asterisks (*), dashes (-), or any markdown symbols as list markers or for emphasis
- Structure longer answers with a short opening line, then clearly spaced sections, then a warm close
- Do NOT end every reply with a question. Only ask when you genuinely need more information
- Never echo back what the user just said
- Never use robotic or corporate phrases
- Never expose technical language to the user
- When a user says "okay", "thanks", "bye", or signals the conversation is ending — respond warmly and briefly, then stop
- Always follow the user's lead if they change topic

CLARIFYING vs ANSWERING — VERY IMPORTANT:
- If your response needs to both clarify something and answer a question, weave them together naturally — do not use labels like "To clarify:" or "To answer:"
- Handle the clarification first in plain flowing language, then move straight into the answer without signposting the transition
- The response should read as one coherent, intelligent reply — not a form or a template

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

async function chatText(chatId, userText) {
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

const imageGenDaily = {};

function userWantsGeneratedImage(text) {
  const t = text.toLowerCase();
  const patterns = [
    /\b(generate|create|make|draw|produce|design|build)\s+(an?\s+)?(image|picture|diagram|illustration|visual|infographic|chart)/,
    /\b(show|give)\s+me\s+(an?\s+)?(image|picture|diagram|illustration|visual)/,
    /\b(can you|could you|please)\s+(generate|create|make|draw|show|give).{0,40}(image|picture|diagram|illustration|visual)/,
    /\b(visuali[sz]e|illustrate)\b/,
    /\bexplain\b.{0,50}\b(with\s+)?(an?\s+)?(image|diagram|illustration|picture)\b/,
    /\b(image|diagram|illustration|picture)\s+(of|showing|for|about|explaining)\b/,
    /\bhelp me understand\b.{0,40}\b(visually|with a (picture|diagram|image))\b/
  ];
  return patterns.some((p) => p.test(t));
}

function imageGenLimitReached(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = imageGenDaily[chatId];
  if (!entry || entry.date !== today) return false;
  return entry.count >= MAX_IMAGES_PER_USER_PER_DAY;
}

function recordImageGen(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  if (!imageGenDaily[chatId] || imageGenDaily[chatId].date !== today) {
    imageGenDaily[chatId] = { date: today, count: 0 };
  }
  imageGenDaily[chatId].count += 1;
}

async function craftImagePrompt(userRequest) {
  const response = await groq.chat.completions.create({
    model: TEXT_MODEL,
    max_tokens: 400,
    messages: [
      {
        role: "system",
        content:
          "You write prompts for AI educational illustrations for Pathway Prep learners. " +
          "Output ONLY the image prompt text — no quotes, no preamble. " +
          "Style: clear friendly educational diagram or infographic, labeled parts, simple icons, clean layout, " +
          "high contrast, professional learning material. No copyrighted characters or brand logos. " +
          "Minimize embedded text in the image (icons and arrows preferred)."
      },
      { role: "user", content: userRequest }
    ]
  });
  return response.choices[0].message.content.trim().slice(0, 4000);
}

async function waitForPollinationsSlot() {
  const elapsed = Date.now() - lastPollinationsAt;
  const wait = POLLINATIONS_MIN_GAP_MS - elapsed;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastPollinationsAt = Date.now();
}

async function generateImageBuffer(prompt) {
  await waitForPollinationsSlot();
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    "?width=1024&height=1024&model=flux&nologo=true&enhance=true";
  const res = await fetch(url, {
    headers: { "User-Agent": "PathwayPrepBot/1.0" },
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Pollinations ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error("Invalid or empty image response");
  return buf;
}

const pdfGenDaily = {};

function userWantsGeneratedPdf(text) {
  const t = text.toLowerCase();
  const patterns = [
    /\b(pdf|\.pdf)\b/,
    /\b(as|in|into)\s+(a\s+)?pdf\b/,
    /\b(generate|create|make|write|send|give|export|download|produce)\b.{0,40}\b(pdf|document|file)\b/,
    /\b(cv|resume|curriculum vitae|cover letter)\b.{0,40}\b(pdf|file|document)\b/,
    /\b(pdf|file|document)\b.{0,40}\b(cv|resume|cover letter)\b/,
    /\bgive me\b.{0,50}\b(cv|resume)\b/
  ];
  return patterns.some((p) => p.test(t));
}

function pdfGenLimitReached(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = pdfGenDaily[chatId];
  if (!entry || entry.date !== today) return false;
  return entry.count >= MAX_PDFS_PER_USER_PER_DAY;
}

function recordPdfGen(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  if (!pdfGenDaily[chatId] || pdfGenDaily[chatId].date !== today) {
    pdfGenDaily[chatId] = { date: today, count: 0 };
  }
  pdfGenDaily[chatId].count += 1;
}

function pdfFilename(userText) {
  const t = userText.toLowerCase();
  const stamp = Date.now();
  if (/cover letter/.test(t)) return `Cover-Letter-${stamp}.pdf`;
  if (/cv|resume|curriculum/.test(t)) return `CV-${stamp}.pdf`;
  return `Pathway-Prep-Document-${stamp}.pdf`;
}

async function craftDocumentForPdf(userRequest) {
  const response = await groq.chat.completions.create({
    model: TEXT_MODEL,
    max_tokens: 3000,
    messages: [
      {
        role: "system",
        content:
          "You write complete professional documents for PDF export: CVs, resumes, cover letters, and study guides. " +
          "Output ONLY the document body in plain text. No markdown symbols (no *, #, -, **). " +
          "Put section titles on their own line (e.g. EDUCATION, WORK EXPERIENCE, or Contact:). " +
          "Use blank lines between sections. Use realistic fictional details when the user asks for sample or random information. " +
          "CVs must include: full name at top, contact, professional summary, work experience with dates, education, skills."
      },
      { role: "user", content: userRequest }
    ]
  });
  let body = response.choices[0].message.content.trim();
  body = body.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").replace(/^[-*]\s+/gm, "• ");
  const t = userRequest.toLowerCase();
  let title = "Document";
  if (/cv|resume|curriculum/.test(t)) title = "Curriculum Vitae";
  else if (/cover letter/.test(t)) title = "Cover Letter";
  return { title, body };
}

function buildPdfBuffer(title, bodyText) {
  const PDFDocument = require("pdfkit");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).text(title, { align: "center" });
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(11);

    for (const rawLine of bodyText.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        doc.moveDown(0.35);
        continue;
      }
      const isHeading =
        line.length < 70 &&
        (/^[A-Z][A-Z0-9\s&',.\-/]{2,}$/.test(line) ||
          /^[A-Za-z][A-Za-z0-9\s]{0,50}:$/.test(line) ||
          /^(curriculum vitae|resume|cover letter|professional summary|work experience|education|skills|contact|objective)$/i.test(line));
      if (isHeading) {
        doc.moveDown(0.4).font("Helvetica-Bold").fontSize(12).text(line);
        doc.font("Helvetica").fontSize(11);
      } else {
        doc.text(line, { lineGap: 2 });
        doc.moveDown(0.15);
      }
    }
    doc.end();
  });
}

async function handlePdfGenerationRequest(chatId, userText) {
  if (pdfGenLimitReached(chatId)) {
    return bot.sendMessage(
      chatId,
      `You've reached today's limit of ${MAX_PDFS_PER_USER_PER_DAY} PDF documents. Try again tomorrow, or ask for help in text.`
    );
  }

  await bot.sendChatAction(chatId, "upload_document");
  const statusMsg = await bot.sendMessage(chatId, "Creating your PDF — this may take a moment…");

  try {
    const { title, body } = await craftDocumentForPdf(userText);
    const pdfBuffer = await buildPdfBuffer(title, body);
    recordPdfGen(chatId);

    const history = getHistory(chatId);
    history.push({ role: "user", content: userText });
    history.push({
      role: "assistant",
      content: `[Sent PDF: ${pdfFilename(userText)}] Here is your ${title}. Open the file above — you can download and edit it as needed.`
    });
    trimHistory(chatId);

    const filename = pdfFilename(userText);
    await bot.sendDocument(chatId, pdfBuffer, { caption: `Your ${title} from Pathway Prep` }, { filename });
    await bot.sendMessage(
      chatId,
      "Your PDF is attached above. You can download it, share it, or open it in any PDF reader. Tell me if you'd like changes."
    );
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
  } catch (err) {
    console.error("PDF generation error:", err.message);
    await bot.editMessageText(
      "I couldn't create that PDF right now — please try again in a moment.",
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {
      bot.sendMessage(chatId, "I couldn't create that PDF right now — please try again in a moment.");
    });
  }
}

async function handleImageGenerationRequest(chatId, userText) {
  if (!hasImageGen()) {
    return bot.sendMessage(chatId, "Illustrations are turned off on this bot right now.");
  }
  if (imageGenLimitReached(chatId)) {
    return bot.sendMessage(
      chatId,
      `You've reached today's limit of ${MAX_IMAGES_PER_USER_PER_DAY} generated illustrations. Try again tomorrow, or ask in text — I'm still here to help.`
    );
  }

  await bot.sendChatAction(chatId, "upload_photo");
  const statusMsg = await bot.sendMessage(chatId, "Creating an educational illustration for you — this may take 20–45 seconds…");

  try {
    const imagePrompt = await craftImagePrompt(userText);
    const imageBuffer = await generateImageBuffer(imagePrompt);
    recordImageGen(chatId);

    const history = getHistory(chatId);
    history.push({ role: "user", content: userText });

    const explanation = await groq.chat.completions.create({
      model: TEXT_MODEL,
      max_tokens: 600,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        {
          role: "user",
          content:
            "I just received an educational illustration you created for me. In 2–4 short paragraphs, explain what the image is meant to show and how it helps me understand the topic. Do not say you cannot create images."
        }
      ]
    });
    const caption = formatReply(explanation.choices[0].message.content);
    history.push({ role: "assistant", content: `[Sent illustration] ${caption}` });
    trimHistory(chatId);

    await bot.sendPhoto(chatId, imageBuffer, { caption: caption.slice(0, 1024) });
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
  } catch (err) {
    console.error("Image generation error:", err.message);
    await bot.editMessageText(
      "I couldn't create that illustration right now — please try again in a moment or describe what you need in words.",
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {
      bot.sendMessage(chatId, "I couldn't create that illustration right now — please try again in a moment.");
    });
  }
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

bot.onText(/\/pdf(?:@\w+)?(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!gateAccess(msg)) return;
  const topic = (match[1] || "").trim();
  if (!topic) {
    return bot.sendMessage(
      chatId,
      "Usage: /pdf [what to create]\n\nExample:\n/pdf sample CV for a marketing graduate with fictional details"
    );
  }
  await handlePdfGenerationRequest(chatId, `Create a PDF document: ${topic}`);
});

bot.onText(/\/image(?:@\w+)?(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!gateAccess(msg)) return;
  const topic = (match[1] || "").trim();
  if (!topic) {
    return bot.sendMessage(
      chatId,
      "Usage: /image [topic to illustrate]\n\nExample:\n/image how the STAR method works in interviews"
    );
  }
  await handleImageGenerationRequest(chatId, `Generate an educational illustration explaining: ${topic}`);
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

  try {
    if (userWantsGeneratedPdf(text)) {
      return handlePdfGenerationRequest(chatId, text);
    }
    if (userWantsGeneratedImage(text)) {
      return handleImageGenerationRequest(chatId, text);
    }

    bot.sendChatAction(chatId, "typing");
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

} // initTelegramBot

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
    return sendJSON(res, 200, {
      status: "ok",
      uptime: Math.floor(process.uptime()),
      dataDir: DATA_DIR
    });
  }

  const apiKey = (req.headers["x-api-key"] || "").trim();
  if (apiKey !== ADMIN_API_KEY) return sendJSON(res, 401, { error: "Unauthorized" });

  if (req.method === "GET" && p === "/api/stats") {
    const u = loadUsers(); const c = loadCodes();
    const all = Object.values(c.codes);
    return sendJSON(res, 200, {
      totalUsers: Object.keys(u.users).length,
      bannedUsers: Object.keys(u.banned).length,
      totalCodes: all.length,
      usedCodes: all.filter(x => x.usedBy).length,
      unusedCodes: all.filter(x => !x.usedBy).length,
      dataDir: DATA_DIR
    });
  }

  if (req.method === "GET" && p === "/api/backup") {
    const u = loadUsers();
    const c = loadCodes();
    return sendJSON(res, 200, {
      exportedAt: new Date().toISOString(),
      dataDir: DATA_DIR,
      codes: c,
      users: u
    });
  }

  if (req.method === "POST" && p === "/api/restore") {
    const body = await parseBody(req);
    let codes = loadCodes();
    let users = loadUsers();
    if (body.codes) codes = mergeCodes(codes, body.codes);
    if (body.users) users = mergeUsers(users, body.users);
    saveJSON(CODES_FILE, codes, { allowEmpty: true });
    saveJSON(USERS_FILE, users, { allowEmpty: true });
    return sendJSON(res, 200, {
      success: true,
      totalCodes: Object.keys(codes.codes).length,
      totalUsers: Object.keys(users.users).length
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

const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_URL =
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

server.listen(PORT, HOST, () => {
  initTelegramBot();
  const codeCount = Object.keys(loadCodes().codes).length;
  const userCount = Object.keys(loadUsers().users).length;
  console.log(`✅ HTTP server listening on ${HOST}:${PORT}`);
  console.log(`✅ Pathway Prep Bot is running!`);
  console.log(`✅ Admin panel: http://localhost:${PORT}/admin`);
  if (PUBLIC_URL) console.log(`✅ Public admin: ${PUBLIC_URL}/admin`);
  console.log(`📁 Data folder: ${DATA_DIR} (${codeCount} codes, ${userCount} users loaded)`);

  if (PUBLIC_URL) {
    setInterval(() => {
      https.get(`${PUBLIC_URL}/health`, (res) => {
        console.log(`Keepalive ping: ${res.statusCode}`);
      }).on("error", (err) => {
        console.error("Keepalive ping failed:", err.message);
      });
    }, 10 * 60 * 1000);
  }
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
