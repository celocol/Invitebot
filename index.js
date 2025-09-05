import dotenv from "dotenv";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createPool } from "mysql2/promise";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
let bot = null;
let pool = null;

async function createTables() {
    try {
        const connection = await pool.getConnection();

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS invitations (
                id INT PRIMARY KEY AUTO_INCREMENT,
                inviter_id BIGINT NOT NULL,
                inviter_username VARCHAR(255),
                invited_id BIGINT NOT NULL,
                invited_username VARCHAR(255),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_inviter_id (inviter_id),
                INDEX idx_invited_id (invited_id)
            )
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS ranking (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                count INT DEFAULT 0,
                INDEX idx_count (count DESC)
            )
        `);

        connection.release();
        console.log("✅ Tablas creadas/verificadas correctamente");
    } catch (error) {
        console.error("❌ Error creando tablas:", error);
    }
}

async function createDBConnection() {
    pool = await createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    await createTables()
    console.log("✅ Conexión a MySQL establecida");
}

async function executeQuery(query, params = []) {
    let retries = 3;
    while (retries > 0) {
        try {
            const [results] = await pool.execute(query, params);
            return results;
        } catch (error) {
            console.error(`❌ Error ejecutando query (intentos restantes: ${retries - 1}):`, error);
            retries--;
            if (retries === 0) throw error;
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

// =======================
// ⚙️ FUNCIONES AUXILIARES BOT
// =======================
async function registerInvitation(inviterId, inviterUsername, invitedId, invitedUsername) {
    try {
        const existing = await executeQuery(
            "SELECT * FROM invitations WHERE inviter_id = ? AND invited_id = ?",
            [inviterId, invitedId]
        );
        if (existing.length > 0) return false;

        await executeQuery(
            "INSERT INTO invitations (inviter_id, inviter_username, invited_id, invited_username) VALUES (?, ?, ?, ?)",
            [inviterId, inviterUsername || null, invitedId, invitedUsername || null]
        );

        await executeQuery(
            `INSERT INTO ranking (user_id, username, count) 
             VALUES (?, ?, 1) 
             ON DUPLICATE KEY UPDATE 
             count = count + 1,
             username = VALUES(username)`,
            [inviterId, inviterUsername || "Unknown"]
        );

        return true;
    } catch (error) {
        console.error("❌ Error registrando invitación:", error);
        return false;
    }
}

async function getRanking() {
    try {
        return await executeQuery(
            "SELECT username, count FROM ranking ORDER BY count DESC LIMIT 10"
        );
    } catch {
        return [];
    }
}

async function sendTemporaryMessage(chatId, text, timeout) {
    try {
        const sent = await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
        if (sent?.message_id) {
            setTimeout(() => {
                bot.deleteMessage(chatId, sent.message_id).catch(() => {});
            }, timeout);
        }
    } catch (err) {
        console.error("❌ Error enviando mensaje temporal:", err);
    }
}

async function isUserAdmin(chatId, userId) {
    try {
        const admins = await bot.getChatAdministrators(chatId);
        return admins.some(admin => admin.user.id === userId);
    } catch {
        return false;
    }
}

async function getUserInvitations(userId) {
    try {
        const results = await executeQuery(
            "SELECT count FROM ranking WHERE user_id = ?",
            [userId]
        );
        return results.length ? results[0].count : 0;
    } catch {
        return null;
    }
}

async function getUserRankingPosition(userId) {
    try {
        const results = await executeQuery(
            `SELECT COUNT(*) + 1 as position 
             FROM ranking 
             WHERE count > (SELECT COALESCE(count, 0) FROM ranking WHERE user_id = ?)`,
            [userId]
        );
        return results[0].position;
    } catch {
        return null;
    }
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

            bot = new TelegramBot(token, { polling: false });

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
        bot.onText(/^\/start$/, async (msg) => {
            console.log('🚀 Procesando comando /start...');

            const chatId = msg.chat.id;
            const username = msg.from.username || msg.from.first_name;

            const message = `👋 ¡Hola @${username}! Soy un bot que registra las invitaciones a grupos.

    📋 *Comandos disponibles:*
    /start - Este mensaje
    /help - Ayuda y estado
    /ranking - Ver el top 10 de usuarios que más han invitado (solo admins)
    /misinvitaciones - Ver tus invitaciones personales
    
    💡 *Cómo funciona:*
    Cuando alguien añade a una persona al grupo, registro la invitación automáticamente.
    
    ⏱️ *Este mensaje se eliminará en 5 segundos...*`;

            const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

            if (isGroup) await sendTemporaryMessage(chatId, message, 5000);

            else await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

            console.log('✅ Start procesado');
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
