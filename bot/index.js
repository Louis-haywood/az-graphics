require('dotenv').config();
const {
    Client, GatewayIntentBits, PermissionFlagsBits, ChannelType,
    EmbedBuilder, REST, Routes, SlashCommandBuilder, AttachmentBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
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
        client_id: process.env.DISCORD_CLIENT_ID, redirect_uri: process.env.REDIRECT_URI,
        response_type: 'code', scope: 'identify guilds.join',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/?auth_error=1#shop`);
    try {
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
            new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.REDIRECT_URI }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const { access_token } = tokenRes.data;
        const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
        const user = userRes.data;

        const guild = bot.guilds.cache.get(process.env.DISCORD_GUILD_ID);
        if (guild) { try { await guild.members.add(user.id, { accessToken: access_token }); } catch {} }

        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { id: user.id, username: user.global_name || user.username, avatar: user.avatar || '', createdAt: Date.now() });
        const params = new URLSearchParams({ session: token, uid: user.id, username: user.global_name || user.username, avatar: user.avatar || '' });
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
            try {
                const member = await guild.members.fetch(discordId).catch(() => null);
                if (member) overwrites.push({ id: discordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] });
            } catch {}
        }

        const staffRoleId = process.env.DISCORD_STAFF_ROLE_ID;
        if (staffRoleId) {
            const staffRole = guild.roles.cache.get(staffRoleId);
            if (staffRole) overwrites.push({ id: staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] });
        }

        const channel = await guild.channels.create({
            name: `order-${safeName}-${Date.now().toString(36)}`,
            type: ChannelType.GuildText,
            parent: process.env.DISCORD_ORDER_CATEGORY_ID || null,
            permissionOverwrites: overwrites,
            topic: `Order from ${username} | ${totalField?.value || ''} | uid:${discordId || 'N/A'}`
        });

        const userPing   = discordId && discordId !== 'N/A' ? `<@${discordId}>` : `**${username}**`;
        const staffPing  = process.env.DISCORD_STAFF_ROLE_ID ? `<@&${process.env.DISCORD_STAFF_ROLE_ID}>` : '';
        const hasProof   = itemsField?.value?.toLowerCase().includes('edited');
        const totalNum   = totalField?.value?.replace(/[^0-9.]/g, '') || '';
        const paypalLink = `https://www.paypal.me/AzGraphics11${totalNum ? `/${totalNum}` : ''}`;

        const orderEmbed = new EmbedBuilder()
            .setTitle('🛒 New Order — Az Graphics').setColor(0xC9A028)
            .addFields(
                { name: 'Customer', value: username, inline: true },
                { name: 'Total', value: totalField?.value || '—', inline: true },
                { name: 'Items', value: itemsField?.value || '—' }
            ).setTimestamp().setFooter({ text: 'Az Graphics' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`paid_${channel.id}`)
                .setLabel('✅ I\'ve Paid')
                .setStyle(ButtonStyle.Success)
        );

        await channel.send({
            content: `Hey ${userPing}! 👋 Thanks for your order — this is your private channel where we'll handle everything.\n\n**To complete your order, please pay using the link below:**\n> 💳 **[Click here to pay £${totalNum} via PayPal](${paypalLink})**\n\nOnce you've paid, click the button below and staff will be notified!${hasProof ? '\n\n⚠️ **Proof of ownership required** for Edited Graphics items — please upload it here before we can fulfil your order.' : ''}\n\n${staffPing}`.trim(),
            embeds: [orderEmbed],
            components: [row]
        });

        console.log(`Order channel created: ${channel.name} for ${username}`);
    } catch (err) { console.error('Failed to create order channel:', err); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchAllMessages(channel) {
    const messages = [];
    let lastId = null;
    while (true) {
        const opts = { limit: 100 };
        if (lastId) opts.before = lastId;
        const batch = await channel.messages.fetch(opts);
        if (!batch.size) break;
        messages.unshift(...batch.values());
        lastId = batch.last()?.id;
        if (batch.size < 100) break;
    }
    return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function buildTranscript(channel, messages) {
    const lines = [
        `Az Graphics — Order Channel Transcript`,
        `Channel : #${channel.name}`,
        `Exported: ${new Date().toLocaleString('en-GB')}`,
        '─'.repeat(60), ''
    ];
    for (const msg of messages) {
        const time   = new Date(msg.createdTimestamp).toLocaleString('en-GB');
        const author = msg.author?.bot ? `[BOT] ${msg.author.username}` : (msg.author?.username || 'Unknown');
        let content  = msg.content || '';
        if (msg.embeds.length)     content += (content ? '\n  ' : '') + msg.embeds.map(e => `[Embed: ${e.title || 'embed'}]`).join('\n  ');
        if (msg.attachments.size)  content += (content ? '\n  ' : '') + `[${msg.attachments.size} attachment(s)]`;
        lines.push(`[${time}] ${author}: ${content || '(no content)'}`);
    }
    return lines.join('\n');
}

function buildReceiptEmbed(username, itemsText, total, paid, note) {
    const orderId = `AZG-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const embed = new EmbedBuilder()
        .setTitle(paid ? '🧾 Payment Receipt — Az Graphics' : '📋 Order Closed — Az Graphics')
        .setColor(paid ? 0x00C851 : 0xFF4444)
        .setDescription(paid
            ? `Thank you for your purchase, **${username}**! Your files will be sent to you shortly. Keep this receipt for your records.`
            : `Hi **${username}**, your order channel has been closed.`)
        .addFields(
            { name: 'Order Reference', value: `\`${orderId}\``,   inline: true },
            { name: 'Date',            value: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }), inline: true },
            { name: '​',          value: '​',            inline: true },
            { name: 'Customer',        value: username,            inline: true },
            { name: 'Total',           value: total || '—',        inline: true },
            { name: 'Payment',         value: paid ? '✅ Confirmed' : '❌ Not Paid', inline: true },
            { name: 'Items',           value: itemsText || '—' }
        )
        .setTimestamp()
        .setFooter({ text: 'Az Graphics | For support join our Discord server' });
    if (note) embed.addFields({ name: 'Staff Note', value: note });
    return embed;
}

