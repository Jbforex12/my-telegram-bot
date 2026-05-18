const TelegramBot = require("node-telegram-bot-api");
const Groq = require("groq-sdk");
require("dotenv").config();

const BOT_NAME = "Pathway Prep Assistant";

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Stores conversation history for each user
const conversations = {};

const systemPrompt = "Your name is " + BOT_NAME + ". Answer questions directly and never give suggestions. Never say you are any other AI. Keep answers short and to the point. Never use asterisks or markdown formatting like * or ** in your replies. Write in plain text only.";

// Handle text messages
bot.on("message", async function(msg) {
  const chatId = msg.chat.id;
  const userText = msg.text;

  if (!userText) return;

  bot.sendChatAction(chatId, "typing");

  // Start conversation history for this user if it doesn't exist
  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  // Add user message to history
  conversations[chatId].push({ role: "user", content: userText });

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

    // Save bot reply to history
    conversations[chatId].push({ role: "assistant", content: reply });

    // Keep only last 20 messages to avoid hitting limits
    if (conversations[chatId].length > 20) {
      conversations[chatId] = conversations[chatId].slice(-20);
    }

    await bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, "Sorry something went wrong, try again.");
  }
});

// Handle images
bot.on("photo", async function(msg) {
  const chatId = msg.chat.id;

  bot.sendChatAction(chatId, "typing");

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const imageUrl = "https://api.telegram.org/file/bot" + process.env.TELEGRAM_BOT_TOKEN + "/" + file.file_path;

    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: msg.caption || "What is in this image?" }
          ]
        }
      ]
    });

    const reply = response.choices[0].message.content;

    // Also save image replies to memory
    if (!conversations[chatId]) conversations[chatId] = [];
    conversations[chatId].push({ role: "assistant", content: reply });

    await bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, "Sorry I could not read that image, try again.");
  }
});

// /start command
bot.onText(/\/start/, function(msg) {
  bot.sendMessage(msg.chat.id, "Hello! I am " + BOT_NAME + ". How can I help you today?");
});

// /forget command - clears memory
bot.onText(/\/forget/, function(msg) {
  conversations[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id, "I have cleared our conversation history.");
});

console.log("✅ Bot is running!");