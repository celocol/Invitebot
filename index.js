// index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const http = require('http');
const pg = require('pg');
const { Pool, types } = pg;

// Parse PG int8 (OID 20) as string para evitar precision loss en JS
types.setTypeParser(20, (val) => val);

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MODE = (process.env.MODE || 'polling').toLowerCase(); // 'polling' | 'webhook'
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing in .env file');
  // no salimos: dejamos el server de health vivo para ver logs
}
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is missing in .env file');
  // tampoco salimos
}

const bot = new Telegraf(BOT_TOKEN || 'MISSING_BOT_TOKEN');

// 🚨 Fuerza SSL siempre (Railway)
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ====== DB SCHEMA ======
async function initializeDatabase() {
  if (!DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL missing; skipping DB init');
    return;
  }
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS invites (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        joined_user_id BIGINT NOT NULL,
        joined_username TEXT,
        inviter_user_id BIGINT,
        inviter_username TEXT,
        method TEXT NOT NULL, -- 'added' | 'invite_link' | 'approved' | 'self_join'
        invite_link TEXT,
        invite_link_creator_id BIGINT,
        invite_link_creator_username TEXT,
        joined_at BIGINT NOT NULL
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_invites_chat_joined ON invites(chat_id, joined_user_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_invites_chat_inviter ON invites(chat_id, inviter_user_id);`);
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ Database initialization failed:', err);
    // no hacemos exit; el bot puede seguir (health/webhook responderán 200)
  }
}

async function insertInvite(
  chatId, joinedUserId, joinedUsername, inviterUserId, inviterUsername,
  method, inviteLink, inviteLinkCreatorId, inviteLinkCreatorUsername, joinedAt
) {
  if (!DATABASE_URL) return;
  try {
    await db.query(
      `INSERT INTO invites (
        chat_id, joined_user_id, joined_username, inviter_user_id, inviter_username,
        method, invite_link, invite_link_creator_id, invite_link_creator_username, joined_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        String(chatId),
        String(joinedUserId),
        joinedUsername || null,
        inviterUserId != null ? String(inviterUserId) : null,
        inviterUsername || null,
        method,
        inviteLink || null,
        inviteLinkCreatorId != null ? String(inviteLinkCreatorId) : null,
        inviteLinkCreatorUsername || null,
        Number(joinedAt)
      ]
    );
  } catch (err) {
    console.error('Error inserting invite:', err);
  }
}

function usernameOf(user) {
  if (!user) return null;
  if (user.username) return '@' + user.username;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return name || String(user.id);
}

// ====== EVENT HANDLERS ======
bot.on('new_chat_members', async (ctx) => {
  try {
    const msg = ctx.message;
    const chatId = msg.chat.id;
    const inviter = msg.from;

    for (const member of msg.new_chat_members) {
      let method = 'self_join';
      let inviterUser = null;

      if (inviter && inviter.id !== member.id) {
        method = 'added';
        inviterUser = inviter;
      }

      await insertInvite(
        chatId,
        member.id,
        usernameOf(member),
        inviterUser ? inviterUser.id : null,
        inviterUser ? usernameOf(inviterUser) : null,
        method,
        null,
        null,
        null,
        Math.floor(Date.now() / 1000)
      );
    }
  } catch (e) {
    console.error('new_chat_members handler error:', e);
  }
});

bot.on('chat_member', async (ctx) => {
  try {
    const upd = ctx.update.chat_member;
    const chatId = upd.chat.id;
    const oldStatus = upd.old_chat_member?.status;
    const newStatus = upd.new_chat_member?.status;
    const joinedNow =
      (oldStatus !== 'member' && newStatus === 'member') ||
      (oldStatus !== 'restricted' && newStatus === 'restricted');

    if (!joinedNow) return;

    const joinedUser = upd.new_chat_member?.user;
    const actor = upd.from;
    const link = upd.invite_link || null;

    let method = 'self_join';
    let inviterUser = null;
    let inviteLinkStr = null;
    let linkCreator = null;

    if (link) {
      method = 'invite_link';
      inviteLinkStr = link.invite_link || null;
      linkCreator = link.creator || null;
    }
    if (actor && joinedUser && actor.id !== joinedUser.id) {
      method = link ? 'invite_link' : 'approved';
      inviterUser = actor;
    }

    await insertInvite(
      chatId,
      joinedUser.id,
      usernameOf(joinedUser),
      inviterUser ? inviterUser.id : linkCreator ? linkCreator.id : null,
      inviterUser ? usernameOf(inviterUser) : linkCreator ? usernameOf(linkCreator) : null,
      method,
      inviteLinkStr,
      linkCreator ? linkCreator.id : null,
      linkCreator ? usernameOf(linkCreator) : null,
      Math.floor(Date.now() / 1000)
    );
  } catch (e) {
    console.error('chat_member handler error', e);
  }
});

bot.command('start', (ctx) => ctx.reply('Invite Tracker bot is running ✅'));

bot.command('myinvites', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const me = String(ctx.from.id);
  try {
    const result = await db.query(
      `SELECT COUNT(*) AS c FROM invites WHERE chat_id = $1 AND inviter_user_id = $2`,
      [chatId, me]
    );
    const count = result.rows[0]?.c ?? 0;
    ctx.reply(`You have invited/approved ${count} member(s) to this group.`);
  } catch (err) {
    console.error('Error in myinvites:', err);
    ctx.reply('Error retrieving invite count.');
  }
});

