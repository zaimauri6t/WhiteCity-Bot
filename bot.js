const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

// Discord Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
    ],
});

// Express Server for Roblox to check
const app = express();
app.use(express.json());

// In-memory storage (replace with a real database in production)
const verifiedUsers = new Map(); // Map<robloxUserId, discordUserId>

// Configuration
const CONFIG = {
    GUILD_ID: process.env.GUILD_ID, // Your Discord Server ID
    REQUIRED_ROLE_ID: process.env.REQUIRED_ROLE_ID, // The role ID players need
    API_KEY: process.env.API_KEY, // Secret key for Roblox to authenticate
    PORT: process.env.PORT || 3000,
};

// Slash command definition
const commands = [
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Link your Roblox account to access the game')
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Your Roblox username')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('unverify')
        .setDescription('Unlink your Roblox account'),
    new SlashCommandBuilder()
        .setName('checkstatus')
        .setDescription('Check your verification status'),
].map(command => command.toJSON());

// Register slash commands
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, CONFIG.GUILD_ID),
            { body: commands }
        );
        console.log('Successfully registered slash commands!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Get Roblox User ID from username
async function getRobloxUserId(username) {
    try {
        const response = await axios.post('https://users.roblox.com/v1/usernames/users', {
            usernames: [username],
            excludeBannedUsers: true
        });
        
        if (response.data.data && response.data.data.length > 0) {
            return response.data.data[0].id;
        }
        return null;
    } catch (error) {
        console.error('Error fetching Roblox user:', error);
        return null;
    }
}

// Check if user has required role
async function hasRequiredRole(member) {
    return member.roles.cache.has(CONFIG.REQUIRED_ROLE_ID);
}

// Bot ready event
client.once('ready', () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    registerCommands();
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'verify') {
        const username = interaction.options.getString('username');
        const member = interaction.member;

        // Check if user has required role
        if (!await hasRequiredRole(member)) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Verification Failed')
                .setDescription(`You don't have the required role to access the game!\n\nPlease contact a server administrator.`)
                .setTimestamp();
            
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // Get Roblox User ID
        const robloxUserId = await getRobloxUserId(username);
        
        if (!robloxUserId) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ User Not Found')
                .setDescription(`Could not find a Roblox user with username: **${username}**\n\nPlease check your spelling and try again.`)
                .setTimestamp();
            
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // Store verification
        verifiedUsers.set(robloxUserId.toString(), {
            discordId: member.id,
            discordTag: member.user.tag,
            robloxUsername: username,
            verifiedAt: new Date().toISOString()
        });

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ Verification Successful!')
            .setDescription(`Your Roblox account **${username}** (ID: ${robloxUserId}) has been linked!`)
            .addFields(
                { name: 'Discord', value: member.user.tag, inline: true },
                { name: 'Roblox', value: username, inline: true }
            )
            .setFooter({ text: 'You can now join the Roblox game!' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });

    } else if (commandName === 'unverify') {
        // Find and remove user's verification
        let removed = false;
        for (const [robloxId, data] of verifiedUsers.entries()) {
            if (data.discordId === interaction.user.id) {
                verifiedUsers.delete(robloxId);
                removed = true;
                break;
            }
        }

        const embed = new EmbedBuilder()
            .setColor(removed ? '#00FF00' : '#FF0000')
            .setTitle(removed ? '✅ Unverified' : '❌ Not Found')
            .setDescription(removed ? 'Your Roblox account has been unlinked.' : 'You don\'t have any verified Roblox account.')
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });

    } else if (commandName === 'checkstatus') {
        // Find user's verification
        let userData = null;
        for (const [robloxId, data] of verifiedUsers.entries()) {
            if (data.discordId === interaction.user.id) {
                userData = { robloxId, ...data };
                break;
            }
        }

        if (userData) {
            const hasRole = await hasRequiredRole(interaction.member);
            const embed = new EmbedBuilder()
                .setColor(hasRole ? '#00FF00' : '#FFA500')
                .setTitle('📊 Verification Status')
                .addFields(
                    { name: 'Roblox Username', value: userData.robloxUsername, inline: true },
                    { name: 'Roblox ID', value: userData.robloxId, inline: true },
                    { name: 'Has Required Role', value: hasRole ? '✅ Yes' : '❌ No', inline: true },
                    { name: 'Verified At', value: new Date(userData.verifiedAt).toLocaleString(), inline: false }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Not Verified')
                .setDescription('You haven\'t verified your Roblox account yet.\n\nUse `/verify <username>` to get started!')
                .setTimestamp();

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
});

// Express API endpoint for Roblox to check if a user is verified
app.get('/api/check/:userId', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    
    // Verify API key
    if (apiKey !== CONFIG.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.params.userId;
    const userData = verifiedUsers.get(userId);

    if (!userData) {
        return res.json({ verified: false });
    }

    // Check if the Discord user still has the required role
    try {
        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const member = await guild.members.fetch(userData.discordId);
        const hasRole = await hasRequiredRole(member);

        return res.json({
            verified: hasRole,
            discordTag: userData.discordTag,
            robloxUsername: userData.robloxUsername
        });
    } catch (error) {
        // User might have left the server
        console.error('Error checking user role:', error);
        return res.json({ verified: false });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'online', verifiedUsers: verifiedUsers.size });
});

// Start Express server
app.listen(CONFIG.PORT, () => {
    console.log(`🌐 API server running on port ${CONFIG.PORT}`);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
