const API_BASE = "https://api.telegram.org/bot";

async function sendMessage(token, chatId, text) {
  const res = await fetch(`${API_BASE}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  return res.json();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("🤖 Kiwibot is running!", { status: 200 });
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();
      const message = update.message;
      if (!message || !message.text) return new Response("OK", { status: 200 });
      const chatId = message.chat.id;
      const text = message.text;
      let reply;
      if (text === "/start") reply = "👋 Hi! I'm Kiwibot. Send me a message and I'll echo it back!";
      else if (text === "/help") reply = "Available commands:\n/start — Greet\n/help — Help\nAnything else — Echo";
      else reply = `You said: ${text}`;
      ctx.waitUntil(sendMessage(env.TELEGRAM_TOKEN, chatId, reply));
      return new Response("OK", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  },
};
