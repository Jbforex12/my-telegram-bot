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
const MAX_FILES_PER_USER_PER_DAY = 8;
const SUPPORTED_FILE_FORMATS = ["pdf", "docx", "txt", "md", "xlsx", "csv", "html"];
const CHAT_TEMPERATURE = 0.65;
const CHAT_TOP_P = 0.9;
// Image generation (Pollinations) is opt-in only — default off; documents + vision analysis are supported
const POLLINATIONS_MIN_GAP_MS = 16000;
const IMAGE_GEN_MODEL = env("IMAGE_GEN_MODEL") || "turbo";
const IMAGE_GEN_MAX_ATTEMPTS = 2;
const MAX_IMAGES_PER_USER_PER_DAY = 5;

function hasImageGen() {
  return env("IMAGE_GEN") === "true";
}

function groqChatParams(extra = {}) {
  return { temperature: CHAT_TEMPERATURE, top_p: CHAT_TOP_P, ...extra };
}

let lastPollinationsAt = 0;

const ENV_PLACEHOLDERS = [
  "your_telegram_bot_token_here",
  "your_groq_api_key_here",
  "your_telegram_chat_id_here",
  "change-this-to-a-strong-secret-key"
];

function getMissingRequiredEnv() {
  const missing = [];
  const token = env("TELEGRAM_BOT_TOKEN");
  const groqKey = env("GROQ_API_KEY");
  if (!token || ENV_PLACEHOLDERS.includes(token)) missing.push("TELEGRAM_BOT_TOKEN");
  if (!groqKey || ENV_PLACEHOLDERS.includes(groqKey)) missing.push("GROQ_API_KEY");
  return missing;
}

let botReady = false;

function logEnvStatus() {
  const missing = getMissingRequiredEnv();
  if (missing.length) {
    console.error("\n❌ Missing required environment variables:\n");
    missing.forEach((key) => console.error(`   • ${key}`));
    console.error("\nRender → your service → Environment → add them (no quotes), then Manual Deploy.\n");
    console.error("HTTP server is up for /health — Telegram will start after variables are set.\n");
    return false;
  }
  const token = env("TELEGRAM_BOT_TOKEN");
  const groqKey = env("GROQ_API_KEY");
  console.log(`Env OK — PORT=${PORT}, token length=${token.length}, groq length=${groqKey.length}`);
  if (hasImageGen()) console.log("Image generation: enabled (IMAGE_GEN=true — Pollinations.ai)");
  else console.log("Image generation: off — PDF/Word/Excel exports and photo analysis only");
  console.log(`File export: ${SUPPORTED_FILE_FORMATS.join(", ")}`);
  return true;
}

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
    `I can help with career guidance, CV and interview prep, workplace skills, learning new topics, and I can send you real files (PDF, Word, Excel, text, and more) plus images when you need them.\n\n` +
    `To get started, please enter your activation code (for example: JB-XXXXXX).\n\n` +
    `If you don't have one, contact ${SUPPORT_EMAIL} to get access.`
  );
}

function activationSuccessMessage() {
  return (
    `You're in! Welcome to ${BOT_NAME} 🎉\n\n` +
    `I'm your personal learning and career assistant for Pathway Prep.\n\n` +
    `You can ask questions, request files (PDF, Word, etc.), send course screenshots to learn the page like a tutor, or upload documents to review.\n\n` +
    `How can I help you today?`
  );
}

// ─── Reply formatting ──────────────────────────────────────────────────────
function escapeTelegramHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** True if a numbered line is a short section heading, not a long explanatory step */
function isNumberedHeadingLine(line) {
  const m = line.trim().match(/^\d+\.\s+(.+)$/);
  if (!m) return false;
  const body = m[1].trim();
  if (body.length > 72) return false;
  if ((body.match(/\.\s/g) || []).length >= 2) return false;
  return true;
}

/** Section titles only — used for bold + spacing (not Tip/Example labels) */
function isSectionHeadingLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s+/.test(trimmed)) return true;
  return isNumberedHeadingLine(line);
}

/** Sans-serif bold Unicode — Telegram has no font-size; this reads slightly larger than body text */
function toHeadingDisplayText(text) {
  const SANS_BOLD_A = 0x1d5d4;
  const SANS_BOLD_a = 0x1d5ee;
  const SANS_BOLD_0 = 0x1d7ec;
  return String(text).replace(/[A-Za-z0-9]/g, (ch) => {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) return String.fromCodePoint(SANS_BOLD_A + (c - 65));
    if (c >= 97 && c <= 122) return String.fromCodePoint(SANS_BOLD_a + (c - 97));
    if (c >= 48 && c <= 57) return String.fromCodePoint(SANS_BOLD_0 + (c - 48));
    return ch;
  });
}

function formatSectionHeadingHtml(trimmed) {
  const hash = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (hash) return escapeTelegramHtml(toHeadingDisplayText(hash[1].trim()));

  const numbered = trimmed.match(/^(\d+\.\s+)(.+)$/);
  if (numbered) {
    return (
      escapeTelegramHtml(numbered[1]) +
      escapeTelegramHtml(toHeadingDisplayText(numbered[2].trim()))
    );
  }

  return escapeTelegramHtml(toHeadingDisplayText(trimmed));
}

