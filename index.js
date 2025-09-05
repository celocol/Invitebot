import dotenv from "dotenv";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createPool } from "mysql2/promise";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
let bot = null;
let pool = null;

async function createDBConnection() {
    pool = await createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    console.log("✅ Conexión a MySQL establecida");
}

async function start() {
    try {
        await createDBConnection();

        const token = process.env.BOT_TOKEN;
        if (!token) throw new Error("❌ Falta la variable TG_KEY en .env");

        if (process.env.NODE_ENV === "production") {
            console.log("🔄 Configurando webhook en producción...");

            const railwayUrl =
                process.env.RAILWAY_PUBLIC_DOMAIN ||
                process.env.RAILWAY_STATIC_URL ||
                process.env.PUBLIC_URL ||
                `${process.env.RAILWAY_SERVICE_NAME || "app"}.up.railway.app`;

            const WEBHOOK_URL = `https://${railwayUrl}/webhook`;

            bot = new TelegramBot(token, {
                webHook: {
                    port: PORT,
                },
            });

            // Configurar webhook en Telegram
            await bot.setWebHook(WEBHOOK_URL);
            console.log(`✅ Webhook configurado: ${WEBHOOK_URL}`);

            // Middleware para recibir updates
            app.use(express.json());
            app.post("/webhook", (req, res) => {
                console.log("📬 Webhook recibido");
                bot.processUpdate(req.body);
                res.sendStatus(200);
            });
        } else {
            console.log("🔄 Usando polling en desarrollo...");

            bot = new TelegramBot(token, {
                polling: {
                    params: {
                        allowed_updates: ["message", "chat_member", "my_chat_member"],
                    },
                },
            });

            console.log("✅ Bot iniciado en modo polling");
        }

        // =========================
        // Handlers del bot (AQUI!)
        // =========================
        bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            bot.sendMessage(
                chatId,
                "👋 Hola! Soy tu bot, ya estoy funcionando en Railway 🚀"
            );
        });

        bot.on("message", (msg) => {
            console.log("📩 Mensaje recibido:", msg.text);
        });

        bot.on("chat_member", (update) => {
            console.log("👥 Cambio de miembros:", update);
        });

        bot.on("my_chat_member", (update) => {
            console.log("🤖 Cambio en estado del bot:", update);
        });

        // Express server
        app.listen(PORT, () => {
            console.log(`🚀 Servidor Express en puerto ${PORT}`);
            console.log(`🌍 Modo: ${process.env.NODE_ENV || "development"}`);
        });
    } catch (error) {
        console.error("❌ Error iniciando la aplicación:", error);
        process.exit(1);
    }
}

// Shutdown graceful
process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

async function gracefulShutdown(signal) {
    console.log(`\n🛑 Cerrando aplicación (${signal})...`);
    try {
        if (bot) bot.stop(signal);
        if (pool) await pool.end();
        console.log("✅ Recursos liberados, apagando...");
        process.exit(0);
    } catch (err) {
        console.error("❌ Error en cierre:", err);
        process.exit(1);
    }
}

start();
