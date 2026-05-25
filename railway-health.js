// Temporary Railway debug — set start command to: node railway-health.js
// If /health works, networking is fine and the main bot is crashing on startup.
const http = require("http");
const PORT = Number(process.env.PORT) || 3001;
const HOST = "0.0.0.0";

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mode: "health-only", port: PORT }));
  })
  .listen(PORT, HOST, () => {
    console.log(`Health-only server on ${HOST}:${PORT}`);
  });
