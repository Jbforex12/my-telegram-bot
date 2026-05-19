const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
require("dotenv").config();

const BOT_NAME = "Pathway Prep Assistant";
const SUPPORT_EMAIL = "support@jbacademyltd.org"; // Update this to your real support email

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Stores conversation history per user
const conversations = {};

// Tracks whether the user has had their first message handled
const firstMessage = {};

// Tracks the last processed message ID per chat to avoid duplicate replies
const lastProcessedMessageId = {};

const systemPrompt = `
You are ${BOT_NAME}, a friendly and helpful assistant for Pathway Prep — a programme that gives individuals the knowledge, skills and confidence they need to prepare for work and opportunities abroad.

ABOUT PATHWAY PREP:
When asked "Who are you?" or "What is Pathway Prep?", respond:
"Pathway Prep is a programme designed to give individuals the knowledge, skills and confidence they need to prepare for work and opportunities abroad. Whether you're looking to start a new career, understand what a job role involves, or simply build on what you already know — Pathway Prep is here to guide you every step of the way 🎓"

RULES YOU MUST ALWAYS FOLLOW:
- Keep replies short and conversational — no long paragraphs
- Ask only one question at a time
- Never ask the same question twice in a conversation
- Never echo back what the user just said
- Never use robotic phrases like "your request has been received" or "I have processed your input"
- Never use markdown formatting like asterisks (*), double asterisks (**), or bullet dashes in replies — use plain text only
- Never expose technical terms or jargon to the user
- If you don't know the answer, say something like: "That's a great question — let me point you to the right people. You can reach the support team at ${SUPPORT_EMAIL} and they'll be happy to help."
- When a user says "okay", "thanks", "bye", "goodbye", or signals the conversation is ending — respond warmly and briefly, then stop. Do not keep the conversation going.
- Always follow the user's lead if they change topic — never ignore a topic change
- When describing a photo or image, describe it naturally — never start with "This image contains..."
- End conversations warmly, always mentioning Pathway Prep

TONE:
- Warm, human, encouraging
- Like a knowledgeable friend, not a customer service robot
`.trim();

// Handle /start command
bot.onText(/\/start/, function (msg) {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  firstMessage[chatId] = true;

  bot.sendMessage(
    chatId,
    `Hello! I'm the ${BOT_NAME} 👋\n\nPathway Prep is here to help you build the knowledge, skills and confidence you need to prepare for work and opportunities abroad.\n\nHow can I help you today?`
  );
});

// Handle /forget command — clears memory
bot.onText(/\/forget/, function (msg) {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  firstMessage[chatId] = true;
  bot.sendMessage(chatId, "No problem — I've cleared our conversation. How can I help you today?");
});

// Handle text messages
bot.on("message", async function (msg) {
  const chatId = msg.chat.id;
  const userText = msg.text;

  // Ignore commands (handled separately above)
  if (!userText || userText.startsWith("/")) return;

  // Avoid processing the same message twice (duplicate guard)
  if (lastProcessedMessageId[chatId] === msg.message_id) return;
  lastProcessedMessageId[chatId] = msg.message_id;

  bot.sendChatAction(chatId, "typing");

  // Initialise conversation history if needed
  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  // On first message (not via /start), add a warm intro context
  let intro = "";
  if (!firstMessage[chatId]) {
    firstMessage[chatId] = true;
    intro = `[The user has just opened the chat for the first time without using /start. Greet them briefly as ${BOT_NAME} and ask how you can help, then answer their message below if they've already asked something.]\n\n`;
  }

  // Add user message to history
  conversations[chatId].push({ role: "user", content: intro + userText });

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 512,
      messages: [
        { role: "system", content: systemPrompt },
        ...conversations[chatId]
      ]
    });

    const reply = response.choices[0].message.content;

    // Save bot reply to history
    conversations[chatId].push({ role: "assistant", content: reply });

    // Keep only last 20 messages to avoid token limits
    if (conversations[chatId].length > 20) {
      conversations[chatId] = conversations[chatId].slice(-20);
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

  // Avoid processing the same message twice
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
      max_tokens: 512,
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

    // Save image reply to memory
    if (!conversations[chatId]) conversations[chatId] = [];
    conversations[chatId].push({ role: "assistant", content: reply });

    await bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error("Photo handler error:", err);
    await bot.sendMessage(chatId, "I couldn't read that image — could you try sending it again?");
  }
});

console.log("✅ Pathway Prep Bot is running!");