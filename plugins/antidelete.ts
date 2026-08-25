import type { BotContext } from '../types.js';
import fs from 'fs';
import path from 'path';
import { dataFile } from '../lib/paths.js';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { writeFile } from 'fs/promises';
import store from '../lib/lightweight_store.js';

const CONFIG_PATH = dataFile('antidelete.json');
const TEMP_MEDIA_DIR = path.join(process.cwd(), 'temp', 'antidelete');
const STORE_PATH = dataFile('antidelete_store.json');

const MONGO_URL = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL = process.env.MYSQL_URL;
const SQLITE_URL = process.env.DB_URL;
const HAS_DB = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

// In-memory cache with persistent backup
let messageStore: Map<string, any> = new Map();
const recentDeletions = new Set<string>();

// Load persisted store on module init
try {
    if (fs.existsSync(STORE_PATH)) {
        const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
        if (Array.isArray(data)) {
            messageStore = new Map(data);
        }
    }
} catch {
    messageStore = new Map();
}

// Persist store every 30 seconds
setInterval(() => {
    try {
        const data = Array.from(messageStore.entries());
        fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
    } catch {}
}, 30000);

// Clear recent deletion IDs every 60 seconds to prevent memory bloat
setInterval(() => recentDeletions.clear(), 60 * 1000);

if (!fs.existsSync(TEMP_MEDIA_DIR)) {
    fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });
}

const getFolderSizeInMB = (folderPath: string) => {
    try {
        const files = fs.readdirSync(folderPath);
        let totalSize = 0;
        for (const file of files) {
            const filePath = path.join(folderPath, file);
            if (fs.statSync(filePath).isFile()) {
                totalSize += fs.statSync(filePath).size;
            }
        }
        return totalSize / (1024 * 1024);
    } catch {
        return 0;
    }
};

const cleanTempFolderIfLarge = () => {
    try {
        const sizeMB = getFolderSizeInMB(TEMP_MEDIA_DIR);
        if (sizeMB > 200) {
            const files = fs.readdirSync(TEMP_MEDIA_DIR);
            for (const file of files) {
                const filePath = path.join(TEMP_MEDIA_DIR, file);
                fs.unlinkSync(filePath);
            }
            messageStore.clear();
            try { fs.writeFileSync(STORE_PATH, '[]'); } catch {}
        }
    } catch {}
};

setInterval(cleanTempFolderIfLarge, 60 * 1000);

async function loadAntideleteConfig() {
    try {
        if (HAS_DB) {
            const config = await store.getSetting('global', 'antidelete');
            return config || { enabled: false };
        } else {
            if (!fs.existsSync(CONFIG_PATH)) return { enabled: false };
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        }
    } catch {
        return { enabled: false };
    }
}

async function saveAntideleteConfig(config: any) {
    try {
        if (HAS_DB) {
            await store.saveSetting('global', 'antidelete', config);
        } else {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        }
    } catch(err: any) {
        console.error('Config save error:', err);
    }
}

function getOwnerJid(sock: any): string {
    try {
        if (sock.user?.id) {
            return sock.user.id.split(':')[0] + '@s.whatsapp.net';
        }
        return '';
    } catch {
        return '';
    }
}

function extractViewOnceMessage(message: any): any {
    const msg = message.message;
    if (!msg) return null;
    if (msg.viewOnceMessageV2?.message) return msg.viewOnceMessageV2.message;
    if (msg.viewOnceMessage?.message) return msg.viewOnceMessage.message;
    if (msg.viewOnceMessageV2Extension?.message) return msg.viewOnceMessageV2Extension.message;
    return null;
}

function isViewOnceMessage(message: any): boolean {
    const msg = message.message;
    if (!msg) return false;
    return !!(msg.viewOnceMessageV2 || msg.viewOnceMessage || msg.viewOnceMessageV2Extension);
}

