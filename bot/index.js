require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');

// ── Setup ─────────────────────────────────────────────────────────────────────
const bot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const app = express();
app.use(cors());
app.use(express.json());

const REPO_DIR       = path.join(__dirname, '..');
const PORTFOLIO_DIR  = path.join(REPO_DIR, 'assets', 'portfolio');
const PORTFOLIO_JSON = path.join(PORTFOLIO_DIR, 'images.json');
fs.mkdirSync(PORTFOLIO_DIR, { recursive: true });
if (!fs.existsSync(PORTFOLIO_JSON)) fs.writeFileSync(PORTFOLIO_JSON, '[]');

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessions = new Map();
setInterval(() => {
    const cutoff = Date.now() - 86400000;
    for (const [token, s] of sessions)
        if (s.createdAt < cutoff) sessions.delete(token);
}, 3600000);

// ── Portfolio API ─────────────────────────────────────────────────────────────
app.get('/api/portfolio', (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(PORTFOLIO_JSON, 'utf8'))); }
    catch { res.json([]); }
});

app.use('/portfolio-images', express.static(PORTFOLIO_DIR));

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
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/?auth_error=1#shop`);

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

        const guild = bot.guilds.cache.get(process.env.DISCORD_GUILD_ID);
        if (guild) {
            try { await guild.members.add(user.id, { accessToken: access_token }); }
            catch { /* already in server */ }
        }

        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, {
            id: user.id, username: user.global_name || user.username,
            avatar: user.avatar || '', createdAt: Date.now()
        });

        const params = new URLSearchParams({
            session: token, uid: user.id,
            username: user.global_name || user.username, avatar: user.avatar || ''
        });
        res.redirect(`${process.env.FRONTEND_URL}/?${params}#shop`);

    } catch (err) {
        console.error('OAuth error:', err.response?.data || err.message);
        res.redirect(`${process.env.FRONTEND_URL}/?auth_error=1#shop`);
    }
});

// ── Orders ────────────────────────────────────────────────────────────────────
bot.on('messageCreate', async (message) => {
    if (!message.webhookId) return;
    if (message.channelId !== process.env.DISCORD_ORDERS_CHANNEL_ID) return;
    if (!message.embeds.length) return;

    const embed = message.embeds[0];
    if (embed.title !== '🛒 New Order') return;

    try {
        const totalField = embed.fields.find(f => f.name === 'Total');
        const itemsField = embed.fields.find(f => f.name === 'Items');
        const nameField  = embed.fields.find(f => f.name === 'Customer');
        const idField    = embed.fields.find(f => f.name === 'Discord ID');
        const username   = nameField?.value?.trim() || 'unknown';
        const discordId  = idField?.value?.trim();
        const safeName   = username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
        const guild      = message.guild;

        const overwrites = [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] }];

        if (discordId && discordId !== 'N/A') {
            overwrites.push({
                id: discordId,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles]
            });
        }
        if (process.env.DISCORD_STAFF_ROLE_ID) {
            overwrites.push({
                id: process.env.DISCORD_STAFF_ROLE_ID,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles]
            });
        }

        const channel = await guild.channels.create({
            name: `order-${safeName}-${Date.now().toString(36)}`,
            type: ChannelType.GuildText,
            parent: process.env.DISCORD_ORDER_CATEGORY_ID || null,
            permissionOverwrites: overwrites,
            topic: `Order from ${username} | ${totalField?.value || ''}`
        });

        const userPing  = discordId && discordId !== 'N/A' ? `<@${discordId}>` : `**${username}**`;
        const staffPing = process.env.DISCORD_STAFF_ROLE_ID ? `<@&${process.env.DISCORD_STAFF_ROLE_ID}>` : '';
        const hasProof  = itemsField?.value?.toLowerCase().includes('edited');

        const orderEmbed = new EmbedBuilder()
            .setTitle('🛒 New Order — Az Graphics')
            .setColor(0xC9A028)
            .addFields(
                { name: 'Customer', value: username,                   inline: true },
                { name: 'Total',    value: totalField?.value || '—',   inline: true },
                { name: 'Items',    value: itemsField?.value  || '—' }
            )
            .setTimestamp()
            .setFooter({ text: 'Az Graphics' });

        await channel.send({
            content: `Hey ${userPing}! 👋 Thanks for your order — this is your private channel where we'll handle everything.\n\nA member of staff will be with you shortly to arrange payment and send over your files. Feel free to ask any questions here!${hasProof ? '\n\n⚠️ **Your order includes Edited Graphics.** Please upload proof of ownership here before we can fulfil your order.' : ''}\n\n${staffPing}`.trim(),
            embeds: [orderEmbed]
        });

        console.log(`Order channel created: ${channel.name} for ${username}`);
    } catch (err) {
        console.error('Failed to create order channel:', err);
    }
});

// ── /imageupload slash command ─────────────────────────────────────────────────
bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'imageupload') return;

    const allowedRole = process.env.PORTFOLIO_ROLE_ID;
    if (allowedRole && !interaction.member.roles.cache.has(allowedRole)) {
        return interaction.reply({ content: '❌ You don\'t have permission to upload portfolio images.', ephemeral: true });
    }

    const attachment = interaction.options.getAttachment('image');
    const caption    = interaction.options.getString('caption') || '';

    if (!attachment.contentType?.startsWith('image/')) {
        return interaction.reply({ content: '❌ Please attach a valid image file.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const ext      = path.extname(attachment.name) || '.jpg';
        const filename = `portfolio_${Date.now()}${ext}`;
        const filepath = path.join(PORTFOLIO_DIR, filename);

        const imgRes = await axios.get(attachment.url, { responseType: 'arraybuffer' });
        fs.writeFileSync(filepath, imgRes.data);

        const images = JSON.parse(fs.readFileSync(PORTFOLIO_JSON, 'utf8'));
        images.push({ file: filename, caption });
        fs.writeFileSync(PORTFOLIO_JSON, JSON.stringify(images, null, 2));

        await interaction.editReply({ content: `✅ **${attachment.name}** uploaded to the portfolio!${caption ? ` Caption: "${caption}"` : ''} It will go live within 10 seconds.` });
        console.log(`Portfolio image saved: ${filename}`);
    } catch (err) {
        console.error('Image upload error:', err);
        await interaction.editReply({ content: '❌ Something went wrong. Check that git credentials are set up on the VPS.' });
    }
});

// ── Bot ready ─────────────────────────────────────────────────────────────────
bot.once('ready', async () => {
    console.log(`Bot online: ${bot.user.tag}`);

    try {
        const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);
        const command = new SlashCommandBuilder()
            .setName('imageupload')
            .setDescription('Upload an image to the Az Graphics portfolio')
            .addAttachmentOption(o => o.setName('image').setDescription('The image to upload').setRequired(true))
            .addStringOption(o => o.setName('caption').setDescription('Optional caption for the image').setRequired(false));

        await rest.put(
            Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
            { body: [command.toJSON()] }
        );
        console.log('Slash commands registered');
    } catch (err) {
        console.error('Failed to register commands:', err);
    }
});

bot.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