function formatLineForTelegramHtml(line) {
  const trimmed = line.trim();
  if (!trimmed) return "";

  if (/^#{1,6}\s+/.test(trimmed) || isNumberedHeadingLine(line)) {
    return formatSectionHeadingHtml(trimmed);
  }

  const label = trimmed.match(
    /^(Example|Tip|Warning|Common mistake|Why this matters):\s*(.*)$/i
  );
  if (label) {
    const rest = label[2] ? escapeTelegramHtml(label[2]) : "";
    return `<b>${escapeTelegramHtml(label[1] + ":")}</b>${rest ? " " + rest : ""}`;
  }

  return escapeTelegramHtml(line);
}

function toTelegramHtml(plain) {
  const lines = plain.split("\n");
  const out = [];
  for (const line of lines) {
    if (isSectionHeadingLine(line) && out.length > 0 && out[out.length - 1] !== "") {
      out.push("");
    }
    out.push(formatLineForTelegramHtml(line));
  }
  return out.join("\n");
}

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
  out = out.replace(
    /\n+(Best|Kind|Warm) regards[,!]?\s*\n+.*Pathway Prep[^\n]*\s*$/i,
    ""
  ).replace(/\n+Pathway Prep wishes you[^\n]*\s*$/i, "").trim();
  out = out.replace(
    /^(This (is )?(a |an )?(screenshot|image|photo|infographic|picture)|I can see (a |an )?(screenshot|image))[^.!?]*[.!?]\s*/i,
    ""
  ).trim();
  return out;
}

async function sendTelegramFormatted(chatId, plain) {
  const html = toTelegramHtml(plain);
  try {
    await bot.sendMessage(chatId, html, { parse_mode: "HTML" });
  } catch (err) {
    console.error("HTML send failed, using plain text:", err.message);
    await bot.sendMessage(chatId, plain);
  }
}