async function downloadMedia(message: any, messageId: string): Promise<{mediaType: string, mediaPath: string, content: string}> {
    const msg = message.message;
    let mediaType = '';
    let mediaPath = '';
    let content = '';
    
    const viewOnceContainer = extractViewOnceMessage(message);
    
    if (viewOnceContainer?.imageMessage) {
        mediaType = 'image';
        content = viewOnceContainer.imageMessage.caption || '';
        const stream = await downloadContentFromMessage(viewOnceContainer.imageMessage, 'image' as any);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        mediaPath = path.join(TEMP_MEDIA_DIR, `${messageId}.jpg`);
        await writeFile(mediaPath, buffer);
    } else if (viewOnceContainer?.videoMessage) {
        mediaType = 'video';
        content = viewOnceContainer.videoMessage.caption || '';
        const stream = await downloadContentFromMessage(viewOnceContainer.videoMessage, 'video' as any);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        mediaPath = path.join(TEMP_MEDIA_DIR, `${messageId}.mp4`);
        await writeFile(mediaPath, buffer);
    } else if (msg?.imageMessage) {
        mediaType = 'image';
        content = msg.imageMessage.caption || '';
        const stream = await downloadContentFromMessage(msg.imageMessage, 'image' as any);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        mediaPath = path.join(TEMP_MEDIA_DIR, `${messageId}.jpg`);
        await writeFile(mediaPath, buffer);
    } else if (msg?.stickerMessage) {
        mediaType = 'sticker';
        const stream = await downloadContentFromMessage(msg.stickerMessage, 'sticker' as any);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        mediaPath = path.join(TEMP_MEDIA_DIR, `${messageId}.webp`);
        await writeFile(mediaPath, buffer);
    } else if (msg?.videoMessage) {
        mediaType = 'video';
        content = msg.videoMessage.caption || '';
        const stream = await downloadContentFromMessage(msg.videoMessage, 'video' as any);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        mediaPath = path.join(TEMP_MEDIA_DIR, `${messageId}.mp4`);
        await writeFile(mediaPath, buffer);
    } else if (msg?.audioMessage) {
        mediaType = 'audio';
        const mime = msg.audioMessage.mimetype || '';
        const ext = mime.includes('ogg') ? 'ogg' : 'mp3';
        const stream = await downloadContentFromMessage(msg.audioMessage, 'audio' as any);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        mediaPath = path.join(TEMP_MEDIA_DIR, `${messageId}.${ext}`);
        await writeFile(mediaPath, buffer);
    }
    
    return { mediaType, mediaPath, content };
}

export async function storeMessage(sock: any, message: any) {
    try {
        const config = await loadAntideleteConfig();
        if (!config.enabled) return;
        if (!message.key?.id) return;
        if (message.key.fromMe) return;

        const messageId = message.key.id;
        const sender = message.key.participant || message.key.remoteJid;
        const isViewOnce = isViewOnceMessage(message);
        const vOnce = extractViewOnceMessage(message);
        
        const msg = message.message;
        let content = '';
        
        if (msg?.conversation) {
            content = msg.conversation;
        } else if (msg?.extendedTextMessage?.text) {
            content = msg.extendedTextMessage.text;
        } else if (vOnce?.imageMessage?.caption) {
            content = vOnce.imageMessage.caption;
        } else if (vOnce?.videoMessage?.caption) {
            content = vOnce.videoMessage.caption;
        } else if (msg?.imageMessage?.caption) {
            content = msg.imageMessage.caption;
        } else if (msg?.videoMessage?.caption) {
            content = msg.videoMessage.caption;
        }

        const { mediaType, mediaPath } = await downloadMedia(message, messageId);

        // LRU eviction — limit 500 messages
        if (messageStore.size >= 500) {
            const firstKey = messageStore.keys().next().value;
            const firstEntry = messageStore.get(firstKey);
            if (firstEntry?.mediaPath && fs.existsSync(firstEntry.mediaPath)) {
                try { fs.unlinkSync(firstEntry.mediaPath); } catch {}
            }
            messageStore.delete(firstKey);
        }

        messageStore.set(messageId, {
            content,
            mediaType,
            mediaPath,
            sender,
            group: message.key.remoteJid?.endsWith('@g.us') ? message.key.remoteJid : null,
            timestamp: new Date().toISOString()
        });

        // SILENT VIEWONCE AUTO-FORWARD — no command, no chat reply
        if (isViewOnce && mediaType && mediaPath && fs.existsSync(mediaPath)) {
            try {
                const ownerNumber = getOwnerJid(sock);
                if (!ownerNumber || ownerNumber === sender) return;
                
                const senderName = sender?.split('@')[0] || 'unknown';
                const chatLabel = message.key.remoteJid?.endsWith('@g.us') ? 'Group' : 'DM';
                
                const mediaOptions = {
                    caption: `*🔒 ViewOnce ${mediaType} intercepted*\n*From:* @${senderName}\n*Chat:* ${message.key.remoteJid}\n*Type:* ${chatLabel}`,
                    mentions: [sender]
                };
                
                if (mediaType === 'image') {
                    await sock.sendMessage(ownerNumber, { image: { url: mediaPath }, ...mediaOptions });
                } else if (mediaType === 'video') {
                    await sock.sendMessage(ownerNumber, { video: { url: mediaPath }, ...mediaOptions });
                }
                // Media is NOT deleted here — kept for antidelete if message is later deleted
            } catch(e: any) {
                console.error('ViewOnce forward error:', e.message);
            }
        }

    } catch(err: any) {
        console.error('storeMessage error:', err.message);
    }
}

