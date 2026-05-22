import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  jidNormalizedUser,
  delay
} from 'baileys'
import P from 'pino'
import qrcode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import { Boom } from '@hapi/boom'
import { createLokaAgent, processMessage } from './agent/ai.js'
import { createGroupAgent, processGroupMessage } from './agent/group-agent.js'
import { startReminderCron, setWhatsAppSocket } from './agent/cron-reminder.js'
import 'dotenv/config'

const GROUP_CONFIRMATION_JID = '120363406492419821@g.us'
const ADMIN_JID = '6285649204151@s.whatsapp.net'
const MAX_RECONNECT_ATTEMPTS = 5

let agentBundle = null
let memoryManager = null
let sock = null
let stopCron = null
let reconnectAttempts = 0
let botLid = null  
const processingMessages = new Set()
const greetedUsers = new Set()
const userStates = new Map()

const LOG_LEVELS = {
  INFO: '📘 INFO', WARN: '⚠️  WARN', ERROR: '❌ ERROR',
  SUCCESS: '✅ OK  ', EVENT: '📨 EVENT', AGENT: '🤖 AGENT',
  WA: '📱 WA   ', CRON: '⏰ CRON ', SYSTEM: '🔧 SYS  '
}

function log(level, context, message, data = null) {
  const ts = new Date().toLocaleTimeString('id-ID', { hour12: false, timeZone: 'Asia/Jakarta' })
  const prefix = LOG_LEVELS[level] ?? '     '
  const ctx = context ? `[${context}]` : ''
  console.log(`${ts} ${prefix} ${ctx} ${message}`)
  if (data !== null && data !== undefined) {
    console.log('         ↳', typeof data === 'object' ? JSON.stringify(data, null, 2) : data)
  }
}

function logDivider(char = '─', len = 60) {
  console.log(char.repeat(len))
}

function formatCurrency(amount) {
  const num = typeof amount === 'string'
    ? parseInt(amount.replace(/\./g, '').replace(',', '.'))
    : Number(amount)
  return `Rp ${new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0 }).format(num || 0)}`
}

