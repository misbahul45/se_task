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
import { Boom } from '@hapi/boom'
import { createLokaAgent, processMessage } from './agent/ai.js'
import { startReminderCron, setWhatsAppSocket } from './agent/cron-reminder.js'
import 'dotenv/config'

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const GROUP_CONFIRMATION_JID = '120363406492419821@g.us'
const PAYMENT_VERIFICATION_JID = '6285150738708@s.whatsapp.net'
const ADMIN_JID = '6285649204151@s.whatsapp.net'
const MAX_RECONNECT_ATTEMPTS = 5

let agentExecutor = null
let memoryManager = null
let sock = null
let stopCron = null
let reconnectAttempts = 0
const processingMessages = new Set()

// ─────────────────────────────────────────────
// LOGGER UTIL
// ─────────────────────────────────────────────
const LOG_LEVELS = { INFO: '📘 INFO', WARN: '⚠️  WARN', ERROR: '❌ ERROR', SUCCESS: '✅ OK  ', EVENT: '📨 EVENT', AGENT: '🤖 AGENT', WA: '📱 WA   ', CRON: '⏰ CRON ', SYSTEM: '🔧 SYS  ' }

function log(level, context, message, data = null) {
  const ts = new Date().toLocaleTimeString('id-ID', { hour12: false })
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

// ─────────────────────────────────────────────
// POST-RESERVATION: kirim ke grup & customer
// ─────────────────────────────────────────────
async function sendConfirmationToGroup(reservationData) {
  try {
    log('WA', 'Group', `Sending confirmation for ID: ${reservationData.id}`)
    const message = `🎉 *Reservasi Baru Dikonfirmasi* ✅

📋 *Detail Reservasi:*
• ID: ${reservationData.id}
• Nama: ${reservationData.nama}
• WhatsApp: ${reservationData.whatsapp}
• Tanggal: ${reservationData.tanggal}
• Jam: ${reservationData.jam}
• Jumlah Tamu: ${reservationData.jumlah_orang} orang
• Area: ${reservationData.kategori || reservationData.area}
• Status: ${reservationData.status}

💰 *Pembayaran:*
• Total: Rp ${reservationData.total?.toLocaleString('id-ID')}
• Deposit (50%): Rp ${reservationData.deposit?.toLocaleString('id-ID')}
• Sisa Pembayaran: Rp ${reservationData.sisa_pembayaran?.toLocaleString('id-ID')}

Mohon segera lakukan pembayaran deposit untuk mengkonfirmasi reservasi. 🙏`
    await sock.sendMessage(GROUP_CONFIRMATION_JID, { text: message })
    log('SUCCESS', 'Group', `Confirmation sent → ${GROUP_CONFIRMATION_JID}`)
  } catch (error) {
    log('ERROR', 'Group', `Failed to send group confirmation: ${error.message}`)
  }
}

async function sendPaymentInstruction(customerJid, reservationData) {
  try {
    log('WA', 'Payment', `Sending payment instruction to ${customerJid}`)
    const message = `💳 *Instruksi Pembayaran - Loka Coffee*

Halo ${reservationData.nama} 👋

Terima kasih telah melakukan reservasi di Loka Coffee.

📌 *ID Reservasi:* ${reservationData.id}
💰 *Deposit yang harus dibayar:* Rp ${reservationData.deposit?.toLocaleString('id-ID')}
📅 *Batas pembayaran:* H-1 sebelum acara

🏦 *Transfer ke salah satu rekening:*
• BCA **8620305732** a.n. Nabillah Aisah Amir
• BRI **005801004372567** a.n. Nabillah Aisah Amir

📸 Setelah transfer, balas pesan ini dengan foto bukti transfer ya 🙏

⚠️ *Catatan:*
• Simpan ID reservasi untuk referensi
• Pembayaran deposit mengikat reservasi Anda
• Sisa pembayaran dilunasi hari-H sebelum acara mulai

Terima kasih! ☕✨`
    await sock.sendMessage(customerJid, { text: message })
    log('SUCCESS', 'Payment', `Payment instruction sent → ${customerJid}`)
  } catch (error) {
    log('ERROR', 'Payment', `Failed to send payment instruction: ${error.message}`)
  }
}

async function notifyAdminForVerification(reservationData, customerJid) {
  try {
    log('WA', 'Admin', `Notifying admin for reservation ${reservationData.id}`)
    const message = `🔔 *Reservasi Baru Masuk*

📋 ID: ${reservationData.id}
👤 Customer: ${reservationData.nama}
📱 WA: ${reservationData.whatsapp}
📅 Tanggal: ${reservationData.tanggal} | ${reservationData.jam}
👥 Tamu: ${reservationData.jumlah_orang} orang
💳 Deposit: Rp ${reservationData.deposit?.toLocaleString('id-ID')}

Silakan verifikasi setelah customer mengirim bukti transfer.`
    await sock.sendMessage(ADMIN_JID, { text: message })
    log('SUCCESS', 'Admin', `Admin notification sent → ${ADMIN_JID}`)
  } catch (error) {
    log('ERROR', 'Admin', `Failed to notify admin: ${error.message}`)
  }
}

// ─────────────────────────────────────────────
// HELPER: deteksi reservasi sukses dari response
// ─────────────────────────────────────────────
function isReservationConfirmed(response) {
  const lower = response.toLowerCase()
  const keywords = ['reservasi berhasil', 'booking berhasil', 'id reservasi', 'reservation created', '✅', 'berhasil dibuat']
  const matched = keywords.find(k => lower.includes(k))
  if (matched) log('AGENT', 'Detect', `Reservation success detected via keyword: "${matched}"`)
  return !!matched
}

function extractReservationId(response) {
  const match = response.match(/ID[:\s]*([a-f0-9-]{36})/i)
  if (match) log('AGENT', 'Extract', `Reservation ID found: ${match[1]}`)
  else log('WARN', 'Extract', 'No reservation ID found in response')
  return match ? match[1] : null
}

// ─────────────────────────────────────────────
// POST-RESERVATION WORKFLOW
// ─────────────────────────────────────────────
async function handleAgentResponse(userInput, agentResponse, senderJid, isGroup) {
  if (!isReservationConfirmed(agentResponse)) return

  const reservationId = extractReservationId(agentResponse)
  if (!reservationId) {
    log('WARN', 'Workflow', 'Reservation confirmed but ID not found — skipping post-workflow')
    return
  }

  log('AGENT', 'Workflow', `Starting post-reservation workflow for ID: ${reservationId}`)
  try {
    const detail = await memoryManager.searchMemories(reservationId, senderJid, 1)
    const reservationData = { ...(detail[0]?.metadata || {}), id: reservationId }

    log('AGENT', 'Workflow', 'Sending group confirmation...')
    await sendConfirmationToGroup(reservationData)

    log('AGENT', 'Workflow', 'Sending payment instruction to customer...')
    await sendPaymentInstruction(senderJid, reservationData)

    log('AGENT', 'Workflow', 'Notifying admin...')
    await notifyAdminForVerification(reservationData, senderJid)

    log('SUCCESS', 'Workflow', `Post-reservation workflow completed for ID: ${reservationId}`)
  } catch (error) {
    log('ERROR', 'Workflow', `Post-reservation workflow failed: ${error.message}`)
  }
}

// ─────────────────────────────────────────────
// PROCESS PESAN USER
// ─────────────────────────────────────────────
async function processUserMessage(senderJid, text, isGroup, msg) {
  if (!agentExecutor || !memoryManager) {
    log('WARN', 'Agent', 'Agent not ready — sending init message')
    await sock.sendMessage(senderJid, { text: '⏳ Sistem sedang inisialisasi, silakan coba beberapa saat lagi.' })
    return
  }

  const sessionId = jidNormalizedUser(senderJid)
  const dedupKey = sessionId + text

  if (processingMessages.has(dedupKey)) {
    log('WARN', 'Dedup', `Duplicate message skipped for session: ${sessionId}`)
    return
  }
  processingMessages.add(dedupKey)

  const startTime = Date.now()
  log('AGENT', 'Input', `Session: ${sessionId}`)
  log('AGENT', 'Input', `Text: "${text}"`)

  try {
    await sock.sendPresenceUpdate('composing', senderJid)

    const result = await processMessage(agentExecutor, memoryManager, sessionId, text)
    const elapsed = Date.now() - startTime

    await sock.sendPresenceUpdate('available', senderJid)

    log('AGENT', 'Output', `Response generated in ${elapsed}ms`)
    log('AGENT', 'Output', `Preview: "${result.output.slice(0, 100)}${result.output.length > 100 ? '...' : ''}"`)

    await sock.sendMessage(senderJid, { text: result.output })
    log('SUCCESS', 'Send', `Message sent to ${senderJid}`)

    await handleAgentResponse(text, result.output, senderJid, isGroup)
  } catch (error) {
    const elapsed = Date.now() - startTime
    log('ERROR', 'Agent', `Processing failed after ${elapsed}ms: ${error.message}`)
    await sock.sendMessage(senderJid, {
      text: 'Maaf, terjadi kendala saat memproses permintaan Anda. Silakan coba lagi atau hubungi admin. 🙏 https://wa.me/6285150738708'
    })
  } finally {
    processingMessages.delete(dedupKey)
  }
}

// ─────────────────────────────────────────────
// INISIALISASI AGENT
// ─────────────────────────────────────────────
async function initializeAgent() {
  log('AGENT', 'Init', 'Initializing Loka Agent...')
  try {
    const { agentExecutor: executor, memoryManager: manager } = await createLokaAgent()
    agentExecutor = executor
    memoryManager = manager
    log('SUCCESS', 'Init', 'Loka Agent initialized successfully')
    return true
  } catch (error) {
    log('ERROR', 'Init', `Failed to initialize agent: ${error.message}`)
    return false
  }
}

// ─────────────────────────────────────────────
// WHATSAPP SOCKET
// ─────────────────────────────────────────────
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()
  log('WA', 'Socket', `Using Baileys version: ${version.join('.')}`)

  sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }), // Baileys internal log dimatikan, kita pakai logger sendiri
    printQRInTerminal: false,        // QR ditangani manual di bawah
    syncFullHistory: true,
    browser: ['Loka Coffee Bot', 'Chrome', '1.0.0'],
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 30000
  })

  // ── Connection update ──
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update

    if (qr) {
      log('WA', 'QR', 'New QR code received — scan to login')
      try {
        const qrDataUrl = await qrcode.toDataURL(qr)
        console.log('\n🔗 QR Data URL (open in browser to scan):')
        console.log(qrDataUrl)
        console.log()
      } catch {
        console.log('QR (raw):', qr)
      }
    }

    if (isNewLogin) {
      log('WA', 'Auth', 'New login detected')
    }

    if (receivedPendingNotifications) {
      log('WA', 'Socket', 'Pending notifications received')
    }

    if (connection === 'connecting') {
      log('WA', 'Socket', 'Connecting to WhatsApp...')
    }

    if (connection === 'open') {
      logDivider('═')
      log('SUCCESS', 'Socket', 'WhatsApp connected successfully!')
      log('WA', 'Socket', `Admin JID     : ${ADMIN_JID}`)
      log('WA', 'Socket', `Group JID     : ${GROUP_CONFIRMATION_JID}`)
      logDivider('═')
      reconnectAttempts = 0

      const agentReady = await initializeAgent()
      if (agentReady) {
        setWhatsAppSocket(sock)
        stopCron = startReminderCron(30)
        log('CRON', 'Start', 'Reminder cron started (interval: 30 min)')
      }

      await sock.sendMessage(ADMIN_JID, {
        text: '🤖 *Loka Coffee Bot Online* ✅\n⏰ Reminder cron aktif\n\nSiap menerima reservasi dan pertanyaan pelanggan.'
      })
      log('WA', 'Admin', 'Online notification sent to admin')
    }

    if (connection === 'close') {
      const error = new Boom(lastDisconnect?.error)
      const statusCode = error?.output?.statusCode
      const willReconnect = statusCode !== DisconnectReason.loggedOut

      logDivider()
      log('WARN', 'Socket', `Connection closed — StatusCode: ${statusCode}`)
      log('WARN', 'Socket', `Reason: ${error?.message || lastDisconnect?.error?.message || 'Unknown'}`)
      log('WARN', 'Socket', `Will reconnect: ${willReconnect} | Attempt: ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS}`)
      logDivider()

      if (statusCode === DisconnectReason.loggedOut) {
        log('ERROR', 'Auth', 'Session logged out. Delete auth_info folder and restart.')
        log('INFO', 'Auth', 'Run: rm -rf auth_info && pnpm dev')
        return
      }

      if (willReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++
        const delayMs = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
        log('WA', 'Reconnect', `Waiting ${delayMs}ms before reconnect attempt ${reconnectAttempts}...`)
        await delay(delayMs)
        log('WA', 'Reconnect', 'Reconnecting...')
        startSock()
      } else if (!willReconnect) {
        log('ERROR', 'Socket', 'Reconnection not possible. Please restart manually.')
      } else {
        log('ERROR', 'Socket', `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Restart manually.`)
      }
    }
  })

  // ── Credentials update ──
  sock.ev.on('creds.update', () => {
    saveCreds()
    log('WA', 'Auth', 'Credentials saved')
  })

  // ── Incoming messages ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const msg = messages[0]
    if (!msg.message) return
    if (msg.key.fromMe) return

    const jid = msg.key.remoteJid
    const isGroup = jid.endsWith('@g.us')
    const sender = isGroup ? msg.key.participant : jid
    const senderName = msg.pushName || 'Pengguna'
    const contentType = getContentType(msg.message)

    let text = ''
    if (contentType === 'conversation') {
      text = msg.message.conversation
    } else if (contentType === 'extendedTextMessage') {
      text = msg.message.extendedTextMessage?.text || ''
    } else if (contentType === 'imageMessage' && msg.message.imageMessage?.caption) {
      text = msg.message.imageMessage.caption
    } else if (contentType === 'videoMessage' && msg.message.videoMessage?.caption) {
      text = msg.message.videoMessage.caption
    }

    if (!text || text.trim() === '') {
      log('INFO', 'Msg', `Non-text message from ${senderName} (${contentType}) — ignored`)
      return
    }

    logDivider()
    log('EVENT', 'Msg', `[${isGroup ? 'GROUP' : 'PRIVATE'}] ${senderName} (${sender})`)
    log('EVENT', 'Msg', `Content-Type : ${contentType}`)
    log('EVENT', 'Msg', `Text         : "${text}"`)
    logDivider()

    await processUserMessage(sender, text, isGroup, msg)
  })

  // ── Message status updates ──
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.status === 4) { // read
        log('INFO', 'Status', `Message read — ID: ${key.id}`)
      } else if (update.status === 3) { // delivered
        log('INFO', 'Status', `Message delivered — ID: ${key.id}`)
      }
    }
  })

  return sock
}

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
async function gracefulShutdown(signal = 'UNKNOWN') {
  logDivider('═')
  log('SYSTEM', 'Shutdown', `Signal received: ${signal}`)
  if (stopCron) {
    stopCron()
    log('CRON', 'Shutdown', 'Cron stopped')
  }
  if (sock) {
    try {
      await sock.logout()
      log('WA', 'Shutdown', 'WhatsApp disconnected')
    } catch (e) {
      log('ERROR', 'Shutdown', `Error during logout: ${e.message}`)
    }
  }
  logDivider('═')
  process.exit(0)
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('uncaughtException', (error) => {
  log('ERROR', 'Process', `Uncaught Exception: ${error.message}`)
  console.error(error.stack)
  gracefulShutdown('uncaughtException')
})
process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Process', `Unhandled Rejection: ${reason}`)
})

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
logDivider('═')
log('SYSTEM', 'Boot', '🚀 Starting Loka Coffee Bot...')
log('SYSTEM', 'Boot', '📱 WhatsApp Baileys + LangChain Agent + FAISS Memory')
log('SYSTEM', 'Boot', `⏰ Reminder group : ${GROUP_CONFIRMATION_JID}`)
log('SYSTEM', 'Boot', `👤 Admin JID      : ${ADMIN_JID}`)
logDivider('═')

startSock().catch((error) => {
  log('ERROR', 'Boot', `Fatal error: ${error.message}`)
  console.error(error.stack)
  process.exit(1)
})