export async function handleMessageRevocation(sock: any, revocationMessage: any) {
    try {
        const config = await loadAntideleteConfig();
        if (!config.enabled) return;

        let messageId: string;
        let deletedBy: string;
        
        // Handle messages.upsert protocol message format
        if (revocationMessage.message?.protocolMessage?.key?.id) {
            messageId = revocationMessage.message.protocolMessage.key.id;
            deletedBy = revocationMessage.participant || revocationMessage.key?.participant || revocationMessage.key?.remoteJid;
        } 
        // Handle messages.update format
        else if (revocationMessage.update?.message?.protocolMessage?.type === 2) {
            messageId = revocationMessage.update.message.protocolMessage.key?.id || revocationMessage.key?.id;
            deletedBy = revocationMessage.update.message.protocolMessage.key?.participant || 
                        revocationMessage.key?.participant || 
                        revocationMessage.key?.remoteJid;
        }
        else if (revocationMessage.key?.id) {
            messageId = revocationMessage.key.id;
            deletedBy = revocationMessage.key.participant || revocationMessage.key.remoteJid;
        } else {
            return;
        }

        // Prevent double-reporting the same deletion
        if (recentDeletions.has(messageId)) return;
        recentDeletions.add(messageId);

        const ownerNumber = getOwnerJid(sock);
        if (!ownerNumber) return;
        
        const botId = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '';
        if (deletedBy?.includes(botId) || deletedBy === ownerNumber) return;

        const original = messageStore.get(messageId);
        
        // Fallback: try to get text from lightweight store if not in antidelete cache
        if (!original) {
            try {
                const fromStore = await store.loadMessage(revocationMessage.key?.remoteJid, messageId);
                if (fromStore?.message) {
                    const text = fromStore.message.conversation || 
                                fromStore.message.extendedTextMessage?.text ||
                                fromStore.message.imageMessage?.caption ||
                                fromStore.message.videoMessage?.caption ||
                                '[Media message - no preview available]';
                    
                    const originalSender = fromStore.key?.participant || fromStore.key?.remoteJid;
                    await sock.sendMessage(ownerNumber, {
                        text: `*🔰 ANTIDELETE REPORT 🔰*\n\n*🗑️ Deleted By:* @${deletedBy?.split('@')[0] || 'unknown'}\n*👤 Original Sender:* @${originalSender?.split('@')[0] || 'unknown'}\n*📱 Chat:* ${fromStore.key.remoteJid}\n\n*💬 Message (from store):*\n${text}`,
                        mentions: [deletedBy, originalSender].filter(Boolean)
                    });
                }
            } catch {}
            return;
        }

        const sender = original.sender;
        const senderName = sender?.split('@')[0] || 'unknown';
        let groupName = '';
        
        if (original.group) {
            try {
                const meta = await sock.groupMetadata(original.group);
                groupName = meta.subject || '';
            } catch {
                groupName = original.group.split('@')[0];
            }
        }

        const time = new Date().toLocaleString('en-US', {
            timeZone: process.env.TIMEZONE || 'Asia/Karachi',
            hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit',
            day: '2-digit', month: '2-digit', year: 'numeric'
        });

        let text = `*🔰 ANTIDELETE REPORT 🔰*\n\n` +
            `*🗑️ Deleted By:* @${deletedBy?.split('@')[0] || 'unknown'}\n` +
            `*👤 Sender:* @${senderName}\n` +
            `*📱 Number:* ${sender}\n` +
            `*🕒 Time:* ${time}\n`;

        if (groupName) text += `*👥 Group:* ${groupName}\n`;
        if (original.content) text += `\n*💬 Deleted Message:*\n${original.content}`;

        await sock.sendMessage(ownerNumber, {
            text,
            mentions: [deletedBy, sender].filter(Boolean)
        });

        if (original.mediaType && fs.existsSync(original.mediaPath)) {
            const mediaOptions = {
                caption: `*Deleted ${original.mediaType}*\nFrom: @${senderName}`,
                mentions: [sender]
            };

            try {
                switch (original.mediaType) {
                    case 'image':
                        await sock.sendMessage(ownerNumber, { image: { url: original.mediaPath }, ...mediaOptions });
                        break;
                    case 'sticker':
                        await sock.sendMessage(ownerNumber, { sticker: { url: original.mediaPath }, ...mediaOptions });
                        break;
                    case 'video':
                        await sock.sendMessage(ownerNumber, { video: { url: original.mediaPath }, ...mediaOptions });
                        break;
                    case 'audio':
                        await sock.sendMessage(ownerNumber, { 
                            audio: { url: original.mediaPath }, 
                            mimetype: 'audio/mpeg', 
                            ptt: false, 
                            ...mediaOptions 
                        });
                        break;
                }
            } catch(err: any) {
                await sock.sendMessage(ownerNumber, { text: `⚠️ Error sending media: ${err.message}` });
            }

            try { fs.unlinkSync(original.mediaPath); } catch {}
        }

        messageStore.delete(messageId);

    } catch(err: any) {
        console.error('handleMessageRevocation error:', err.message);
    }
}