function formatDate(d) {
  const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`
}

function parseDateLocal(dateStr) {
  if (!dateStr) return new Date()
  const clean = String(dateStr).split('T')[0] 
  return new Date(clean + 'T00:00:00')
}

function formatTime(timeStr) {
  if (!timeStr) return '-'
  if (timeStr.includes('WIB')) return timeStr
  const match = timeStr.match(/(\d{1,2})[:.](\d{2})/)
  if (match) return `${match[1]}.${match[2]} WIB`
  return timeStr + ' WIB'
}

function getWelcomeMessage(name) {
  return `☕ *Halo ${name}! Selamat datang di Loka Coffee & Eatery* 🎉

Saya siap membantu kamu. Pilih menu di bawah atau langsung ketik pertanyaan kamu:

*1* 📅 Reservasi Ruang
*2* ℹ️ Info & FAQ
*3* 👤 Hubungi Admin

_Ketik *MENU* kapan saja untuk kembali ke sini._

⏱️ Jam Operasional: Senin–Minggu, 08.00–22.00 WIB`
}

const MENU_CONTEXT = {
  '1': `[KONTEKS: User memilih menu RESERVASI RUANG]
User ingin melakukan reservasi ruang di Loka Coffee. 
Mulai alur booking: sapa dengan hangat, lalu tanyakan data yang dibutuhkan satu per satu (nama, tanggal, jam, jumlah tamu, area, dsb).
Jangan tampilkan semua pertanyaan sekaligus — ajukan satu per satu secara natural.`,

  '2': `[KONTEKS: User memilih menu INFO & FAQ]
User ingin tahu informasi tentang Loka Coffee — bisa soal paket harga, ketentuan, fasilitas, cara reservasi, atau hal lainnya.
Jawab dengan ramah dan informatif. Tanya balik jika ingin tahu lebih spesifik apa yang ingin mereka ketahui.`,

  '3': `[KONTEKS: User memilih menu HUBUNGI ADMIN]
User ingin berbicara dengan admin secara langsung.
Informasikan bahwa kamu akan meneruskan pesan mereka, dan berikan juga kontak WhatsApp admin:
- wa.me/6285150738708
- wa.me/6285649204151
Tanyakan: ada yang bisa disampaikan ke admin?`
}

async function forwardToAgent(senderJid, text, msg) {
  if (!agentBundle || !memoryManager) {
    await sock.sendMessage(senderJid, { text: '⏳ Sistem sedang inisialisasi, coba lagi sebentar ya 🙏' })
    return null
  }

  const sessionId = jidNormalizedUser(senderJid)
  const dedupKey = sessionId + text
  if (processingMessages.has(dedupKey)) return null
  processingMessages.add(dedupKey)

  try {
    await sock.sendPresenceUpdate('composing', senderJid)
    const result = await processMessage(agentBundle, memoryManager, sessionId, text)
    await sock.sendPresenceUpdate('available', senderJid)
    return result
  } catch (error) {
    log('ERROR', 'Agent', `Failed: ${error.message}`)
    await sock.sendMessage(senderJid, {
      text: 'Maaf, terjadi kendala. Ketik *MENU* untuk kembali ke pilihan utama. 🙏'
    })
    return null
  } finally {
    processingMessages.delete(dedupKey)
  }
}


async function sendConfirmationToGroup(reservationData) {
  try {
    const message = `🎉 *Reservasi Baru Dikonfirmasi* ✅

📋 *Detail Reservasi:*
• ID: ${reservationData.id}
• Nama: ${reservationData.nama}
• WhatsApp: ${reservationData.whatsapp}
• 📅 Tanggal: ${formatDate(parseDateLocal(reservationData.tanggal))}
• ⏰ Jam: ${formatTime(reservationData.jam)}
• 👥 Jumlah Tamu: ${reservationData.jumlah_orang} orang
• 🏠 Area: ${reservationData.kategori || reservationData.area || '-'}
• 📝 Status: ${reservationData.status}

💰 *Pembayaran:*
• Total: ${formatCurrency(reservationData.total)}
• Deposit (50%): ${formatCurrency(reservationData.deposit)}
• Sisa Hari-H: ${formatCurrency(reservationData.sisa_pembayaran)}

⚠️ Durasi 3 jam · Sisa dibayar hari-H · Pembatalan = deposit hangus

Mohon segera lakukan pembayaran deposit. 🙏`

    await sock.sendMessage(GROUP_CONFIRMATION_JID, { text: message })
    log('SUCCESS', 'Group', `Confirmation sent → ${GROUP_CONFIRMATION_JID}`)
  } catch (error) {
    log('ERROR', 'Group', `Failed: ${error.message}`)
  }
}

async function sendPaymentInstruction(customerJid, reservationData) {
  try {
    const message = `💳 *Instruksi Pembayaran - Loka Coffee*

Halo ${reservationData.nama} 👋

📌 *ID Reservasi:* ${reservationData.id}
💰 *Deposit (50%):* ${formatCurrency(reservationData.deposit)}
📅 *Batas bayar:* H-1 sebelum acara

🏦 *Transfer ke salah satu:*
• BCA *8620305732* a.n. Nabillah Aisah Amir
• BRI *005801004372567* a.n. Nabillah Aisah Amir

📸 Setelah transfer, kirim bukti di chat ini. Admin verifikasi dalam < 15 menit.

_Sisa ${formatCurrency(reservationData.sisa_pembayaran)} dibayar hari-H sebelum acara dimulai._

Butuh bantuan? Hubungi admin langsung: https://wa.me/6285649204151`

    await sock.sendMessage(customerJid, { text: message })
    log('SUCCESS', 'Payment', `Payment instruction sent → ${customerJid}`)
  } catch (error) {
    log('ERROR', 'Payment', `Failed: ${error.message}`)
  }
}

async function notifyAdminForVerification(reservationData) {
  try {
    const message = `🔔 *Reservasi Baru - Perlu Verifikasi Deposit*

📋 ID: ${reservationData.id}
👤 Customer: ${reservationData.nama}
📱 WA: ${reservationData.whatsapp}
📅 ${formatDate(parseDateLocal(reservationData.tanggal))} | ${formatTime(reservationData.jam)}
👥 Tamu: ${reservationData.jumlah_orang} orang
💳 Deposit: ${formatCurrency(reservationData.deposit)}

⏳ Menunggu bukti transfer dari customer.`

    await sock.sendMessage(ADMIN_JID, { text: message })
    log('SUCCESS', 'Admin', `Admin notified → ${ADMIN_JID}`)
  } catch (error) {
    log('ERROR', 'Admin', `Failed: ${error.message}`)
  }
}

