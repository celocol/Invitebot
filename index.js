const { Telegraf } = require('telegraf');
const mysql = require('mysql2/promise');
const express = require('express');
const {message} = require("telegraf/filters");
require('dotenv').config();

//Token del bot y configuración de la base de datos
const BOT_TOKEN = process.env.BOT_TOKEN;
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

// Variables globales
let pool;
const bot = new Telegraf(BOT_TOKEN);

// Manejo global de errores del bot
bot.catch((err, ctx) => {
    console.error('❌ Error en bot:', err);
    console.error('Context:', JSON.stringify({
        update_id: ctx.update.update_id,
        chat_id: ctx.chat?.id,
        user_id: ctx.from?.id,
        message_text: ctx.message?.text
    }, null, 2));
    
    // Intentar responder al usuario sobre el error
    try {
        if (ctx.reply) {
            ctx.reply('❌ Ocurrió un error temporal. Inténtalo de nuevo.');
        }
    } catch (replyError) {
        console.error('❌ No se pudo enviar mensaje de error:', replyError);
    }
});

// Función para crear la conexión a la base de datos
async function createDBConnection(retries = 5) {
    try {
        pool = await mysql.createPool(DB_CONFIG);
        console.log('✅ Conexión a MySQL establecida');
        await createTables();
        return pool;
    } catch (error) {
        console.error(`❌ Error conectando a MySQL (intentos restantes: ${retries - 1}):`, error);
        if (retries > 0) {
            setTimeout(() => createDBConnection(retries - 1), 5000);
        } else {
            console.error('💀 Máximo de reintentos de conexión alcanzado');
            process.exit(1);
        }
    }
}

// Función para crear las tablas si no existen
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

// Función para ejecutar queries con reintentos
async function executeQuery(query, params = []) {
    let retries = 3;
    while (retries > 0) {
        try {
            if (!pool) {
                throw new Error('Pool de conexiones no disponible');
            }
            const [results] = await pool.execute(query, params);
            return results;
        } catch (error) {
            console.error(`❌ Error ejecutando query (intentos restantes: ${retries - 1}):`, error.message);
            retries--;
            
            // Si es error de conexión, intentar reconectar
            if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET') {
                console.log('🔄 Intentando reconectar a la base de datos...');
                try {
                    await createDBConnection();
                } catch (reconnectError) {
                    console.error('❌ Error en reconexión:', reconnectError.message);
                }
            }
            
            if (retries === 0) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// Función para registrar una invitación
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

// Función para obtener el ranking
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

// Función para enviar mensaje temporal que solo el usuario vea
async function sendTemporaryMessage(ctx, message, deleteAfter = 5000) {
    try {
        // Enviar mensaje respondiendo al comando original
        const sentMessage = await ctx.reply(
            message,
            {
                reply_to_message_id: ctx.message.message_id,
                parse_mode: 'Markdown'
            }
        );

        // Eliminar tanto el comando como la respuesta después del tiempo especificado
        setTimeout(async () => {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, sentMessage.message_id);
                await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
            } catch (error) {
                console.log('No se pudieron eliminar los mensajes (normal si son antiguos o el bot no es admin)');
            }
        }, deleteAfter);

        return true;
    } catch (error) {
        console.error('Error enviando mensaje temporal:', error);
        return false;
    }
}

async function isUserAdmin(ctx, userId) {
    try {
        // En chats privados, cualquiera puede usar los comandos
        if (ctx.chat.type === 'private') {
            return true;
        }

        // Obtener información del miembro del chat
        const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, userId);

        // Verificar si es administrador o creador
        return chatMember.status === 'administrator' || chatMember.status === 'creator';
    } catch (error) {
        console.error('❌ Error verificando permisos de admin:', error);
        return false;
    }
}

// Función para obtener las invitaciones de un usuario específico
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

// Middleware para logging
bot.use((ctx, next) => {
    if (ctx.message?.text?.startsWith('/')) {
        console.log('\n=== COMANDO DETECTADO ===');
        console.log('📨 Texto:', ctx.message.text);
        console.log('👤 De:', ctx.from.username || ctx.from.first_name);
        console.log('💬 Tipo de chat:', ctx.chat.type);
        console.log('🏷️ Nombre del chat:', ctx.chat.title || 'Chat privado');
        console.log('🆔 ID del chat:', ctx.chat.id);
        console.log('========================\n');
    }
    return next();
});

// Comando /start
bot.command('start', async (ctx) => {
    console.log('🚀 Procesando comando /start...');

    const message = `👋 ¡Hola @${ctx.from.username || ctx.from.first_name}! Soy un bot que registra las invitaciones a grupos.

📋 *Comandos disponibles:*
/start - Este mensaje
/help - Ayuda y estado
/ranking - Ver el top 10 de usuarios que más han invitado (solo admins)
/misinvitaciones - Ver tus invitaciones personales

💡 *Cómo funciona:*
Cuando alguien añade a una persona al grupo, registro la invitación automáticamente.

⏱️ *Este mensaje se eliminará en 5 segundos...*`;

    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

    if (isGroup) {
        // En grupos, enviar mensaje temporal que se autoelimine
        await sendTemporaryMessage(ctx, message, 5000);
    } else {
        // En chat privado, enviar normalmente (sin eliminar)
        await ctx.reply(message, { parse_mode: 'Markdown' });
    }

    console.log('✅ Start procesado');
});

