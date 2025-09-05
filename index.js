const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const mysql = require('mysql2/promise');
require("dotenv").config();

const app = express();
app.use(express.json());

// Configuración DB
const DB_CONFIG = {
    host: process.env.DB_CONFIG_HOST,
    database: process.env.DB_CONFIG_DATABASE,
    user: process.env.DB_CONFIG_USER,
    password: process.env.DB_CONFIG_PASSWORD,
    port: parseInt(process.env.DB_CONFIG_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

let pool;

// Configuración Bot
const BOT_TOKEN = process.env.BOT_TOKEN;

// Crear conexión a la base de datos
async function createDBConnection() {
    try {
        pool = await mysql.createPool(DB_CONFIG);
        console.log('✅ Conexión a MySQL establecida');
        await createTables();
        return pool;
    } catch (error) {
        console.error('❌ Error conectando a MySQL:', error);
        setTimeout(createDBConnection, 5000);
    }
}

// Crear tablas si no existen
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
        console.log('✅ Tablas creadas/verificadas correctamente');
    } catch (error) {
        console.error('❌ Error creando tablas:', error);
    }
}

// Ejecutar query con reintentos
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
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// Registrar invitación
async function registerInvitation(inviterId, inviterUsername, invitedId, invitedUsername) {
    try {
        const existing = await executeQuery(
            'SELECT * FROM invitations WHERE inviter_id = ? AND invited_id = ?',
            [inviterId, invitedId]
        );

        if (existing.length > 0) {
            console.log('⚠️ Invitación ya registrada');
            return false;
        }

        await executeQuery(
            'INSERT INTO invitations (inviter_id, inviter_username, invited_id, invited_username) VALUES (?, ?, ?, ?)',
            [inviterId, inviterUsername || null, invitedId, invitedUsername || null]
        );

        await executeQuery(
            `INSERT INTO ranking (user_id, username, count) 
             VALUES (?, ?, 1) 
             ON DUPLICATE KEY UPDATE 
             count = count + 1,
             username = VALUES(username)`,
            [inviterId, inviterUsername || 'Unknown']
        );

        console.log(`✅ Invitación registrada: ${inviterUsername} invitó a ${invitedUsername}`);
        return true;
    } catch (error) {
        console.error('❌ Error registrando invitación:', error);
        return false;
    }
}

async function getRanking() {
    try {
        const results = await executeQuery(
            'SELECT username, count FROM ranking ORDER BY count DESC LIMIT 10'
        );
        return results;
    } catch (error) {
        console.error('❌ Error obteniendo ranking:', error);
        return [];
    }
}

async function sendTemporaryMessage(chatId, text, timeout) {
    try {
        const sentMessage = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });

        if (sentMessage && sentMessage.message_id) {
            setTimeout(() => {
                bot.deleteMessage(chatId, sentMessage.message_id).catch(() => {
                    console.warn("⚠️ No se pudo borrar el mensaje temporal");
                });
            }, timeout);
        } else {
            console.warn("⚠️ El mensaje no devolvió message_id, no se puede borrar automáticamente");
        }

    } catch (error) {
        console.error('❌ Error enviando mensaje temporal:', error);
    }
}

async function isUserAdmin(chatId, userId) {
    try {
        const admins = await bot.getChatAdministrators(chatId);
        return admins.some(admin => admin.user.id === userId);
    } catch (error) {
        console.error("❌ Error verificando admin:", error);
        return false;
    }
}

async function getUserInvitations(userId) {
    try {
        const results = await executeQuery(
            'SELECT count FROM ranking WHERE user_id = ?',
            [userId]
        );

        if (results.length === 0) {
            return 0;
        }

        return results[0].count;
    } catch (error) {
        console.error('❌ Error obteniendo invitaciones del usuario:', error);
        return null;
    }
}

async function getUserRankingPosition(userId) {
    try {
        const results = await executeQuery(
            `SELECT 
                COUNT(*) + 1 as position 
             FROM ranking 
             WHERE count > (SELECT COALESCE(count, 0) FROM ranking WHERE user_id = ?)`,
            [userId]
        );

        return results[0].position;
    } catch (error) {
        console.error('❌ Error obteniendo posición en ranking:', error);
        return null;
    }
}


