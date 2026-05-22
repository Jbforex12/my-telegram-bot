const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
require("dotenv").config();

const BOT_NAME = "Pathway Prep Assistant";
const SUPPORT_EMAIL = "support@pathwayprep.com"; // Update to your real support email

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Stores conversation history per user
const conversations = {};

// Tracks whether the user has had their first message handled
const firstMessage = {};

// Tracks the last processed message ID per chat to avoid duplicate replies
const lastProcessedMessageId = {};

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
- Do NOT end every reply with a question. Only ask a question when you genuinely need more information to help, or when it naturally fits the conversation. Most replies should simply inform, explain, or respond — and then stop.
- Keep replies concise and conversational — no long walls of text
- Split information into short paragraphs if needed, but keep it digestible
- Never use markdown formatting — no asterisks (*), no double asterisks (**), no bullet dashes. Plain text only.
- Never echo back what the user just said
- Never use robotic or corporate phrases like "your request has been received", "I have processed your query", or "certainly, I can assist with that"
- Never expose technical language to the user
- When a user says "okay", "thanks", "bye", "goodbye", or signals the conversation is ending — respond warmly and briefly, then stop. Do not keep going.
- Always follow the user's lead if they change topic
- When describing a photo, describe it naturally — never start with "This image contains..."

TUTORING MODE:
- If a user wants to learn or study something, guide them through it like a patient, encouraging tutor
- Teach one concept at a time
- Use relatable examples
- Occasionally check understanding naturally (e.g. "Does that make sense so far?" — but not after every single message)
- Celebrate progress with genuine warmth, not performative praise

TONE:
- Warm, human, encouraging and real
- Like a smart, supportive friend who genuinely wants to help — not a customer service bot
- Confident but never arrogant
- Honest when you don't know something

Always end conversations warmly, mentioning Pathway Prep by name.
`.trim();

// Handle /start command
bot.onText(/\/start/, function (msg) {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  firstMessage[chatId] = true;

  bot.sendMessage(
    chatId,
    `Hello! I'm the ${BOT_NAME} 👋\n\nI'm here to help you build the knowledge, skills and confidence you need to prepare for work and opportunities abroad.\n\nHow can I help you today?`
  );
});

// Handle /forget command — clears memory
bot.onText(/\/forget/, function (msg) {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  firstMessage[chatId] = true;
  bot.sendMessage(chatId, "Done — I've cleared our conversation history. How can I help you today?");
});

// Handle text messages
bot.on("message", async function (msg) {
  const chatId = msg.chat.id;
  const userText = msg.text;

  // Ignore commands
  if (!userText || userText.startsWith("/")) return;

  // Duplicate message guard
  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;

  bot.sendChatAction(chatId, "typing");

  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  // On first message without /start, greet the user naturally
  let intro = "";
  if (!firstMessage[chatId]) {
    firstMessage[chatId] = true;
    intro = `[The user has opened the chat without using /start. Greet them briefly and warmly as ${BOT_NAME}, then respond to their message below naturally. Do not ask "How can I help you?" if they have already asked something.]\n\n`;
  }

  conversations[chatId].push({ role: "user", content: intro + userText });

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

    // Keep last 30 messages (more memory for tutoring sessions)
    if (conversations[chatId].length > 30) {
      conversations[chatId] = conversations[chatId].slice(-30);
    }

    await bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error("Text message error:", err);
    await bot.sendMessage(chatId, "Something went wrong on my end — please try again in a moment.");
  }
});

// Handle images/photos
bot.on("photo", async function (msg) {
  const chatId = msg.chat.id;

  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;

  bot.sendChatAction(chatId, "typing");

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const imageUrl =
      "https://api.telegram.org/file/bot" +
      process.env.TELEGRAM_BOT_TOKEN +
      "/" +
      file.file_path;

    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: msg.caption || "What do you see here?" }
          ]
        }
      ]
    });

    const reply = response.choices[0].message.content;

    if (!conversations[chatId]) conversations[chatId] = [];
    conversations[chatId].push({ role: "assistant", content: reply });

    await bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error("Photo handler error:", err);
    await bot.sendMessage(chatId, "I couldn't read that image — could you try sending it again?");
  }
});

console.log("✅ Pathway Prep Bot is running!");