// ── Interactions ──────────────────────────────────────────────────────────────
bot.on('interactionCreate', async (interaction) => {

    // ── "I've Paid" button ────────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('paid_')) {
        const topicMatch = interaction.channel.topic?.match(/uid:(\d+)/);
        const buyerId    = topicMatch?.[1];

        if (buyerId && interaction.user.id !== buyerId) {
            return interaction.reply({ content: '❌ Only the person who placed this order can click this button.', ephemeral: true });
        }

        const staffPing = process.env.DISCORD_STAFF_ROLE_ID ? `<@&${process.env.DISCORD_STAFF_ROLE_ID}>` : 'Staff';
        await interaction.update({ components: [] });
        await interaction.channel.send({
            content: `💰 **Payment claimed by ${interaction.user}!**\n\n${staffPing} — please verify the payment and deliver the files. Once confirmed, use \`/closeorder paid:True\` to close this ticket.`
        });
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    // /imageupload
    if (interaction.commandName === 'imageupload') {
        const allowedRole = process.env.PORTFOLIO_ROLE_ID;
        if (allowedRole && !interaction.member.roles.cache.has(allowedRole))
            return interaction.reply({ content: '❌ You don\'t have permission to upload portfolio images.', ephemeral: true });

        const attachment = interaction.options.getAttachment('image');
        const caption    = interaction.options.getString('caption') || '';
        if (!attachment.contentType?.startsWith('image/'))
            return interaction.reply({ content: '❌ Please attach a valid image file.', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });
        try {
            const ext      = path.extname(attachment.name) || '.jpg';
            const filename = `portfolio_${Date.now()}${ext}`;
            const imgRes   = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            fs.writeFileSync(path.join(PORTFOLIO_DIR, filename), imgRes.data);

            const images = JSON.parse(fs.readFileSync(PORTFOLIO_JSON, 'utf8'));
            images.push({ file: filename, caption });
            fs.writeFileSync(PORTFOLIO_JSON, JSON.stringify(images, null, 2));

            await interaction.editReply({ content: `✅ **${attachment.name}** uploaded to the portfolio!${caption ? ` Caption: "${caption}"` : ''} It will go live within 10 seconds.` });
            console.log(`Portfolio image saved: ${filename}`);
        } catch (err) {
            console.error('Image upload error:', err);
            await interaction.editReply({ content: '❌ Something went wrong uploading the image.' });
        }
    }

    // /closeorder
    if (interaction.commandName === 'closeorder') {
        if (process.env.DISCORD_STAFF_ROLE_ID && !interaction.member.roles.cache.has(process.env.DISCORD_STAFF_ROLE_ID))
            return interaction.reply({ content: '❌ Only staff can close orders.', ephemeral: true });

        const paid    = interaction.options.getBoolean('paid');
        const note    = interaction.options.getString('note') || '';
        const channel = interaction.channel;

        if (!channel.name.startsWith('order-'))
            return interaction.reply({ content: '❌ This command can only be used in an order channel.', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        try {
            // Get buyer ID from channel topic
            const topicMatch = channel.topic?.match(/uid:(\d+)/);
            const buyerId    = topicMatch?.[1];

            // Fetch all messages
            const messages   = await fetchAllMessages(channel);

            // Get order details from first order embed
            const orderMsg   = messages.find(m => m.embeds.some(e => e.title?.includes('New Order')));
            const orderEmbed = orderMsg?.embeds.find(e => e.title?.includes('New Order'));
            const itemsField = orderEmbed?.fields.find(f => f.name === 'Items');
            const totalField = orderEmbed?.fields.find(f => f.name === 'Total');
            const nameField  = orderEmbed?.fields.find(f => f.name === 'Customer');
            const username   = nameField?.value || 'Customer';

            // Build transcript file
            const transcriptText       = buildTranscript(channel, messages);
            const transcriptBuffer     = Buffer.from(transcriptText, 'utf8');
            const transcriptAttachment = new AttachmentBuilder(transcriptBuffer, { name: `${channel.name}-transcript.txt` });

            // Build receipt embed
            const receiptEmbed = buildReceiptEmbed(username, itemsField?.value, totalField?.value, paid, note);

            // Assign paid role to buyer
            if (paid && buyerId) {
                try {
                    const member = await interaction.guild.members.fetch(buyerId).catch(() => null);
                    if (member) await member.roles.add('958729075525054504');
                } catch (err) {
                    console.error('Failed to assign paid role:', err);
                }
            }

            // DM the buyer
            if (buyerId) {
                try {
                    const buyer = await bot.users.fetch(buyerId);
                    const dmMsg = paid
                        ? `Hey **${username}**! 🎉 Your Az Graphics order has been completed and payment confirmed. Here's your receipt and a full transcript of your order channel for your records.`
                        : `Hey **${username}**, your Az Graphics order channel has been closed. Here's a transcript for your records.`;
                    await buyer.send({ content: dmMsg, embeds: [receiptEmbed], files: [transcriptAttachment] });
                } catch {
                    await channel.send({ content: `⚠️ Couldn't DM <@${buyerId}> — their DMs may be closed.` });
                }
            }

            // Post to transcript log channel
            const logChannelId = process.env.DISCORD_TRANSCRIPT_CHANNEL_ID;
            if (logChannelId) {
                const logChannel = interaction.guild.channels.cache.get(logChannelId);
                if (logChannel) {
                    await logChannel.send({
                        content: `**Order closed** by ${interaction.user.username} | Paid: ${paid ? '✅ Yes' : '❌ No'} | Channel: \`#${channel.name}\``,
                        embeds:  [receiptEmbed],
                        files:   [transcriptAttachment]
                    });
                }
            }

            // Post closing message in channel
            await channel.send({
                content: `🔒 **This order channel has been closed.**\n> **Paid:** ${paid ? '✅ Yes' : '❌ No'}${note ? `\n> **Note:** ${note}` : ''}\n\nA transcript has been sent${buyerId ? ' to the buyer\'s DMs and' : ' to'} the staff logs.`,
                embeds: [receiptEmbed]
            });

            // Rename and lock the channel
            const cleanName = channel.name.replace(/^(order-|closed-)/, '');
            const newOverwrites = [
                { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] }
            ];
            if (buyerId) {
                newOverwrites.push({ id: buyerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] });
            }
            if (process.env.DISCORD_STAFF_ROLE_ID) {
                newOverwrites.push({ id: process.env.DISCORD_STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] });
            }

            await channel.edit({ name: `closed-${cleanName}`, permissionOverwrites: newOverwrites });
            await interaction.editReply({ content: `✅ Order closed. Transcript sent.` });

        } catch (err) {
            console.error('Close order error:', err);
            await interaction.editReply({ content: `❌ Something went wrong: ${err.message}` });
        }
    }
});

// ── Bot ready — register commands ─────────────────────────────────────────────
bot.once('ready', async () => {
    console.log(`Bot online: ${bot.user.tag}`);
    try {
        const rest     = new REST().setToken(process.env.DISCORD_BOT_TOKEN);
        const commands = [
            new SlashCommandBuilder()
                .setName('imageupload')
                .setDescription('Upload an image to the Az Graphics portfolio')
                .addAttachmentOption(o => o.setName('image').setDescription('The image to upload').setRequired(true))
                .addStringOption(o => o.setName('caption').setDescription('Optional caption').setRequired(false)),

            new SlashCommandBuilder()
                .setName('closeorder')
                .setDescription('Close an order channel, send receipt and transcript')
                .addBooleanOption(o => o.setName('paid').setDescription('Was this order paid?').setRequired(true))
                .addStringOption(o => o.setName('note').setDescription('Optional note to include in the receipt').setRequired(false))
        ];

        await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands.map(c => c.toJSON()) });
        console.log('Slash commands registered');
    } catch (err) { console.error('Failed to register commands:', err); }
});

bot.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
