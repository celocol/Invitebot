import dotenv from "dotenv";
dotenv.config(); // 👈 carga el .env

import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());

const token = process.env.BOT_TOKEN; // 👈 correcto
let bot;

if (process.env.NODE_ENV === "production") {
    console.log("🔄 Configurando webhook en producción...");

    const WEBHOOK_URL = process.env.WEBHOOK_URL;
    if (!WEBHOOK_URL) throw new Error("❌ No se encontró WEBHOOK_URL");

    bot = new TelegramBot(token, { polling: false });

    try {
        await bot.setWebHook(WEBHOOK_URL, { allowed_updates: ["*"] });
        console.log(`✅ Webhook configurado correctamente en Telegram`);
    } catch (err) {
        console.error("❌ Error configurando webhook:", err.message);
    }

    app.post("/webhook", (req, res) => {
        console.log("📩 Webhook recibido:", JSON.stringify(req.body, null, 2));
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
} else {
    console.log("🤖 Modo desarrollo: usando polling");
    bot = new TelegramBot(token, { polling: true });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Express en puerto ${PORT}`);
});