bot.command('topinviters', async (ctx) => {
  const chatId = String(ctx.chat.id);
  try {
    const result = await db.query(
      `SELECT inviter_user_id, inviter_username, COUNT(*) AS c
       FROM invites
       WHERE chat_id = $1 AND inviter_user_id IS NOT NULL
       GROUP BY inviter_user_id, inviter_username
       ORDER BY c::INT DESC
       LIMIT 10`,
      [chatId]
    );
    if (!result.rows.length) return ctx.reply('No inviter data yet.');
    const lines = result.rows.map((r, i) =>
      `${i + 1}. ${r.inviter_username || r.inviter_user_id}: ${r.c}`
    );
    ctx.reply('🏆 Top inviters:\n' + lines.join('\n'));
  } catch (err) {
    console.error('Error in topinviters:', err);
    ctx.reply('Error retrieving top inviters.');
  }
});

bot.command('whoadded', async (ctx) => {
  const chatId = String(ctx.chat.id);
  let targetId = null;
  try {
    if (ctx.message.reply_to_message) {
      targetId = String(ctx.message.reply_to_message.from.id);
    } else {
      const parts = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
      if (!parts) return ctx.reply('Reply to a user or pass @username/userId.');
      const result = await db.query(
        `SELECT joined_user_id FROM invites
         WHERE chat_id = $1 AND (joined_username = $2 OR joined_user_id = $3)
         ORDER BY joined_at DESC LIMIT 1`,
        [chatId, parts.startsWith('@') ? parts : '@' + parts, String(Number(parts) || -1)]
      );
      if (result.rows.length > 0) targetId = String(result.rows[0].joined_user_id);
    }

    if (!targetId) return ctx.reply('User not found in logs.');

    const result = await db.query(
      `SELECT inviter_username, inviter_user_id, method, invite_link,
              invite_link_creator_username, invite_link_creator_id, joined_at
       FROM invites
       WHERE chat_id = $1 AND joined_user_id = $2
       ORDER BY joined_at DESC
       LIMIT 1`,
      [chatId, targetId]
    );

    if (!result.rows.length) return ctx.reply('No entry found for that user.');

    const row = result.rows[0];
    const when = new Date(Number(row.joined_at) * 1000).toLocaleString();
    if (row.method === 'added' || row.method === 'approved') {
      return ctx.reply(`User was ${row.method} by ${row.inviter_username || row.inviter_user_id} on ${when}.`);
    }
    if (row.method === 'invite_link') {
      return ctx.reply(
        `User joined via invite link${row.invite_link ? ` (${row.invite_link})` : ''} ` +
        `created by ${row.invite_link_creator_username || row.invite_link_creator_id || 'unknown'} on ${when}.`
      );
    }
    return ctx.reply(`User self-joined on ${when}.`);
  } catch (err) {
    console.error('Error in whoadded:', err);
    ctx.reply('Error retrieving user information.');
  }
});

// ====== START (Webhook o Polling) + Healthcheck ======
async function start() {
  // 1) Levanta HTTP primero (para evitar 502 en /health)
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('InviteTracker up');
  });
  server.listen(PORT, () => {
    console.log(`HTTP health on :${PORT}`);
  });

  if (MODE === 'webhook') {
    if (!WEBHOOK_DOMAIN) {
      console.error('❌ WEBHOOK_DOMAIN required in webhook mode');
    } else {
      const path = '/telegram/webhook';
      const webhookUrl = `${WEBHOOK_DOMAIN}${path}`;
      try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log('🔗 Webhook set to:', webhookUrl);
      } catch (e) {
        console.error('Failed to set webhook:', e);
      }

      // ⭐️ ACK inmediato y proceso en background
      server.on('request', (req, res) => {
        if (req.method === 'POST' && req.url === path) {
          let body = '';
          console.log('[WEBHOOK] hit', new Date().toISOString());
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1e6) {
              console.warn('[WEBHOOK] payload too large');
              res.writeHead(413, { 'Content-Type': 'text/plain' });
              return res.end('Payload too large');
            }
          });
          req.on('end', () => {
            // Responder YA para evitar 502 en Telegram
            try {
              res.writeHead(200, { 'Content-Type': 'text/plain' });
              res.end('OK');
            } catch (_) {}

            // Procesar el update en segundo plano
            try {
              const update = JSON.parse(body);
              console.log('[WEBHOOK] update received (truncated):', body.slice(0, 200));
              bot.handleUpdate(update).catch((e) => {
                console.error('handleUpdate error:', e);
              });
            } catch (e) {
              console.error('Webhook JSON parse error:', e, 'body:', body.slice(0, 200));
            }
          });
          return;
        }
      });
    }
  } else {
    // Polling: elimina webhook y arranca polling
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      console.log('🧹 Webhook eliminado (polling activo)');
    } catch (e) {
      console.warn('No se pudo eliminar webhook (puede no existir):', e.message);
    }
    await bot.launch();
    console.log('▶️ Polling iniciado');
  }

  console.log('🚀 Bot started (server up). DB init will run next…');
}

// Errores globales (no tumbar el proceso)
process.on('unhandledRejection', (r) => console.error('UNHANDLED REJECTION:', r));
process.on('uncaughtException', (e) => console.error('UNCAUGHT EXCEPTION:', e));

// Secuencia: server -> (webhook/polling) -> DB init
start()
  .then(() => initializeDatabase())
  .catch((e) => console.error('Fatal start error:', e));

// Apagado limpio
async function shutdown(sig) {
  console.log(`\nReceived ${sig}. Shutting down...`);
  try {
    await bot.stop(sig);
    if (DATABASE_URL) await db.end();
    process.exit(0);
  } catch (e) {
    console.error('Error during shutdown:', e);
    process.exit(1);
  }
}
['SIGINT', 'SIGTERM'].forEach((sig) => process.once(sig, () => shutdown(sig)));