// Comando /help
bot.command('help', async (ctx) => {
    console.log('❓ Comando /help recibido');

    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    let helpMessage = `📋 *Comandos disponibles para @${username}:*\n\n`;

    // Comandos para todos los usuarios
    helpMessage += '👥 *Para todos los usuarios:*\n';
    helpMessage += '/start - Información del bot\n';
    helpMessage += '/misinvitaciones - Ver tus invitaciones personales\n';
    helpMessage += '/help - Este mensaje\n\n';

    if (isGroup) {
        // Verificar si el usuario es administrador
        const isAdmin = await isUserAdmin(ctx, userId);

        if (isAdmin) {
            helpMessage += '👑 *Para administradores:*\n';
            helpMessage += '/ranking - Top 10 invitadores (solo admins)\n\n';
            helpMessage += '✅ *Tienes permisos de administrador*\n';
        } else {
            helpMessage += '⛔ *Solo para administradores:*\n';
            helpMessage += '/ranking - Top 10 invitadores\n\n';
            helpMessage += '📝 *Nota:* No tienes permisos de administrador\n';
        }

        helpMessage += `📍 Grupo: ${ctx.chat.title}\n`;
        helpMessage += `🆔 ID: ${ctx.chat.id}\n\n`;
        helpMessage += `⏱️ *Este mensaje se eliminará en 8 segundos...*`;

        // Enviar mensaje temporal que se autoelimine
        await sendTemporaryMessage(ctx, helpMessage, 8000);
    } else {
        helpMessage += '👑 *En chat privado (todos disponibles):*\n';
        helpMessage += '/ranking - Top 10 invitadores\n\n';
        helpMessage += '💬 *Estás en chat privado*\n';
        helpMessage += 'Añádeme a un grupo para registrar invitaciones';

        // En chat privado, enviar normalmente
        await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
    }

    console.log(`✅ Help procesado para ${username}`);
});

