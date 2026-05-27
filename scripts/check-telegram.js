require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

function env(name) {
  let v = (process.env[name] || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

const token = env("TELEGRAM_BOT_TOKEN");
if (!token || token.includes("your_")) {
  console.log("No TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

async function api(method) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`);
  return res.json();
}

(async () => {
  const me = await api("getMe");
  const wh = await api("getWebhookInfo");
  console.log("Bot:", me.ok ? `@${me.result.username}` : me.description);
  console.log("Webhook URL:", wh.result.url || "(none — polling is OK)");
  console.log("Pending updates:", wh.result.pending_update_count);
  if (wh.result.url) {
    console.log("\n→ A webhook is set. That can conflict with polling. Run deleteWebhook or redeploy with the bot fix.");
  } else {
    console.log("\n→ No webhook. 409 means another process is still calling getUpdates (second Render/Railway/local bot).");
  }
})();