// Endpoint que recibirá los updates de Telegram
app.post("/webhook/telegram", (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

//*****BOT COMMANDS*****//

// Comando /start
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

        let message = '🏆 *TOP 10 - Usuarios que más han invitado:*\n\n';
        ranking.forEach((user, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            message += `${medal} @${user.username}: *${user.count}* invitaciones\n`;
        });

        message += '\n👑 *Comando ejecutado por administrador*';

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
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


//*****BOT COMMANDS*****//


//*****BOT EVENTS*****//
bot.on("chat_member", async (memberStatus) => {
    const { chat, from, new_chat_member, old_chat_member, } = memberStatus;

    console.log("📌 Evento de chat_member detectado");
    console.log("Chat:", chat.title || chat.id);
    console.log("Usuario:", from.username || from.first_name);

    if (new_chat_member.status === 'left' || new_chat_member.status === 'kicked') {
        await bot.sendMessage(chat.id, `👋 ${new_chat_member.user.first_name} salió del grupo`);
    }

    if (new_chat_member.status === 'administrator') {
        await bot.sendMessage(chat.id, `⚡ ${new_chat_member.user.first_name} ahora es administrador`);
    }

    //Nuevo usuario
    if (new_chat_member.status === "member") {
        const inviterId = from.id;
        const inviterUsername = from.username || from.first_name;
        const invitedId = new_chat_member.user.id;
        const invitedUsername =
            new_chat_member.user.username || new_chat_member.user.first_name;

        const isSuccess = await registerInvitation(inviterId, inviterUsername, invitedId, invitedUsername);

        console.log('✅ Invitación procesada');

        if (isSuccess){
            await bot.sendMessage(chat.id,
                `👋 ¡Bienvenido ${new_chat_member.user.first_name}!\n` +
                `✨ Invitado por: @${from.username || from.first_name}`
            );
            console.log('✅ Mensaje de bienvenida enviado');
        }
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

//*****BOT EVENTS*****//


//*****START SERVER*****//
app.listen(3000, async () => {
    console.log("🚀 Servidor Express escuchando en puerto 3000");
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.json({
        status: 'running',
        bot: 'Telegram Invitation Tracker (Node Telegram Bot API)',
        version: '1.0.0'
    });
});

let bot; // única instancia global

async function start() {
    try {
        await createDBConnection();

        if (process.env.NODE_ENV === "production") {
            console.log("🔄 Configurando webhook para producción...");

            const railwayUrl =
                process.env.RAILWAY_PUBLIC_DOMAIN ||
                process.env.RAILWAY_STATIC_URL ||
                process.env.PUBLIC_URL ||
                `${process.env.RAILWAY_SERVICE_NAME || "app"}.up.railway.app`;

            const WEBHOOK_URL = `https://${railwayUrl}/webhook`;

            bot = new TelegramBot(BOT_TOKEN, {
                webHook: {
                    allowed_updates: ["message", "chat_member", "my_chat_member"]
                }
            });

            await bot.setWebHook(WEBHOOK_URL);
            console.log(`✅ Webhook configurado: ${WEBHOOK_URL}`);

            app.post("/webhook", (req, res) => {
                bot.processUpdate(req.body);
                res.sendStatus(200);
            });
        } else {
            console.log("🔄 Usando polling para desarrollo...");

            bot = new TelegramBot(BOT_TOKEN, {
                polling: {
                    params: {
                        allowed_updates: ["message", "chat_member", "my_chat_member"]
                    }
                }
            });
        }

        // Handlers de bot (comandos y eventos)
        bot.on("message", (msg) => {
            console.log("📨 Mensaje recibido:", msg.text);
            bot.sendMessage(msg.chat.id, "👋 Hola, el bot ya está funcionando!");
        });

        console.log("✅ Bot iniciado");

        app.listen(PORT, () => {
            console.log(`✅ Servidor Express en puerto ${PORT}`);
            console.log(`🌍 Modo: ${process.env.NODE_ENV || "development"}`);
        });
    } catch (error) {
        console.error("❌ Error iniciando la aplicación:", error);
        process.exit(1);
    }
}

start();