async function handlePostReservation(result, senderJid) {
  const reservationData = result?.reservationData
  console.log('[handlePostReservation] reservationData:', JSON.stringify(reservationData))
  if (!reservationData?.id) {
    log('WARN', 'Workflow', 'No reservationData.id — skipping post-reservation flow')
    return
  }
  if (!reservationData.deposit || !reservationData.total) {
    log('WARN', 'Workflow', `Missing financial data (deposit=${reservationData.deposit}, total=${reservationData.total}) — skipping post-reservation flow`)
    return
  }

  log('AGENT', 'Workflow', `Post-reservation triggered for ID: ${reservationData.id}`)
  try {
    await sendConfirmationToGroup(reservationData)
    await sendPaymentInstruction(senderJid, reservationData)
    await notifyAdminForVerification(reservationData)

    userStates.set(senderJid, { state: 'awaiting_payment_proof', data: reservationData })

    log('SUCCESS', 'Workflow', `Completed for ID: ${reservationData.id}`)
  } catch (error) {
    log('ERROR', 'Workflow', `Failed: ${error.message}`)
  }
}

async function handleGroupMention(groupJid, text, senderName, msg) {
  const query = text.trim() || 'ada informasi apa?'

  log('AGENT', 'Group', `Group query from ${senderName}: "${query}"`)

  const dedupKey = `group_${groupJid}_${query}`
  if (processingMessages.has(dedupKey)) return
  processingMessages.add(dedupKey)

  try {
    await sock.sendPresenceUpdate('composing', groupJid)
    const result = await processGroupMessage(query, senderName, groupJid)
    await sock.sendPresenceUpdate('available', groupJid)

    if (result?.output) {
      // Balas dengan mention ke pengirim
      const senderJid = msg.key.participant || msg.key.remoteJid
      // Bersihkan TOOL_CALL/TOOL_RESULT dari output sebelum dikirim
      const cleanReply = result.output
        .split('\n')
        .filter(line => {
          const t = line.trim()
          return !t.startsWith('TOOL_CALL:') && !t.startsWith('TOOL_RESULT:')
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

      if (cleanReply) {
        await sock.sendMessage(groupJid, {
          text: cleanReply,
          mentions: [senderJid]
        })
        log('SUCCESS', 'Group', `Reply sent to group ${groupJid}`)
      } else {
        log('WARN', 'Group', 'Output empty after cleaning, skipping send')
      }
    } else {
      log('WARN', 'Group', 'No output from group agent', result)
    }
  } catch (error) {
    log('ERROR', 'Group', `Agent failed: ${error.message}`)
    await sock.sendMessage(groupJid, {
      text: '⚠️ Maaf, gagal mengambil data. Coba lagi sebentar ya.'
    })
  } finally {
    processingMessages.delete(dedupKey)
  }
}

async function processUserMessage(senderJid, text, isGroup, msg) {
  if (!agentBundle || !memoryManager) {
    await sock.sendMessage(senderJid, { text: '⏳ Sistem sedang inisialisasi...' })
    return
  }

  const normalizedText = text.trim().toUpperCase()
  const currentState = userStates.get(senderJid)

  if (['MENU', 'BACK', 'MULAI'].includes(normalizedText)) {
    userStates.delete(senderJid)
    await sock.sendMessage(senderJid, { text: getWelcomeMessage(msg.pushName || 'Kakak') })
    log('INFO', 'Menu', `Reset to main menu for ${senderJid}`)
    return
  }

  if (currentState?.state === 'awaiting_payment_proof') {
    const isPaymentConfirmText = /sudah (transfer|bayar|kirim)|bukti|konfirmasi|done.*transfer|transfer.*done/i.test(text)
    if (isPaymentConfirmText) {
      await sock.sendMessage(senderJid, {
        text: '📸 Terima kasih! Mohon kirimkan foto bukti transfernya ya, Kak. Admin akan verifikasi dalam < 15 menit. 🙏'
      })
      return
    }
  }

  if (!currentState && /^[123]$/.test(normalizedText)) {
    const contextPrompt = MENU_CONTEXT[normalizedText]
    if (contextPrompt) {
      log('INFO', 'Menu', `User selected menu ${normalizedText} → forwarding to agent with context`)
      const result = await forwardToAgent(senderJid, contextPrompt, msg)
      if (result?.output) {
        await sock.sendMessage(senderJid, { text: result.output })
        await handlePostReservation(result, senderJid)
      }
      return
    }
  }

  if (currentState?.state === 'relaying_to_admin') {
    await sock.sendMessage(ADMIN_JID, {
      text: `📨 *Pesan dari Customer*\n\n👤 ${msg.pushName || 'Pelanggan'}\n📱 ${senderJid}\n\n💬 "${text}"`
    })
    await sock.sendMessage(senderJid, {
      text: '✅ Pesan kamu sudah diteruskan ke admin. Kami akan segera membalas! 🙏'
    })
    userStates.delete(senderJid)
    return
  }

  if (!greetedUsers.has(senderJid)) {
    greetedUsers.add(senderJid)
    log('INFO', 'Welcome', `First message from ${senderJid} — forwarding to agent with memory check`)

    const sessionId = jidNormalizedUser(senderJid)
    const firstMessagePrompt = `[SISTEM: Ini adalah pesan pertama dari user di sesi ini. Nama WhatsApp mereka: "${msg.pushName || 'Kakak'}".
Lakukan hal berikut:
1. Panggil search_memory dengan sessionId="${sessionId}" dan query="nama preferensi reservasi" untuk cek apakah ada data user yang tersimpan
2. Jika ada memori → sapa dengan nama yang tersimpan, tunjukkan bahwa kamu ingat mereka, dan tanyakan apakah ingin melanjutkan dari sebelumnya atau mulai baru
3. Jika tidak ada memori → sapa hangat dengan nama WhatsApp mereka, lalu tampilkan menu pilihan:
   *1* 📅 Reservasi Ruang
   *2* ℹ️ Info & FAQ
   *3* 👤 Hubungi Admin
   (tambahkan: _Ketik *MENU* kapan saja untuk kembali ke sini._)
Pesan user: "${text}"]`

    const result = await forwardToAgent(senderJid, firstMessagePrompt, msg)
    if (result?.output) {
      await sock.sendMessage(senderJid, { text: result.output })
      await handlePostReservation(result, senderJid)
    }
    return
  }

  log('AGENT', 'Route', `Free text → agent: "${text}"`)
  const result = await forwardToAgent(senderJid, text, msg)
  if (result?.output) {
    await sock.sendMessage(senderJid, { text: result.output })
    await handlePostReservation(result, senderJid)

    if (result.output.toLowerCase().includes('wa.me/628515') || result.output.toLowerCase().includes('dihubungkan dengan admin')) {
      userStates.set(senderJid, { state: 'relaying_to_admin', data: {} })
    }
  }
}

async function initializeAgent() {
  log('AGENT', 'Init', 'Initializing Loka Agent...')
  try {
    const bundle = await createLokaAgent()
    agentBundle = bundle
    memoryManager = bundle.memoryManager
    log('SUCCESS', 'Init', 'Loka Agent initialized')

    await createGroupAgent()
    log('SUCCESS', 'Init', 'Group Agent initialized')

    return true
  } catch (error) {
    log('ERROR', 'Init', `Failed: ${error.message}`)
    return false
  }
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()
  log('WA', 'Socket', `Baileys version: ${version.join('.')}`)

  sock = makeWASocket({
    version, auth: state, logger: P({ level: 'silent' }),
    printQRInTerminal: false, syncFullHistory: true,
    browser: ['Loka Coffee Bot', 'Chrome', '1.0.0'],
    connectTimeoutMs: 30000, keepAliveIntervalMs: 30000
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      log('WA', 'QR', 'Scan QR to login')
      qrcodeTerminal.generate(qr, { small: true }, (qrString) => {
        console.log('\n' + qrString + '\n')
      })
      try {
        const qrDataUrl = await qrcode.toDataURL(qr)
        console.log('🔗 QR Data URL:', qrDataUrl, '\n')
      } catch { console.log('QR (raw):', qr) }
    }

    if (connection === 'open') {
      logDivider('═')
      log('SUCCESS', 'Socket', 'WhatsApp connected!')
      // Simpan LID bot untuk deteksi mention di grup
      botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null
      log('WA', 'Socket', `Admin: ${ADMIN_JID} | Group: ${GROUP_CONFIRMATION_JID} | BotLID: ${botLid}`)
      logDivider('═')
      reconnectAttempts = 0

      if (await initializeAgent()) {
        setWhatsAppSocket(sock)
        stopCron = startReminderCron(30)
        log('CRON', 'Start', 'Reminder cron started (30 min interval)')
      }

      await sock.sendMessage(ADMIN_JID, {
        text: '🤖 *Loka Coffee Bot Online* ✅\n⏰ Reminder aktif\nSiap melayani reservasi.'
      })
    }

    if (connection === 'close') {
      const error = new Boom(lastDisconnect?.error)
      const statusCode = error?.output?.statusCode
      const willReconnect = statusCode !== DisconnectReason.loggedOut

      logDivider()
      log('WARN', 'Socket', `Closed — Code: ${statusCode} | Reconnect: ${willReconnect}`)
      logDivider()

      if (statusCode === DisconnectReason.loggedOut) {
        log('ERROR', 'Auth', 'Logged out. Run: rm -rf auth_info && pnpm dev')
        return
      }

      if (willReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++
        const delayMs = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
        log('WA', 'Reconnect', `Waiting ${delayMs}ms (attempt ${reconnectAttempts})...`)
        await delay(delayMs)
        startSock()
      } else {
        log('ERROR', 'Socket', 'Max reconnect attempts reached. Restart manually.')
      }
    }
  })

  sock.ev.on('creds.update', () => { saveCreds(); log('WA', 'Auth', 'Credentials saved') })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const jid = msg.key.remoteJid
    const isGroup = jid.endsWith('@g.us')

    if (isGroup) {
      // Hanya proses jika dari grup konfirmasi
      if (jid !== GROUP_CONFIRMATION_JID) return

      const contentType = getContentType(msg.message)

      // Ekstrak teks dari semua kemungkinan content type
      let groupText = ''
      if (contentType === 'conversation') {
        groupText = msg.message.conversation
      } else if (contentType === 'extendedTextMessage') {
        groupText = msg.message.extendedTextMessage?.text || ''
      } else if (contentType === 'imageMessage') {
        groupText = msg.message.imageMessage?.caption || ''
      }

      if (!groupText?.trim()) return

      // Ekstrak contextInfo untuk cek mention dan reply
      const contextInfo =
        msg.message?.extendedTextMessage?.contextInfo ??
        msg.message?.imageMessage?.contextInfo ??
        msg.message?.contextInfo ??
        {}

      const mentionedJids = contextInfo?.mentionedJid ?? []
      const botJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null

      // Cek apakah pesan ini adalah reply ke pesan bot
      // Baileys: contextInfo.participant = JID pengirim pesan yang di-reply
      // contextInfo.stanzaId = ID pesan yang di-reply
      const quotedParticipant = contextInfo?.participant
        ? jidNormalizedUser(contextInfo.participant)
        : null
      const quotedSender = contextInfo?.remoteJid
        ? jidNormalizedUser(contextInfo.remoteJid)
        : null

      const isReplyToBot = !!(quotedParticipant && (
        (botJid && quotedParticipant === botJid) ||
        (botLid && quotedParticipant === botLid)
      )) || !!(quotedSender && (
        (botJid && quotedSender === botJid) ||
        (botLid && quotedSender === botLid)
      ))

      // Cek mention bot
      const isBotMentioned = mentionedJids.some(j => {
        const jNorm = jidNormalizedUser(j)
        if (botJid && jNorm === botJid) return true
        if (botLid && jNorm === botLid) return true
        const jNum = j.split('@')[0].replace(/\D/g, '')
        const botNum = botJid?.split('@')[0].replace(/\D/g, '')
        return jNum && botNum && jNum === botNum
      })
      const hasLokaText = /@loka\b/i.test(groupText)

      // Debug
      log('INFO', 'Group', `contentType=${contentType} | botJid=${botJid} | botLid=${botLid} | mentionedJids=${JSON.stringify(mentionedJids)} | isReplyToBot=${isReplyToBot} | text="${groupText}"`)

      if (!isBotMentioned && !hasLokaText && !isReplyToBot) {
        log('INFO', 'Group', `No trigger — isBotMentioned=${isBotMentioned} hasLokaText=${hasLokaText} isReplyToBot=${isReplyToBot}`)
        return
      }

      const groupSenderName = msg.pushName || msg.key.participant?.split('@')[0] || 'Anggota'
      const triggerType = isReplyToBot ? 'reply' : (isBotMentioned ? 'mention' : '@loka text')
      log('INFO', 'Group', `Trigger: ${triggerType} from ${groupSenderName}`)

      // Bersihkan mention @nomor dan @loka dari teks query
      const cleanQuery = groupText
        .replace(/@\d+/g, '')
        .replace(/@loka\b/gi, '')
        .trim()

      logDivider()
      log('EVENT', 'Group', `Bot mention from ${groupSenderName}: "${cleanQuery || groupText}"`)
      logDivider()

      await handleGroupMention(jid, cleanQuery || groupText, groupSenderName, msg)
      return
    }

    const sender = jid
    const senderName = msg.pushName || 'Pengguna'
    const contentType = getContentType(msg.message)

    let text = ''
    if (contentType === 'conversation') text = msg.message.conversation
    else if (contentType === 'extendedTextMessage') text = msg.message.extendedTextMessage?.text || ''
    else if (contentType === 'imageMessage' && msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption
    else if (contentType === 'videoMessage' && msg.message.videoMessage?.caption) text = msg.message.videoMessage.caption

    if (!text?.trim()) {
      if (contentType === 'imageMessage') {
        const currentState = userStates.get(sender)
        if (currentState?.state === 'awaiting_payment_proof') {
          await sock.sendMessage(sender, {
            text: '📸 Bukti transfer diterima! Admin akan memverifikasi dalam < 15 menit. Terima kasih! 🙏'
          })
          await notifyAdminForVerification(currentState.data)
          userStates.delete(sender)
        } else {
          log('INFO', 'Msg', `Image from ${senderName} — no active payment state, ignored`)
        }
      } else {
        log('INFO', 'Msg', `Non-text from ${senderName} — ignored`)
      }
      return
    }

    logDivider()
    log('EVENT', 'Msg', `[${isGroup ? 'GROUP' : 'PRIVATE'}] ${senderName} (${sender})`)
    log('EVENT', 'Msg', `Text: "${text}"`)
    logDivider()

    await processUserMessage(sender, text, isGroup, msg)
  })

  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.status === 4) log('INFO', 'Status', `Read — ID: ${key.id}`)
      else if (update.status === 3) log('INFO', 'Status', `Delivered — ID: ${key.id}`)
    }
  })

  return sock
}

