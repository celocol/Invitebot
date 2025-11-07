import dotenv from "dotenv";
dotenv.config();
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json()); // 👈 Siempre antes del endpoint

const token = process.env.BOT_TOKEN;
let bot;

if (process.env.NODE_ENV === "production") {
    console.log("🔄 Configurando webhook en producción...");

    const WEBHOOK_URL = process.env.WEBHOOK_URL;
    if (!WEBHOOK_URL) throw new Error("❌ No se encontró WEBHOOK_URL");

    bot = new TelegramBot(token, { polling: false });

    // Registrar webhook antes de levantar el servidor
    try {
        await bot.setWebHook(WEBHOOK_URL, { allowed_updates: ["*"] });
        console.log(`✅ Webhook configurado correctamente en Telegram`);
    } catch (err) {
        console.error("❌ Error configurando webhook:", err.message);
    }

    // 🔥 Asegurate que este endpoint exista y procese updates
    app.post("/webhook", (req, res) => {
        console.log("📩 Webhook recibido:", JSON.stringify(req.body, null, 2));
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
} else {
    console.log("🤖 Modo desarrollo: usando polling");
    bot = new TelegramBot(token, { polling: true });
}

// 🔥 El servidor se inicia después del webhook
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Express en puerto ${PORT}`);
});
