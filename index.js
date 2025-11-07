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
        host: process.env.DB_CONFIG_HOST,
        user: process.env.DB_CONFIG_USER,
        password: process.env.DB_CONFIG_PASSWORD,
        database: process.env.DB_CONFIG_DATABASE,
        port: process.env.DB_CONFIG_PORT,
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
            await bot.setWebHook(WEBHOOK_URL, {
                allowed_updates: ["*"]
            });
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
                        allowed_updates: ["*"],
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

        bot.onText(/^\/help$/, async (msg) => {
            console.log('❓ Comando /help recibido');

            const chatId = msg.chat.id;
            const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
            const userId = msg.from.id;
            const username = msg.from.username || msg.from.first_name;

            let helpMessage = `📋 *Comandos disponibles para @${username}:*\n\n`;

            // Comandos para todos los usuarios
            helpMessage += '👥 *Para todos los usuarios:*\n';
            helpMessage += '/start - Información del bot\n';
            helpMessage += '/misinvitaciones - Ver tus invitaciones personales\n';
            helpMessage += '/help - Este mensaje\n\n';

            if (isGroup) {
                const isAdmin = await isUserAdmin(chatId, userId);

                if (isAdmin) {
                    helpMessage += '👑 *Para administradores:*\n';
                    helpMessage += '/ranking - Top 10 invitadores (solo admins)\n\n';
                    helpMessage += '✅ *Tienes permisos de administrador*\n';
                } else {
                    helpMessage += '⛔ *Solo para administradores:*\n';
                    helpMessage += '/ranking - Top 10 invitadores\n\n';
                    helpMessage += '📝 *Nota:* No tienes permisos de administrador\n';
                }

                helpMessage += `📍 Grupo: ${msg.chat.title}\n`;
                helpMessage += `🆔 ID: ${chatId}\n\n`;
                helpMessage += `⏱️ *Este mensaje se eliminará en 8 segundos...*`;

                // Enviar mensaje temporal en grupos
                await sendTemporaryMessage(chatId, helpMessage, 8000);
            } else {
                helpMessage += '👑 *En chat privado (todos disponibles):*\n';
                helpMessage += '/ranking - Top 10 invitadores\n\n';
                helpMessage += '💬 *Estás en chat privado*\n';
                helpMessage += 'Añádeme a un grupo para registrar invitaciones';

                await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
            }

            console.log(`✅ Help procesado para ${username}`);
        });

        const lastRankingMessage = {};
        
        bot.onText(/^\/ranking$/, async (msg) => {
            console.log('📊 Procesando comando /ranking...');

            const chatId = msg.chat.id;
            const userId = msg.from.id;
            const username = msg.from.username || msg.from.first_name;

            // Verificar si el usuario es administrador
            const isAdmin = await isUserAdmin(chatId, userId);

            if (!isAdmin) {
                console.log(`⛔ Usuario ${username} intentó usar /ranking sin permisos de admin`);

                await bot.sendMessage(chatId,
                    '⛔ *Acceso denegado*\n\n' +
                    'Solo los administradores del grupo pueden ver el ranking completo.\n' +
                    'Usa /misinvitaciones para ver tus propias estadísticas.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            try {
                const ranking = await getRanking(); // <- tu función de DB que devuelve [{ username, count }]

                if (!ranking || ranking.length === 0) {
                    await bot.sendMessage(chatId, '📊 No hay datos de ranking todavía.');
                    return;
                }

                // Si ya existe un ranking enviado en este chat, borrarlo
                if (lastRankingMessage[chatId]) {
                    try {
                        await bot.deleteMessage(chatId, lastRankingMessage[chatId]);
                        console.log(`🗑 Ranking anterior eliminado en chat ${chatId}`);
                    } catch (err) {
                        console.warn('⚠️ No se pudo borrar el ranking anterior:', err.message);
                    }
                }

                // Construir mensaje del ranking
                let message = '🏆 *TOP 10 - Usuarios que más han invitado:*\n\n';
                ranking.forEach((user, index) => {
                    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                    message += `${medal} @${user.username}: *${user.count}* invitaciones\n`;
                });

                message += '\n👑 *Comando ejecutado por administrador*';

                // Enviar el nuevo mensaje y guardar su ID
                const sentMessage = await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                lastRankingMessage[chatId] = sentMessage.message_id;

                console.log(`✅ Ranking enviado por admin: ${username}`);
            } catch (error) {
                console.error('❌ Error mostrando ranking:', error);
                await bot.sendMessage(chatId, '❌ Error al obtener el ranking. Intenta más tarde.');
            }
        });

        bot.onText(/^\/misinvitaciones$/, async (msg) => {
            console.log('📊 Procesando comando /misinvitaciones...');

            const chatId = msg.chat.id;
            const userId = msg.from.id;
            const username = msg.from.username || msg.from.first_name;

            try {
                // Obtener el número de invitaciones del usuario
                const invitationCount = await getUserInvitations(userId);

                if (invitationCount === null) {
                    await bot.sendMessage(chatId, '❌ Error al obtener tus invitaciones. Intenta más tarde.');
                    return;
                }

                if (invitationCount === 0) {
                    await bot.sendMessage(
                        chatId,
                        `👤 @${username}\n` +
                        `📊 *Tus invitaciones:* 0\n` +
                        `🏆 *Posición:* Sin ranking\n\n` +
                        `💡 ¡Invita a más personas para aparecer en el ranking!`,
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }

                // Obtener la posición en el ranking
                const position = await getUserRankingPosition(userId);

                let message = `👤 @${username}\n`;
                message += `📊 *Tus invitaciones:* ${invitationCount}\n`;

                if (position !== null) {
                    message += `🏆 *Posición en ranking:* #${position}\n\n`;

                    // Agregar emoji según la posición
                    if (position === 1) {
                        message += `🥇 ¡Eres el #1 en invitaciones!`;
                    } else if (position === 2) {
                        message += `🥈 ¡Segundo lugar! Muy bien!`;
                    } else if (position === 3) {
                        message += `🥉 ¡Tercer lugar! Excelente!`;
                    } else if (position <= 10) {
                        message += `⭐ ¡Estás en el TOP 10!`;
                    } else {
                        message += `💪 ¡Sigue invitando para subir en el ranking!`;
                    }
                }

                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                console.log(`✅ Invitaciones mostradas para ${username}: ${invitationCount}`);

            } catch (error) {
                console.error('❌ Error mostrando invitaciones personales:', error);
                await bot.sendMessage(chatId, '❌ Error al obtener tus invitaciones. Intenta más tarde.');
            }
        });

        bot.on("chat_member", async (update) => {
            // Aquí `update` ya es todo el objeto que viene en chat_member
            const { chat, from, old_chat_member, new_chat_member } = update;

            console.log("📌 Evento de chat_member detectado");
            console.log("Chat:", chat.title || chat.id);
            console.log("Usuario que hizo la acción:", from.username || from.first_name);
            console.log("De:", old_chat_member.status, "➡️ A:", new_chat_member.status);

            if (new_chat_member.status === "left" || new_chat_member.status === "kicked") {
                const userId = new_chat_member.user.id;
                const username = new_chat_member.user.username || new_chat_member.user.first_name;

                try {
                    const invitations = await executeQuery(
                        "SELECT inviter_id FROM invitations WHERE invited_id = ?",
                        [userId]
                    );

                    if (invitations.length > 0) {
                        const inviterId = invitations[0].inviter_id;

                        await executeQuery("DELETE FROM invitations WHERE invited_id = ?", [userId]);

                        // 3. Obtener el ranking del invitador
                        const rankingRows = await executeQuery(
                            "SELECT count FROM ranking WHERE user_id = ?",
                            [inviterId]
                        );

                        if (rankingRows.length > 0) {
                            const nuevoCount = rankingRows[0].count - 1;

                            if (nuevoCount <= 0) {
                                await executeQuery("DELETE FROM ranking WHERE user_id = ?", [inviterId]);
                            } else {
                                await executeQuery(
                                    "UPDATE ranking SET count = ? WHERE user_id = ?",
                                    [nuevoCount, inviterId]
                                );
                            }
                        }
                    }

                    await sendTemporaryMessage(chat.id, `👋 @${username} salió del grupo`, 10000);
                } catch (err) {
                    console.error("❌ Error procesando salida de usuario:", err);
                }
            }

            if (new_chat_member.status === "administrator") {
                await bot.sendMessage(chat.id, `⚡ ${new_chat_member.user.first_name} ahora es administrador`);
            }

            if (new_chat_member.status === "member" && from.id !== new_chat_member.user.id) {

                const inviterId = from.id;
                const inviterUsername = from.username || from.first_name;
                const invitedId = new_chat_member.user.id;
                const invitedUsername = new_chat_member.user.username || new_chat_member.user.first_name;

                const isSuccess = await registerInvitation(
                    inviterId,
                    inviterUsername,
                    invitedId,
                    invitedUsername
                );
                
                if(isSuccess)
                    await sendTemporaryMessage(
                        chat.id,
                        `👋 ¡Bienvenido ${new_chat_member.user.first_name}!\n✨ Invitado por: @${from.username || from.first_name}`,
                        30000
                    );
            }
        });
        
        bot.on("my_chat_member", async (msg) => {
            const newStatus = msg.new_chat_member.status;
            const oldStatus = msg.old_chat_member.status;

            console.log("🔔 Cambio en membresía del bot:", {
                chat: msg.chat?.title || msg.chat?.id,
                type: msg.chat?.type,
                new_status: newStatus,
                old_status: oldStatus,
            });

            // Cuando el bot es agregado a un grupo
            if ((newStatus === "member" || newStatus === "administrator") && oldStatus === "left") {
                try {
                    await bot.sendMessage(
                        msg.chat.id,
                        "👋 ¡Hola! Gracias por añadirme al grupo.\n" +
                        "Por favor, hazme administrador para poder detectar las invitaciones.\n" +
                        "Usa /help para ver los comandos disponibles."
                    );
                } catch (err) {
                    console.error("❌ Error al enviar mensaje de bienvenida:", err.message);
                }
            }

            // Cuando el bot fue expulsado o se salió
            if (newStatus === "left" || newStatus === "kicked") {
                console.log(`🚪 El bot fue removido del grupo: ${msg.chat?.title || msg.chat.id}`);
                // ❌ No intentes enviar mensajes aquí, porque ya no tienes permisos
            }
        });

        bot.on("message", async (msg) => {
            const chat = msg.chat;

            if (msg.new_chat_member) {
                const user = msg.new_chat_member;
                console.log("👋 Nuevo usuario:", user.username || user.first_name);

                const inviterId = msg.from.id;
                const inviterUsername = msg.from.username || msg.from.first_name;
                const invitedId = msg.new_chat_member.user.id;
                const invitedUsername = msg.new_chat_member.user.username || msg.new_chat_member.user.first_name;

                const isSuccess = await registerInvitation(
                    inviterId,
                    inviterUsername,
                    invitedId,
                    invitedUsername
                );

                console.log("✅ Invitación procesada");

                if (isSuccess) {
                    await sendTemporaryMessage(
                        chat.id,
                        `👋 ¡Bienvenido ${msg.new_chat_member.user.first_name}!\n` +
                        `✨ Invitado por: @${inviterUsername}`,
                        30000
                    );
                    console.log("✅ Mensaje de bienvenida enviado");
                }
            }

            if (msg.left_chat_member) {
                const user = msg.left_chat_member;
                console.log("👋 Usuario salió:", user.username || user.first_name);

                await sendTemporaryMessage(
                    chat.id,
                    `👋 @${user.username} salió del grupo`,
                    10000
                );
            }
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