async function gracefulShutdown(signal = 'UNKNOWN') {
  logDivider('═')
  log('SYSTEM', 'Shutdown', `Signal: ${signal}`)
  if (stopCron) { stopCron(); log('CRON', 'Shutdown', 'Cron stopped') }
  if (sock) {
    try { await sock.logout(); log('WA', 'Shutdown', 'Disconnected') }
    catch (e) { log('ERROR', 'Shutdown', `Logout error: ${e.message}`) }
  }
  logDivider('═')
  process.exit(0)
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('uncaughtException', (error) => {
  log('ERROR', 'Process', `Uncaught: ${error.message}`)
  console.error(error.stack)
  gracefulShutdown('uncaughtException')
})
process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Process', `Unhandled: ${reason}`)
})

logDivider('═')
log('SYSTEM', 'Boot', '🚀 Starting Loka Coffee Bot...')
log('SYSTEM', 'Boot', '📱 WhatsApp Baileys + LangChain Agent + FAISS Memory')
log('SYSTEM', 'Boot', `⏰ Group: ${GROUP_CONFIRMATION_JID} | 👤 Admin: ${ADMIN_JID}`)
logDivider('═')

startSock().catch((error) => {
  log('ERROR', 'Boot', `Fatal: ${error.message}`)
  console.error(error.stack)
  process.exit(1)
})