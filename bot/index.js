require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');

// ── Discord bot ───────────────────────────────────────────────────────────────
const bot = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// ── Express server ────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

// ── Sessions (in-memory, 24h TTL) ─────────────────────────────────────────────
const sessions = new Map();

setInterval(() => {
    const cutoff = Date.now() - 86400000;
    for (const [token, s] of sessions)
        if (s.createdAt < cutoff) sessions.delete(token);
}, 3600000);

function getSession(req) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    return sessions.get(auth.slice(7)) || null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Start Discord OAuth
app.get('/auth/discord', (req, res) => {
    const params = new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        redirect_uri:  process.env.REDIRECT_URI,
        response_type: 'code',
        scope:         'identify guilds.join',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// OAuth callback — exchanges code, adds user to server, creates session
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
            id:          user.id,
            username:    user.global_name || user.username,
            avatar:      user.avatar || '',
            accessToken: access_token,
            createdAt:   Date.now()
        });

        const params = new URLSearchParams({
            session:  token,
            uid:      user.id,
            username: user.global_name || user.username,
            avatar:   user.avatar || ''
        });
        res.redirect(`${process.env.FRONTEND_URL}/shop.html?${params}`);

    } catch (err) {
        console.error('OAuth error:', err.response?.data || err.message);
        res.redirect(`${process.env.FRONTEND_URL}/shop.html?auth_error=1`);
    }
});

// Verify session
app.get('/api/me', (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ id: session.id, username: session.username, avatar: session.avatar });
});

// Place order — creates private Discord channel and sends embed
app.post('/api/order', async (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const { items, total } = req.body;
    if (!Array.isArray(items) || !items.length)
        return res.status(400).json({ error: 'Cart is empty' });

    try {
        const guild = bot.guilds.cache.get(process.env.DISCORD_GUILD_ID);
        if (!guild) return res.status(500).json({ error: 'Bot not connected to server' });

        const safeName    = session.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
        const channelName = `order-${safeName}-${Date.now().toString(36)}`;

        const overwrites = [
            { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
            {
                id: session.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.AttachFiles,
                ]
            }
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
            name: channelName,
            type: ChannelType.GuildText,
            parent: process.env.DISCORD_ORDER_CATEGORY_ID || null,
            permissionOverwrites: overwrites,
            topic: `Order for ${session.username} | ID: ${session.id}`
        });

        const itemLines = items.map(i =>
            `• **${i.name}** — £${(i.price * (i.qty || 1)).toFixed(2)}${(i.qty || 1) > 1 ? ` (×${i.qty})` : ''}`
        ).join('\n');

        const hasProofItems = items.some(i => i.category === 'Edited Graphics');

        const embed = new EmbedBuilder()
            .setTitle('New Order — Az Graphics')
            .setColor(0xC9A028)
            .addFields(
                { name: 'Customer',      value: `<@${session.id}> (${session.username})`, inline: true },
                { name: 'Order Total',   value: `£${parseFloat(total).toFixed(2)}`,       inline: true },
                { name: '​',        value: '​',                                 inline: true },
                { name: 'Items Ordered', value: itemLines }
            )
            .setTimestamp()
            .setFooter({ text: 'Az Graphics' });

        const proofNotice = hasProofItems
            ? '\n\n⚠️ **Your order includes Edited Graphics.** Please upload proof of ownership for the base files here — your order cannot be fulfilled without it.'
            : '';

        await channel.send({
            content: `Hey <@${session.id}>! 👋 Your order has been received. A member of staff will be with you shortly to arrange payment and delivery.${proofNotice}\n\nPlease stay in this channel — it is your private order thread.`,
            embeds: [embed]
        });

        const invite = await channel.createInvite({
            maxAge:  86400,
            maxUses: 2,
            unique:  true,
            reason:  `Order invite for ${session.username}`
        });

        res.json({ success: true, invite: invite.url });

    } catch (err) {
        console.error('Order error:', err);
        res.status(500).json({ error: 'Failed to create order channel' });
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────
bot.once('ready', () => console.log(`Bot online: ${bot.user.tag}`));
bot.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API server running on port ${PORT}`));
