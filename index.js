// index.js
require('dotenv').config();               // Load .env file
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing in .env file');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is missing in .env file');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ====== DB SCHEMA ======
async function initializeDatabase() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS invites (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        joined_user_id BIGINT NOT NULL,
        joined_username TEXT,
        inviter_user_id BIGINT,
        inviter_username TEXT,
        method TEXT NOT NULL,
        invite_link TEXT,
        invite_link_creator_id BIGINT,
        invite_link_creator_username TEXT,
        joined_at BIGINT NOT NULL
      );
    `);
    
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_invites_chat_joined ON invites(chat_id, joined_user_id);
    `);
    
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_invites_chat_inviter ON invites(chat_id, inviter_user_id);
    `);
    
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ Database initialization failed:', err);
    process.exit(1);
  }
}

async function insertInvite(chatId, joinedUserId, joinedUsername, inviterUserId, inviterUsername, method, inviteLink, inviteLinkCreatorId, inviteLinkCreatorUsername, joinedAt) {
  try {
    await db.query(`
      INSERT INTO invites (
        chat_id, joined_user_id, joined_username, inviter_user_id, inviter_username,
        method, invite_link, invite_link_creator_id, invite_link_creator_username, joined_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [chatId, joinedUserId, joinedUsername, inviterUserId, inviterUsername, method, inviteLink, inviteLinkCreatorId, inviteLinkCreatorUsername, joinedAt]);
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

// New members (added manually or self-joined)
bot.on('new_chat_members', async (ctx) => {
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
});

// Richer chat_member updates (invite link, approvals)
bot.on('chat_member', async (ctx) => {
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
});

// ====== COMMANDS ======

bot.command('myinvites', async (ctx) => {
  const chatId = ctx.chat.id;
  const me = ctx.from.id;
  try {
    const result = await db.query(`
      SELECT COUNT(*) AS c FROM invites
      WHERE chat_id = $1 AND inviter_user_id = $2
    `, [chatId, me]);
    const count = result.rows[0].c;
    ctx.reply(`You have invited/approved ${count} member(s) to this group.`);
  } catch (err) {
    console.error('Error in myinvites command:', err);
    ctx.reply('Error retrieving invite count.');
  }
});

bot.command('topinviters', async (ctx) => {
  const chatId = ctx.chat.id;
  try {
    const result = await db.query(`
      SELECT inviter_user_id, inviter_username, COUNT(*) AS c
      FROM invites
      WHERE chat_id = $1 AND inviter_user_id IS NOT NULL
      GROUP BY inviter_user_id, inviter_username
      ORDER BY c DESC
      LIMIT 10
    `, [chatId]);

    if (!result.rows.length) return ctx.reply('No inviter data yet.');

    const lines = result.rows.map((r, i) =>
      `${i + 1}. ${r.inviter_username || r.inviter_user_id}: ${r.c}`
    );
    ctx.reply('🏆 Top inviters:\n' + lines.join('\n'));
  } catch (err) {
    console.error('Error in topinviters command:', err);
    ctx.reply('Error retrieving top inviters.');
  }
});

bot.command('whoadded', async (ctx) => {
  const chatId = ctx.chat.id;
  let targetId = null;

  try {
    if (ctx.message.reply_to_message) {
      targetId = ctx.message.reply_to_message.from.id;
    } else {
      const parts = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
      if (!parts) return ctx.reply('Reply to a user or pass @username/userId.');
      
      const result = await db.query(`
        SELECT joined_user_id FROM invites
        WHERE chat_id = $1 AND (joined_username = $2 OR joined_user_id = $3)
        ORDER BY joined_at DESC LIMIT 1
      `, [chatId, parts.startsWith('@') ? parts : '@' + parts, Number(parts) || -1]);
      
      if (result.rows.length > 0) targetId = result.rows[0].joined_user_id;
    }

    if (!targetId) return ctx.reply('User not found in logs.');

    const result = await db.query(`
      SELECT inviter_username, inviter_user_id, method, invite_link,
             invite_link_creator_username, invite_link_creator_id, joined_at
      FROM invites
      WHERE chat_id = $1 AND joined_user_id = $2
      ORDER BY joined_at DESC
      LIMIT 1
    `, [chatId, targetId]);

    if (!result.rows.length) return ctx.reply('No entry found for that user.');

    const row = result.rows[0];
    const when = new Date(row.joined_at * 1000).toLocaleString();
    
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
    console.error('Error in whoadded command:', err);
    ctx.reply('Error retrieving user information.');
  }
});

// Start bot
bot.start((ctx) => ctx.reply('Invite Tracker bot is running ✅'));
bot.catch((err) => console.error('Bot error:', err));

// Initialize database and start bot
async function startBot() {
  await initializeDatabase();
  await bot.launch();
  console.log('🚀 Bot started with PostgreSQL');
}

startBot().catch(console.error);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));