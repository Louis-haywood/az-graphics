require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');

const bot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessions = new Map();

setInterval(() => {
    const cutoff = Date.now() - 86400000;
    for (const [token, s] of sessions)
        if (s.createdAt < cutoff) sessions.delete(token);
}, 3600000);

// ── OAuth Routes ──────────────────────────────────────────────────────────────

app.get('/auth/discord', (req, res) => {
    const params = new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        redirect_uri:  process.env.REDIRECT_URI,
        response_type: 'code',
        scope:         'identify guilds.join',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/shop.html?auth_error=1`);

    try {
        const tokenRes = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id:     process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type:    'authorization_code',
                code,
                redirect_uri:  process.env.REDIRECT_URI,
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token } = tokenRes.data;

        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${access_token}` }
        });
        const user = userRes.data;

        // Auto-join server
        const guild = bot.guilds.cache.get(process.env.DISCORD_GUILD_ID);
        if (guild) {
            try { await guild.members.add(user.id, { accessToken: access_token }); }
            catch { /* already in server */ }
        }

        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, {
            id:        user.id,
            username:  user.global_name || user.username,
            avatar:    user.avatar || '',
            createdAt: Date.now()
        });

        const params = new URLSearchParams({
            session:  token,
            uid:      user.id,
            username: user.global_name || user.username,
            avatar:   user.avatar || ''
        });
        res.redirect(`${process.env.FRONTEND_URL}/?${params}#shop`);

    } catch (err) {
        console.error('OAuth error:', err.response?.data || err.message);
        res.redirect(`${process.env.FRONTEND_URL}/?auth_error=1#shop`);
    }
});

// ── Watch orders channel for webhook messages ─────────────────────────────────
bot.on('messageCreate', async (message) => {
    if (!message.webhookId) return;
    if (message.channelId !== process.env.DISCORD_ORDERS_CHANNEL_ID) return;
    if (!message.embeds.length) return;

    const embed = message.embeds[0];
    if (embed.title !== '🛒 New Order') return;

    try {
        const totalField    = embed.fields.find(f => f.name === 'Total');
        const itemsField    = embed.fields.find(f => f.name === 'Items');
        const nameField     = embed.fields.find(f => f.name === 'Customer');
        const idField       = embed.fields.find(f => f.name === 'Discord ID');
        const username      = nameField?.value?.trim() || 'unknown';
        const discordId     = idField?.value?.trim();
        const safeName      = username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
        const guild         = message.guild;

        const overwrites = [
            { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] }
        ];

        if (process.env.DISCORD_STAFF_ROLE_ID) {
            overwrites.push({
                id: process.env.DISCORD_STAFF_ROLE_ID,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.AttachFiles,
                ]
            });
        }

        const channel = await guild.channels.create({
            name: `order-${safeName}-${Date.now().toString(36)}`,
            type: ChannelType.GuildText,
            parent:               process.env.DISCORD_ORDER_CATEGORY_ID || null,
            permissionOverwrites: overwrites,
            topic:                `Order from ${username} | ${totalField?.value || ''}`
        });

        const hasProofItems = itemsField?.value?.toLowerCase().includes('edited');

        const orderEmbed = new EmbedBuilder()
            .setTitle('🛒 New Order — Az Graphics')
            .setColor(0xC9A028)
            .addFields(
                { name: 'Customer', value: username,               inline: true },
                { name: 'Total',    value: totalField?.value || '—', inline: true },
                { name: 'Items',    value: itemsField?.value  || '—' }
            )
            .setTimestamp()
            .setFooter({ text: 'Az Graphics' });

        const staffPing = process.env.DISCORD_STAFF_ROLE_ID ? `<@&${process.env.DISCORD_STAFF_ROLE_ID}>` : 'Staff';
        const userPing  = discordId && discordId !== 'N/A' ? `<@${discordId}>` : `**${username}**`;

        await channel.send({
            content: `${staffPing} — New order received from ${userPing}!\n\nPlease reach out to them to arrange payment and delivery.${hasProofItems ? '\n\n⚠️ **Proof of ownership required** for Edited Graphics items.' : ''}`,
            embeds:  [orderEmbed]
        });

        console.log(`Order channel created: ${channel.name} for ${username}`);

    } catch (err) {
        console.error('Failed to create order channel:', err);
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────
bot.once('ready', () => console.log(`Bot online: ${bot.user.tag}`));
bot.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