async function sendLongMessage(chatId, text) {
  const plain = formatReply(text);
  if (plain.length <= 4000) {
    await sendTelegramFormatted(chatId, plain);
    return;
  }
  const parts = [];
  let remaining = plain;
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
    if (part) await sendTelegramFormatted(chatId, part);
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

let polling409Retries = 0;
let polling409Retrying = false;

async function initTelegramBot() {
  if (!logEnvStatus()) return;
  bot = new TelegramBot(token, { polling: false });
  groq = new Groq({ apiKey: env("GROQ_API_KEY") });
  try {
    await bot.deleteWebHook({ drop_pending_updates: false });
  } catch (err) {
    console.error("deleteWebHook warning:", err.message);
  }
  const isCloud = !!(
    process.env.RENDER ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PUBLIC_DOMAIN
  );
  if (isCloud) {
    console.log("Cloud deploy: waiting 12s before polling (previous instance must release Telegram)…");
    await new Promise((r) => setTimeout(r, 12000));
  }
  console.log("Starting Telegram polling…");
  await bot.startPolling({ restart: false });
  botReady = true;

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
- When the user sends a photo, analyse only what is visible and answer their exact question — never invent details that are not in the image
- When the user sends a document, read it carefully and respond in the context of the conversation with specific, actionable feedback
- You do NOT generate pictures or illustrations. For diagrams, charts, or layouts, the system sends PDF, Word, Excel, or similar files — never offer to draw or generate an image
- When the user asks for a file (PDF, Word, Excel, text, etc.), the system generates and sends a real downloadable file — never tell them to copy text into Word or that you cannot create files
- FILE CREATION — CRITICAL: You CAN deliver files in these formats: PDF, Word (docx), Excel (xlsx), CSV, plain text (txt), Markdown (md), HTML. Never say you cannot create files. Examples: "CV as a Word document", "give me a PDF resume", "create an Excel file with…", /file docx [topic], /file pdf [topic]
- If a topic is outside Pathway Prep's scope or you genuinely don't know, say: "That's a great question — the support team would be best placed to help you with that. You can reach them at ${SUPPORT_EMAIL}"

REASONING — VERY IMPORTANT:
- Think through what the user really needs before you write: their goal, what a strong answer must include, and the clearest order to explain it
- For "why" and "how" questions, show cause and effect, trade-offs, and what good looks like in real workplaces — not just definitions
- For interview or career questions: state what the interviewer is evaluating, give a concrete example answer, then explain why it works and what to avoid
- Use frameworks when they help (e.g. STAR for experience stories) and apply them to the user's situation, not as abstract theory
- If the question is slightly ambiguous, answer the most likely Pathway Prep intent and weave in one brief natural assumption — never use labels like "Assumption:"

QUALITY OF ANSWERS — VERY IMPORTANT:
- Never give generic, surface-level, or cliché responses. Phrases like "I've always been passionate about helping others" or "I'm a team player" are weak and meaningless — never produce them
- Every answer must feel specific, credible, and well-reasoned — the kind of answer that makes an interviewer or reader pause and think "that's a good point"
- When giving example interview answers, make them sound like a real, thoughtful person speaking — grounded, specific, and confident. Not a template
- When listing questions and answers, give a sharp, well-constructed example answer followed by a brief coaching note on why it lands well
- Never pad responses. Every sentence should earn its place

RESPONSE LENGTH:
- Keep responses detailed and substantive, but never padded — every sentence must add real value
- For simple questions, 2–4 tight paragraphs is ideal
- For bigger topics (e.g. "give me interview questions and answers"), go deeper — cover the topic properly with enough detail to be genuinely useful, but stop as soon as you've said what matters
- Never add filler sentences, summaries of what you just said, or unnecessary sign-offs at the end of a detailed answer

WRITING RULES — VERY IMPORTANT:
1. Structure explanations with numbered sections (1. 2. 3.) and clear headings or subheadings for each main idea
2. Add practical real-life examples frequently — every major explanation needs at least one example or scenario
3. After explaining a concept, cover why it matters, common mistakes, and possible consequences when relevant
4. Avoid walls of text — short paragraphs (2–4 lines), blank lines between sections
5. Use bullet character • whenever listing items, steps, tools, rules, or warnings
6. For processes: step-by-step numbered steps; for each procedure explain what to do, what not to do, and why
7. Sound human and conversational — vary sentence patterns; never robotic or repetitive
8. Break difficult ideas into smaller parts; do not rush
9. Beginner-friendly language unless they ask for advanced depth
10. Use teaching labels on their own line when helpful: Example: / Tip: / Warning: / Common mistake: / Why this matters:
11. Mini summaries after important sections when the topic is long
12. Natural training-manual flow — structured hierarchy (titles, numbering, spacing, bullets, examples), not one continuous dump
13. Never use # or markdown for bold or headings — no asterisks (*). Write titles on their own line or as numbered lines; the bot applies bold automatically in Telegram
14. Never use dashes (-) as list markers — use • bullets only

REPLY STYLE:
- Generous spacing between every paragraph and list item
- End on useful content, not formulaic sign-offs
- Do NOT end every reply with a question unless offering quiz/move-on after a lesson
- Never echo back what the user just said
- Never expose technical language to the user
- When a user says "okay", "thanks", "bye" — respond warmly and briefly, then stop

CLOSINGS — CRITICAL:
- Do NOT sign off routine answers with "Best regards", "Kind regards", "Warm regards", or similar letter-style endings
- Do NOT end every message by naming Pathway Prep, wishing them well on their journey, or adding a branded footer
- Most replies should simply finish when the answer is complete — no extra goodbye paragraph
- Only add a brief warm sign-off when the user is clearly ending the chat (thanks, bye, that's all) — one short line is enough, and skip "Best regards" unless they asked for a formal letter or email draft
- If you mention Pathway Prep at the end, do so at most rarely — not on every reply

CLARIFYING vs ANSWERING:
- Weave clarifications into the answer naturally — no "To clarify:" or "To answer:" labels (teaching labels like Example: and Tip: are fine)

TUTORING MODE:
- Follow WRITING RULES: numbered sections, headings, bullets, examples, Tip/Warning labels
- Teach like a real instructor: "you," "let's," plain English — never "this screenshot shows"
- For follow-ups on a lesson page in chat, continue with the same structure — do not ask them to resend the image

TONE:
- Warm, human, encouraging and real
- Like a smart, supportive friend who genuinely wants to help — not a customer service bot or email template
- Honest when you don't know something
`.trim();

const lessonScreenshotGuide = `
LESSON PAGE MODE (training pages, slides, manuals, module screens):
Professional training manual by a real instructor — warm, conversational, highly structured.

VOICE AND OPENING:
- Never say screenshot, image, infographic, or mobile device. Open with the topic naturally, e.g. "Alright, this one is about washing and ironing properly. Let's work through it."
- Use "you," "let's," "notice," "here's the thing." Vary how you start each reply. Beginner-friendly English. No sign-offs.

STRUCTURE (follow WRITING RULES strictly):
- Numbered main sections (1. 2. 3.) with clear headings on their own line — never use # symbols; headings are auto-bold in Telegram
- Subheadings inside long sections. Blank line between every block
- Short paragraphs only. Bullet • for every list of items, steps, tools, rules, or warnings
- Step-by-step for procedures: what to do, what not to do, why — use numbered steps
- After key concepts: Why this matters, Common mistake, possible consequences (use those labels on their own line)
- Sprinkle Example: Tip: Warning: where they help. At least one real-life example or scenario in every major section
- Mini summary after important sections if the page is long
- Group many steps into staged sections (e.g. 1. Preparing  2. Washing  3. Drying) — do not rush or dump everything at once
- Do not repeat the page verbatim — explain, expand, teach

CONTENT:
- Read all visible text, tables, captions, diagrams (describe diagrams in plain speech)
- Diagrams: what they show and how they fit the lesson
- Safety and red flags: use Warning: so they stand out
- Definitions: simple words first, then formal term if on the page
- Numbers/dosages: what they mean and why they matter in practice

CLOSING:
- One-line wrap-up: the single must-remember point
- Then: "Want me to quiz you on this, or shall we move on?" Quiz = one question at a time

FOLLOW-UPS:
- Same page, no resend — use chat history. Re-teach in smaller parts if confused

OTHER PHOTOS (CV, interview, job ad):
- Shorter, career-focused, still structured with bullets/examples where useful
`.trim();

const visionSystemPrompt = `${systemPrompt}

${lessonScreenshotGuide}
`.trim();

const VISION_MAX_TOKENS = 3500;

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
    ...groqChatParams(),
    messages: [
      { role: "system", content: systemPrompt },
      ...history
    ]
  });

  const reply = formatReply(response.choices[0].message.content);
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

async function parseImageRequest(userRequest) {
  const response = await groq.chat.completions.create({
    model: TEXT_MODEL,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You interpret what illustration a Pathway Prep user wants. Reply with JSON only:\n" +
          '{"subject":"exact topic in 5-15 words","visual_type":"diagram|infographic|process_flow|scene|comparison_chart",' +
          '"elements":["3-6 concrete things that MUST appear visually"],"avoid":["things that must NOT appear"]}\n' +
          "Rules: Stay faithful to the user message. If they ask about CVs, interviews, or careers — show that, not random animals. " +
          "If the request is vague, pick the most likely career-learning visual. Never invent unrelated creatures or surreal subjects."
      },
      { role: "user", content: userRequest }
    ]
  });
  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return {
      subject: userRequest.slice(0, 120),
      visual_type: "infographic",
      elements: [userRequest.slice(0, 80)],
      avoid: ["surreal art", "random animals", "distorted bodies", "gore", "wireframe overlays"]
    };
  }
}

function buildStrictImagePrompt(brief) {
  const elements = Array.isArray(brief.elements) ? brief.elements.join(", ") : "";
  const avoidList = [
    "surreal",
    "random animals",
    "mutant creatures",
    "distorted anatomy",
    "gore",
    "blood",
    "blueprint mesh",
    "wireframe overlay",
    "circuit lines on animals",
    "unrelated subject matter",
    ...(Array.isArray(brief.avoid) ? brief.avoid : [])
  ];
  const avoid = [...new Set(avoidList)].join(", ");
  return [
    "Professional flat educational infographic illustration for adult learners",
    `Main topic: ${brief.subject || "career skills"}`,
    `Layout type: ${brief.visual_type || "diagram"}`,
    elements ? `The image must clearly show: ${elements}` : "",
    "Style: clean white background, simple vector icons, soft blue and grey accents, clear composition, textbook quality, no clutter",
    "No photorealistic wildlife unless the topic explicitly requires an animal",
    `Strictly avoid: ${avoid}`
  ]
    .filter(Boolean)
    .join(". ")
    .slice(0, 3800);
}

async function craftImagePrompt(userRequest) {
  const brief = await parseImageRequest(userRequest);
  return { prompt: buildStrictImagePrompt(brief), brief };
}

async function waitForPollinationsSlot() {
  const elapsed = Date.now() - lastPollinationsAt;
  const wait = POLLINATIONS_MIN_GAP_MS - elapsed;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastPollinationsAt = Date.now();
}

async function generateImageBuffer(prompt, seed) {
  await waitForPollinationsSlot();
  const params = new URLSearchParams({
    width: "1024",
    height: "768",
    model: IMAGE_GEN_MODEL,
    nologo: "true",
    enhance: "false"
  });
  if (seed != null) params.set("seed", String(seed));
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
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

async function validateImageMatchesRequest(imageBuffer, userRequest, brief) {
  const b64 = imageBuffer.toString("base64");
  const response = await groq.chat.completions.create({
    model: VISION_MODEL,
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          {
            type: "text",
            text:
              `The user asked for an illustration about: "${userRequest}".\n` +
              `Expected topic: ${brief.subject}\n` +
              `Expected elements: ${(brief.elements || []).join(", ")}\n\n` +
              'Does this image clearly match that request for education (not random/surreal/off-topic)? Reply JSON only: {"ok":true} or {"ok":false,"problem":"short reason"}'
          }
        ]
      }
    ]
  });
  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return { ok: true };
  }
}

async function generateImageForRequest(userRequest) {
  const { prompt: basePrompt, brief } = await craftImagePrompt(userRequest);
  let lastBuffer = null;
  let prompt = basePrompt;
  const seed = Math.floor(Math.random() * 999999);

  for (let attempt = 1; attempt <= IMAGE_GEN_MAX_ATTEMPTS; attempt++) {
    lastBuffer = await generateImageBuffer(prompt, attempt === 1 ? seed : seed + attempt);
    const check = await validateImageMatchesRequest(lastBuffer, userRequest, brief);
    if (check.ok) return { buffer: lastBuffer, brief, prompt };
    if (attempt < IMAGE_GEN_MAX_ATTEMPTS) {
      console.log(`Image retry ${attempt + 1}: ${check.problem || "off-topic"}`);
      prompt =
        basePrompt +
        `. IMPORTANT correction: previous attempt failed because ${check.problem || "off-topic"}. ` +
        `Show ONLY: ${(brief.elements || []).join(", ")}. Topic: ${brief.subject}.`;
    }
  }
  return { buffer: lastBuffer, brief, prompt };
}

async function describeGeneratedImage(imageBuffer, userRequest, brief) {
  const b64 = imageBuffer.toString("base64");
  const response = await groq.chat.completions.create({
    model: VISION_MODEL,
    max_tokens: 500,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          {
            type: "text",
            text:
              `The user asked for: "${userRequest}". I sent them this illustration about "${brief.subject}". ` +
              "Describe what this image actually shows in 2–3 short paragraphs and how it helps them learn. " +
              "Be accurate to what is in the image — do not invent animals or objects that are not there."
          }
        ]
      }
    ]
  });
  return formatReply(response.choices[0].message.content);
}

const fileGenDaily = {};

function userWantsGeneratedFile(text) {
  const t = text.toLowerCase();
  if (detectRequestedFileFormat(text)) return true;
  const patterns = [
    /\b(pdf|docx|\.docx|\.doc|word|excel|xlsx|\.xlsx|csv|\.csv|\.txt|\.md|\.html)\b/,
    /\b(word document|microsoft word|ms word|spreadsheet)\b/,
    /\b(as|in|into)\s+(a\s+)?(pdf|word|docx|doc|excel|file|document)\b/,
    /\b(generate|create|make|write|send|give|export|download|produce|build)\b.{0,50}\b(pdf|file|document|docx|word|excel)\b/,
    /\b(cv|resume|curriculum vitae|cover letter)\b.{0,40}\b(pdf|file|document|word|docx)\b/,
    /\b(file|document)\b.{0,40}\b(cv|resume|cover letter)\b/,
    /\bgive me\b.{0,50}\b(cv|resume)\b/
  ];
  return patterns.some((p) => p.test(t));
}

function detectRequestedFileFormat(text) {
  const t = text.toLowerCase();
  const rules = [
    [/\b(docx|\.docx|word document|microsoft word|ms word|as word|in word|word format|word file)\b/, "docx"],
    [/\b\.doc\b|as doc\b|in doc\b/, "docx"],
    [/\b(pdf|\.pdf|pdf format|pdf form|as pdf|in pdf)\b/, "pdf"],
    [/\b(xlsx|\.xlsx|excel file|excel format|spreadsheet|as excel|in excel)\b/, "xlsx"],
    [/\b(csv|\.csv|csv file)\b/, "csv"],
    [/\b(\.md|markdown file|as markdown)\b/, "md"],
    [/\b(\.txt|text file|plain text file|as text file)\b/, "txt"],
    [/\b(\.html|html file|as html)\b/, "html"]
  ];
  for (const [re, fmt] of rules) {
    if (re.test(t)) return fmt;
  }
  if (/\b(file|document)\b/.test(t) && /\bword\b/.test(t)) return "docx";
  return null;
}

function defaultFileFormat(userText) {
  const t = userText.toLowerCase();
  if (/excel|spreadsheet|table|rows|columns/.test(t)) return "xlsx";
  if (/word|docx|\.doc\b/.test(t)) return "docx";
  if (/cv|resume|cover letter/.test(t)) return "pdf";
  return "docx";
}

function fileGenLimitReached(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = fileGenDaily[chatId];
  if (!entry || entry.date !== today) return false;
  return entry.count >= MAX_FILES_PER_USER_PER_DAY;
}

function recordFileGen(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  if (!fileGenDaily[chatId] || fileGenDaily[chatId].date !== today) {
    fileGenDaily[chatId] = { date: today, count: 0 };
  }
  fileGenDaily[chatId].count += 1;
}

function buildOutputFilename(userText, format) {
  const stamp = Date.now();
  const t = userText.toLowerCase();
  let base = "Pathway-Prep-Document";
  if (/cover letter/.test(t)) base = "Cover-Letter";
  else if (/cv|resume|curriculum/.test(t)) base = "CV";
  return `${base}-${stamp}.${format}`;
}

function documentTitleFromRequest(userRequest) {
  const t = userRequest.toLowerCase();
  if (/cv|resume|curriculum/.test(t)) return "Curriculum Vitae";
  if (/cover letter/.test(t)) return "Cover Letter";
  if (/spreadsheet|excel|table/.test(t)) return "Spreadsheet";
  return "Document";
}

function isDocHeading(line) {
  return (
    line.length < 70 &&
    (/^[A-Z][A-Z0-9\s&',.\-/]{2,}$/.test(line) ||
      /^[A-Za-z][A-Za-z0-9\s]{0,50}:$/.test(line) ||
      /^(curriculum vitae|resume|cover letter|professional summary|work experience|education|skills|contact|objective)$/i.test(line))
  );
}

function cleanDocumentBody(raw) {
  return raw
    .trim()
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^[-*]\s+/gm, "• ");
}

async function craftDocumentContent(userRequest, format) {
  const tabular = format === "xlsx" || format === "csv";
  const systemExtra = tabular
    ? "Output tab-separated data: one row per line, columns separated by TAB characters. Include a header row. No markdown."
    : "Output ONLY the document body in plain text. No markdown symbols (no *, #, -, **). " +
      "Put section titles on their own line (e.g. EDUCATION, WORK EXPERIENCE). Use blank lines between sections. " +
      "Use realistic fictional details when the user asks for sample or random information. " +
      "CVs must include: full name at top, contact, professional summary, work experience with dates, education, skills.";

  const response = await groq.chat.completions.create({
    model: TEXT_MODEL,
    max_tokens: 3000,
    ...groqChatParams({ temperature: 0.55 }),
    messages: [
      {
        role: "system",
        content: `You write complete professional documents for export as ${format.toUpperCase()}. ${systemExtra}`
      },
      { role: "user", content: userRequest }
    ]
  });
  const body = cleanDocumentBody(response.choices[0].message.content);
  return { title: documentTitleFromRequest(userRequest), body };
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
      if (isDocHeading(line)) {
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

async function buildDocxBuffer(title, bodyText) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: { after: 200 } })
  ];
  for (const rawLine of bodyText.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      children.push(new Paragraph({ text: "" }));
      continue;
    }
    if (isDocHeading(line)) {
      children.push(new Paragraph({ text: line, heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 80 } }));
    } else {
      children.push(new Paragraph({ children: [new TextRun(line)], spacing: { after: 80 } }));
    }
  }
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

function buildXlsxBuffer(title, bodyText) {
  const XLSX = require("xlsx");
  const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows = [[title], []];
  for (const line of lines) {
    if (line.includes("\t")) rows.push(line.split("\t"));
    else if (line.includes("|")) rows.push(line.split("|").map((c) => c.trim()));
    else rows.push([line]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

function buildCsvBuffer(bodyText) {
  const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
  const csvLines = lines.map((line) => {
    const cols = line.includes("\t") ? line.split("\t") : line.split("|").map((c) => c.trim());
    return cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");
  });
  return Buffer.from(csvLines.join("\n"), "utf8");
}

function buildHtmlBuffer(title, bodyText) {
  const escaped = bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font-family:Segoe UI,Arial,sans-serif;max-width:800px;margin:2em auto;line-height:1.5;color:#222}` +
    `h1{text-align:center}pre{white-space:pre-wrap}</style></head><body>` +
    `<h1>${title}</h1><pre>${escaped}</pre></body></html>`;
  return Buffer.from(html, "utf8");
}

async function buildFileBuffer(format, title, bodyText) {
  switch (format) {
    case "pdf":
      return buildPdfBuffer(title, bodyText);
    case "docx":
      return buildDocxBuffer(title, bodyText);
    case "xlsx":
      return buildXlsxBuffer(title, bodyText);
    case "csv":
      return buildCsvBuffer(bodyText);
    case "html":
      return buildHtmlBuffer(title, bodyText);
    case "md":
      return Buffer.from(`# ${title}\n\n${bodyText}`, "utf8");
    case "txt":
    default:
      return Buffer.from(`${title}\n\n${bodyText}`, "utf8");
  }
}

function formatLabel(format) {
  const labels = { pdf: "PDF", docx: "Word", xlsx: "Excel", csv: "CSV", md: "Markdown", txt: "text", html: "HTML" };
  return labels[format] || format.toUpperCase();
}

async function handleFileGenerationRequest(chatId, userText) {
  const format = detectRequestedFileFormat(userText) || defaultFileFormat(userText);
  if (!SUPPORTED_FILE_FORMATS.includes(format)) {
    return bot.sendMessage(
      chatId,
      `That file type isn't supported yet. I can create: ${SUPPORTED_FILE_FORMATS.join(", ")}.\n\nExample: "give me a CV as a Word document"`
    );
  }
  if (fileGenLimitReached(chatId)) {
    return bot.sendMessage(
      chatId,
      `You've reached today's limit of ${MAX_FILES_PER_USER_PER_DAY} generated files. Try again tomorrow.`
    );
  }

  const label = formatLabel(format);
  await bot.sendChatAction(chatId, "upload_document");
  const statusMsg = await bot.sendMessage(chatId, `Creating your ${label} file — this may take a moment…`);

  try {
    const { title, body } = await craftDocumentContent(userText, format);
    const fileBuffer = await buildFileBuffer(format, title, body);
    recordFileGen(chatId);

    const filename = buildOutputFilename(userText, format);
    const history = getHistory(chatId);
    history.push({ role: "user", content: userText });
    history.push({
      role: "assistant",
      content: `[Sent ${label} file: ${filename}] Here is your ${title}. Download and open the attachment above.`
    });
    trimHistory(chatId);

    await bot.sendDocument(chatId, fileBuffer, { caption: `Your ${title} (${label}) from Pathway Prep` }, { filename });
    await bot.sendMessage(
      chatId,
      `Your ${label} file is attached above (${filename}). Open it on your phone or computer — tell me if you want edits or a different format (${SUPPORTED_FILE_FORMATS.join(", ")}).`
    );
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
  } catch (err) {
    console.error("File generation error:", err.message);
    await bot.editMessageText(
      `I couldn't create that ${label} file right now — please try again in a moment.`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {
      bot.sendMessage(chatId, `I couldn't create that ${label} file right now — please try again in a moment.`);
    });
  }
}

function buildVisionUserText(caption, intro) {
  const q = (caption || "").trim();
  if (q) {
    return (
      intro +
      q +
      "\n\n[If this is course/training material: LESSON PAGE MODE — tutor voice, no 'screenshot' talk, explain don't repeat. Otherwise answer from what is visible.]"
    );
  }
  return (
    intro +
    "Teach this course page: numbered sections, headings, bullets, Example/Tip/Warning labels, real-life examples. " +
    "Open naturally with the topic — never say screenshot. Step-by-step, why it matters, common mistakes. " +
    "Wrap-up line, then offer quiz or move on. CV/interview photo = brief structured career feedback only."
  );
}

/** Follow-up text about a screenshot already discussed — keep lesson context in history */
function isLikelyScreenshotFollowUp(chatId, text) {
  const history = getHistory(chatId);
  if (!history.length) return false;
  const recent = history.slice(-6).map((m) => m.content || "").join(" ");
  return /\[Lesson\/course screenshot uploaded/i.test(recent) && text.length < 800;
}

function buildScreenshotFollowUpPrefix() {
  return (
    "[Follow-up on the lesson page in this chat — no screenshot talk, no resend. " +
    "Use WRITING RULES: numbered sections, headings, bullets, Example/Tip/Warning. " +
    "Re-explain in smaller parts if confused. Quiz = one question at a time. Vary your opening.]\n\n"
  );
}

/** User asked for a generated picture — offer a document instead (default behaviour). */
async function handleIllustrationAsDocument(chatId, userText) {
  const format = detectRequestedFileFormat(userText) || "pdf";
  const fmt = SUPPORTED_FILE_FORMATS.includes(format) ? format : "pdf";
  const label = formatLabel(fmt);
  await bot.sendMessage(
    chatId,
    `I create ${label} and other document files, not pictures. I'll build a ${label} with clear headings and bullet points for you now.`
  );
  const topic = userText
    .replace(/\b(generate|create|make|draw|produce|design|illustrate|visuali[sz]e)\b/gi, "explain")
    .replace(/\b(an?\s+)?(image|picture|illustration|photo|diagram|infographic)\b/gi, "topic")
    .trim();
  return handleFileGenerationRequest(
    chatId,
    `Create a ${fmt} document with clear sections and bullet points (text layout only, no images): ${topic}`
  );
}

async function handleImageGenerationRequest(chatId, userText) {
  if (!hasImageGen()) {
    return handleIllustrationAsDocument(chatId, userText);
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
    const { buffer: imageBuffer, brief } = await generateImageForRequest(userText);
    recordImageGen(chatId);

    const history = getHistory(chatId);
    history.push({ role: "user", content: userText });

    const caption = await describeGeneratedImage(imageBuffer, userText, brief);
    history.push({ role: "assistant", content: `[Sent illustration: ${brief.subject}] ${caption}` });
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
    max_tokens: VISION_MAX_TOKENS,
    ...groqChatParams({ temperature: 0.5 }),
    messages: [
      { role: "system", content: visionSystemPrompt },
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

  const reply = formatReply(response.choices[0].message.content);
  const summaryHint = userText.slice(0, 200);
  history.push({
    role: "user",
    content: `[Lesson/course screenshot uploaded — remember this page for follow-up questions without resending] ${summaryHint}`
  });
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

bot.onText(/\/file(?:@\w+)?(?:\s+(\w+))?(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!gateAccess(msg)) return;
  const fmt = (match[1] || "").toLowerCase();
  const topic = (match[2] || "").trim();
  if (!fmt || !topic) {
    return bot.sendMessage(
      chatId,
      "Usage: /file [format] [content]\n\nFormats: " + SUPPORTED_FILE_FORMATS.join(", ") +
        "\n\nExamples:\n/file docx sample CV with random details\n/file pdf cover letter for a nurse\n/file xlsx interview prep checklist"
    );
  }
  await handleFileGenerationRequest(chatId, `Create a ${fmt} file: ${topic}`);
});

bot.onText(/\/pdf(?:@\w+)?(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!gateAccess(msg)) return;
  const topic = (match[1] || "").trim();
  if (!topic) {
    return bot.sendMessage(chatId, "Usage: /pdf [content]\n\nOr use: /file pdf [content]");
  }
  await handleFileGenerationRequest(chatId, `Create a PDF document: ${topic}`);
});

bot.onText(/\/image(?:@\w+)?(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!gateAccess(msg)) return;
  const topic = (match[1] || "").trim();
  if (!topic) {
    return bot.sendMessage(
      chatId,
      "Picture generation is disabled. Use a document instead:\n\n/file pdf [topic]\n/file docx [topic]\n\nExample:\n/file pdf STAR method for interviews"
    );
  }
  if (hasImageGen()) {
    return handleImageGenerationRequest(chatId, `Generate an educational illustration explaining: ${topic}`);
  }
  return handleIllustrationAsDocument(chatId, `Create a diagram or guide explaining: ${topic}`);
});

bot.onText(/\/forget/, (msg) => {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  firstMessage[chatId] = true;
  bot.sendMessage(chatId, "Done — I've cleared our conversation history. How can I help you today?");
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  if (isAdmin(chatId)) {
    return bot.sendMessage(chatId,
      "Admin commands:\n\n" +
      "/gencode [note] — generate an activation code\n" +
      "/codes — list all codes\n" +
      "/users — list all users\n" +
      "/ban [chatId] [reason] — ban a user\n" +
      "/unban [chatId] — unban a user"
    );
  }
  bot.sendMessage(chatId,
    "Pathway Prep commands:\n\n" +
    "/file [format] [topic] — PDF, Word, Excel, etc.\n" +
    "/pdf [topic] — quick PDF\n" +
    "/forget — clear chat history\n\n" +
    "Send a course/training screenshot — I'll teach the page like a tutor (plain language, key points, quiz optional).\n" +
    "Add a caption to ask something specific. Follow-up questions work without resending the image.\n" +
    "Supported files: PDF, Word, Excel, text."
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
    if (userWantsGeneratedFile(text)) {
      return handleFileGenerationRequest(chatId, text);
    }
    if (userWantsGeneratedImage(text)) {
      return hasImageGen()
        ? handleImageGenerationRequest(chatId, text)
        : handleIllustrationAsDocument(chatId, text);
    }

    bot.sendChatAction(chatId, "typing");
    const intro = buildIntro(chatId);
    const followUp = isLikelyScreenshotFollowUp(chatId, text) ? buildScreenshotFollowUpPrefix() : "";
    const reply = await chatText(chatId, intro + followUp + text);
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
    const prompt = buildVisionUserText(msg.caption, intro);
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
  const mime = (doc.mime_type || "").toLowerCase();

  bot.sendChatAction(chatId, "typing");
  try {
    const file = await bot.getFile(doc.file_id);
    if (mime.startsWith("image/")) {
      const imageUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const intro = buildIntro(chatId);
      const prompt = buildVisionUserText(msg.caption, intro);
      const reply = await chatVision(chatId, imageUrl, prompt);
      return sendLongMessage(chatId, reply);
    }
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

let last409HintAt = 0;
bot.on("polling_error", (err) => {
  const msg = err.message || String(err);
  console.error("Polling error:", msg);
  if (msg.includes("409") || /getUpdates/i.test(msg)) {
    const now = Date.now();
    if (now - last409HintAt > 60000) {
      last409HintAt = now;
      console.error(
        "\n⚠️  Another bot instance is using this Telegram token.\n" +
        "   • Stop Railway if it still exists (Render + Railway = 409 every time)\n" +
        "   • Stop local bot: run STOP-BOT.ps1 — never run local + Render together\n" +
        "   • Render: only ONE web service for this bot; suspend duplicates\n" +
        "   • Rule: exactly ONE host polling Telegram (Render OR local, not both)\n"
      );
    }
    if (!polling409Retrying && polling409Retries < 6) {
      polling409Retrying = true;
      polling409Retries += 1;
      const waitSec = Math.min(10 + polling409Retries * 5, 45);
      console.error(`   Retrying polling in ${waitSec}s (attempt ${polling409Retries}/6)…`);
      setTimeout(async () => {
        try {
          await bot.stopPolling();
          await bot.deleteWebHook({ drop_pending_updates: false });
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          await bot.startPolling({ restart: false });
          console.log("Polling restarted after 409 — check if errors stopped.");
        } catch (e) {
          console.error("Polling restart failed:", e.message);
        } finally {
          polling409Retrying = false;
        }
      }, 0);
    }
  }
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
    const missing = getMissingRequiredEnv();
    return sendJSON(res, 200, {
      status: missing.length ? "misconfigured" : "ok",
      uptime: Math.floor(process.uptime()),
      dataDir: DATA_DIR,
      botReady,
      missingEnv: missing.length ? missing : undefined,
      hint: missing.length
        ? "Add missing variables in Render → Environment, then redeploy."
        : undefined
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

  if (req.method === "POST" && p.match(/^\/api\/users\/[^/]+\/ban$/)) {
    const id = String(decodeURIComponent(p.split("/")[3]));
    try {
      const body = await parseBody(req);
      const data = loadUsers();
      data.banned[id] = { reason: body.reason || "Blocked via admin panel", at: new Date().toISOString() };
      saveUsers(data);
      if (bot) {
        bot.sendMessage(id, `Your access has been restricted. Contact ${SUPPORT_EMAIL} if you think this is a mistake.`).catch(() => {});
      }
      return sendJSON(res, 200, { success: true });
    } catch (e) {
      console.error("Ban API error:", e.message);
      return sendJSON(res, 500, { error: "Failed to block user" });
    }
  }

  if (req.method === "POST" && p.match(/^\/api\/users\/[^/]+\/unban$/)) {
    const id = String(decodeURIComponent(p.split("/")[3]));
    try {
      const data = loadUsers();
      delete data.banned[id];
      saveUsers(data);
      if (bot) {
        bot.sendMessage(id, "Your access has been restored. Welcome back!").catch(() => {});
      }
      return sendJSON(res, 200, { success: true });
    } catch (e) {
      console.error("Unban API error:", e.message);
      return sendJSON(res, 500, { error: "Failed to unblock user" });
    }
  }

  return sendJSON(res, 404, { error: "Not found" });
});

const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_URL =
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

server.listen(PORT, HOST, () => {
  const codeCount = Object.keys(loadCodes().codes).length;
  const userCount = Object.keys(loadUsers().users).length;
  console.log(`✅ HTTP server listening on ${HOST}:${PORT}`);
  console.log(`✅ Health check: http://${HOST}:${PORT}/health`);
  console.log(`✅ Admin panel: http://localhost:${PORT}/admin`);
  if (PUBLIC_URL) console.log(`✅ Public admin: ${PUBLIC_URL}/admin`);
  console.log(`📁 Data folder: ${DATA_DIR} (${codeCount} codes, ${userCount} users loaded)`);
  initTelegramBot()
    .then(() => {
      if (botReady) console.log(`✅ Pathway Prep Bot is running!`);
    })
    .catch((err) => {
      console.error("Telegram init failed:", err.message || err);
    });

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