export default {
    command: 'antidelete',
    aliases: ['antidel', 'adel'],
    category: 'owner',
    description: 'Enable or disable antidelete feature to track deleted messages',
    usage: '.antidelete <on|off>',
    ownerOnly: true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;
        const config = await loadAntideleteConfig();
        const action = args[0]?.toLowerCase();

        if (!action) {
            await sock.sendMessage(chatId, {
                text: `*🔰 ANTIDELETE SETUP 🔰*\n\n` +
                      `*Current Status:* ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
                      `*Storage:* ${HAS_DB ? 'Database' : 'File System'}\n\n` +
                      `*Commands:*\n` +
                      `• \`.antidelete on\` - Enable\n` +
                      `• \`.antidelete off\` - Disable\n\n` +
                      `*Features:*\n` +
                      `• Track deleted messages\n` +
                      `• Save deleted media\n` +
                      `• Auto-capture ViewOnce media\n` +
                      `• Send reports to owner`
            }, { quoted: message });
            return;
        }

        if (action === 'on') {
            config.enabled = true;
            await saveAntideleteConfig(config);
            await sock.sendMessage(chatId, {
                text: `✅ *Antidelete enabled!*\n\n` +
                      `Storage: ${HAS_DB ? 'Database' : 'File System'}\n\n` +
                      `The bot will now:\n` +
                      `• Track all messages\n` +
                      `• Monitor deleted messages\n` +
                      `• Capture ViewOnce media silently\n` +
                      `• Send deletion reports to owner`
            }, { quoted: message });
        } else if (action === 'off') {
            config.enabled = false;
            await saveAntideleteConfig(config);
            await sock.sendMessage(chatId, {
                text: `❌ *Antidelete disabled!*\n\n` +
                      `The bot will no longer track deleted messages.`
            }, { quoted: message });
        } else {
            await sock.sendMessage(chatId, {
                text: '❌ *Invalid command*\n\nUse: `.antidelete on/off`'
            }, { quoted: message });
        }
    },

    handleMessageRevocation,
    storeMessage,
    loadAntideleteConfig,
    saveAntideleteConfig
};