// Comando /ranking
bot.command('ranking', async (ctx) => {
    console.log('📊 Procesando comando /ranking...');

    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    // Verificar si el usuario es administrador
    const isAdmin = await isUserAdmin(ctx, userId);

    if (!isAdmin) {
        console.log(`⛔ Usuario ${username} intentó usar /ranking sin permisos de admin`);
        await ctx.reply(
            '⛔ *Acceso denegado*\n\n' +
            'Solo los administradores del grupo pueden ver el ranking completo.\n' +
            'Usa /misinvitaciones para ver tus propias estadísticas.',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    try {
        const ranking = await getRanking();

        if (ranking.length === 0) {
            await ctx.reply('📊 No hay datos de ranking todavía.');
            return;
        }

        let message = '🏆 *TOP 10 - Usuarios que más han invitado:*\n\n';
        ranking.forEach((user, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            message += `${medal} @${user.username}: *${user.count}* invitaciones\n`;
        });

        message += '\n👑 *Comando ejecutado por administrador*';

        await ctx.reply(message, { parse_mode: 'Markdown' });
        console.log(`✅ Ranking enviado por admin: ${username}`);
    } catch (error) {
        console.error('❌ Error mostrando ranking:', error);
        ctx.reply('❌ Error al obtener el ranking. Intenta más tarde.');
    }
});

bot.command('misinvitaciones', async (ctx) => {
    console.log('📊 Procesando comando /misinvitaciones...');

    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    try {
        // Obtener el número de invitaciones del usuario
        const invitationCount = await getUserInvitations(userId);

        if (invitationCount === null) {
            await ctx.reply('❌ Error al obtener tus invitaciones. Intenta más tarde.');
            return;
        }

        if (invitationCount === 0) {
            await ctx.reply(
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

        await ctx.reply(message, { parse_mode: 'Markdown' });
        console.log(`✅ Invitaciones mostradas para ${username}: ${invitationCount}`);

    } catch (error) {
        console.error('❌ Error mostrando invitaciones personales:', error);
        ctx.reply('❌ Error al obtener tus invitaciones. Intenta más tarde.');
    }
});

// También puedes agregar un alias más corto
bot.command('mis', async (ctx) => {
    // Reutilizar la misma lógica del comando /misinvitaciones
    return ctx.scene.enter || ctx.telegram.sendMessage(ctx.chat.id, "Usa /misinvitaciones para ver tus invitaciones");
});

// Manejar nuevos miembros en el grupo
bot.on(message('new_chat_members'), async (ctx) => {
    console.log('📥 Nuevos miembros detectados');
    const newMembers = ctx.message.new_chat_members;
    const inviter = ctx.from;

    for (const member of newMembers) {
        // No registrar si el bot se une o si el usuario se une solo
        if (member.is_bot || member.id === inviter.id) continue;

        console.log(`👤 ${inviter.username} invitó a ${member.username}`);

        const success = await registerInvitation(
            inviter.id,
            inviter.username,
            member.id,
            member.username
        );

        if (success) {
            await ctx.reply(
                `👋 ¡Bienvenido ${member.first_name}!\n` +
                `✨ Invitado por: @${inviter.username || inviter.first_name}`
            );
        }
    }
});

// Manejar cuando alguien sale del grupo
bot.on(message("left_chat_member"), (ctx) => {
    const leftMember = ctx.message.left_chat_member;
    console.log(`👋 ${leftMember.first_name} salió del grupo`);
    ctx.reply(`👋 ${leftMember.first_name} ha salido del grupo`);
});

// Detectar cuando el bot es añadido a un grupo
bot.on("my_chat_member", async (ctx) => {
    const newStatus = ctx.update.my_chat_member.new_chat_member.status;
    const oldStatus = ctx.update.my_chat_member.old_chat_member.status;

    console.log("🔔 Cambio en membresía del bot:", {
        chat: ctx.chat?.title || ctx.chat?.id,
        type: ctx.chat?.type,
        new_status: newStatus,
        old_status: oldStatus,
    });

    if ((newStatus === "member" || newStatus === "administrator") && oldStatus === "left") {
        await ctx.reply(
            "👋 ¡Hola! Gracias por añadirme al grupo.\n" +
            "Por favor, hazme administrador para poder detectar las invitaciones.\n" +
            "Usa /help para ver los comandos disponibles."
        );
    }
});

// Configurar Express para health check
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para parsing JSON
app.use(express.json());

app.get('/health', (_, res) => {
    const healthStatus = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: pool ? 'connected' : 'disconnected',
        uptime: process.uptime()
    };
    console.log('👍 Health check:', healthStatus.status);
    res.json(healthStatus);
});

app.get('/', (_, res) => {
    const appInfo = {
        status: 'running',
        bot: 'Telegram Invitation Tracker (Telegraf)',
        version: '2.1.1',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString()
    };
    console.log('📊 App info solicitada:', appInfo);
    res.json(appInfo);
});

// Webhook endpoint para Railway
app.post('/webhook', (req, res) => {
    try {
        bot.handleUpdate(req.body, res);
    } catch (error) {
        console.error('❌ Error en webhook:', error);
        res.status(500).send('Error processing webhook');
    }
});

// Inicializar
async function start() {
    try {
        // Conectar a la base de datos
        await createDBConnection();

        // Configurar bot según entorno
        if (process.env.NODE_ENV === 'production') {
            console.log('🔄 Configurando webhook para producción...');
            
            // Obtener URL de Railway de múltiples fuentes posibles
            const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN || 
                             process.env.RAILWAY_STATIC_URL || 
                             process.env.PUBLIC_URL ||
                             `${process.env.RAILWAY_SERVICE_NAME || 'app'}.up.railway.app`;
            
            const WEBHOOK_URL = `https://${railwayUrl}/webhook`;
            console.log(`🌐 Intentando configurar webhook: ${WEBHOOK_URL}`);
            
            try {
                // Configurar webhook
                await bot.telegram.setWebhook(WEBHOOK_URL);
                console.log(`✅ Webhook configurado: ${WEBHOOK_URL}`);
                
                // Usar webhook callback
                app.use(bot.webhookCallback('/webhook'));
            } catch (webhookError) {
                console.error('❌ Error configurando webhook:', webhookError.message);
                console.log('🔄 Fallback: usando polling en producción...');
                await bot.launch();
                console.log('✅ Bot iniciado en modo polling');
            }
        } else {
            console.log('🔄 Usando polling para desarrollo...');
            await bot.launch();
            console.log('✅ Bot iniciado en modo polling');
        }

        // Iniciar el servidor Express
        app.listen(PORT, () => {
            console.log(`✅ Servidor Express ejecutándose en puerto ${PORT}`);
            console.log(`🌍 Modo: ${process.env.NODE_ENV || 'development'}`);
        });

    } catch (error) {
        console.error('❌ Error iniciando la aplicación:', error);
        process.exit(1);
    }
}

// Manejar cierre graceful
process.once('SIGINT', () => {
    console.log('\n🛑 Recibido SIGINT - Cerrando aplicación...');
    gracefulShutdown('SIGINT');
});

process.once('SIGTERM', () => {
    console.log('\n🛑 Recibido SIGTERM - Cerrando aplicación...');
    gracefulShutdown('SIGTERM');
});

// Función para cierre controlado
async function gracefulShutdown(signal) {
    console.log(`🔄 Iniciando cierre graceful (${signal})...`);
    
    try {
        // Detener bot
        if (process.env.NODE_ENV !== 'production') {
            bot.stop(signal);
            console.log('✅ Bot detenido');
        }
        
        // Cerrar pool de conexiones
        if (pool) {
            await pool.end();
            console.log('✅ Conexiones de DB cerradas');
        }
        
        console.log('✅ Aplicación cerrada correctamente');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error durante el cierre:', error);
        process.exit(1);
    }
}

// Iniciar la aplicación
start();
