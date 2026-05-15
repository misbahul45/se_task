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
const greetedUsers = new Set()
const userStates = new Map() // State management: senderJid -> { state, data }

// ─────────────────────────────────────────────
// LOGGER UTIL
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// FORMATTER UTILS (SOP-COMPLIANT)
// ─────────────────────────────────────────────
function formatCurrency(amount) {
  const num = typeof amount === 'string' 
    ? parseInt(amount.replace(/\./g, '').replace(',', '.')) 
    : Number(amount)
  return `Rp ${new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0 }).format(num || 0)}`
}

function formatDate(id) {
  // Format: "25 Mei 2024"
  const d = new Date(id)
  const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`
}

function formatTime(timeStr) {
  // Ensure format: "14.00 WIB"
  if (!timeStr) return '-'
  if (timeStr.includes('WIB')) return timeStr
  const match = timeStr.match(/(\d{1,2})[:.](\d{2})/)
  if (match) return `${match[1]}.${match[2]} WIB`
  return timeStr + ' WIB'
}

// ─────────────────────────────────────────────
// WELCOME MESSAGE - Interactive Menu (1-4)
// ─────────────────────────────────────────────
function getWelcomeMessage(name) {
  return `☕ *WELCOME TO LOKA COFFEE & EATERY*

Halo ${name} 👋

Terima kasih telah menghubungi kami. Silakan pilih layanan:

🔢 *PILIH MENU:*
1️⃣ 📅 *Reservasi Ruang*
   → Booking ruang untuk acara/kumpul
  
2️⃣ 🍽️ *Pesan Menu*
   → Order kopi, makanan, & snack
  
3️⃣ ℹ️ *Info & FAQ*
   → Cek harga, fasilitas, ketentuan SOP
  
4️⃣ 👤 *Hubungi Admin*
   → Butuh bantuan langsung?

💬 *Cara pakai:*
Ketik angka *1*, *2*, *3*, atau *4* lalu kirim.
Ketik *MENU* atau *BACK* kapan saja untuk kembali.

⏱️ *Jam Operasional:*
Senin–Minggu | 08.00–22.00 WIB

📍 *Lokasi:*
Loka Coffee & Eatery`;
}

// ─────────────────────────────────────────────
// MENU ROUTER - Handle numbered choices
// ─────────────────────────────────────────────
async function handleMenuSelection(senderJid, choice, userData = {}) {
  const menus = {
    '1': async () => {
      return {
        text: `📅 *RESERVASI RUANG - Loka Coffee & Eatery*

📋 *Ketentuan Umum (SOP):*
• Durasi: 3 jam
• Minimal booking: H-1
• Deposit: 50% dari minimum spending
• Sisa: Dibayar hari-H sebelum acara

💰 *Paket Minimum Spending:*
🔹 *Small Group:*
• <10 orang: Total Rp 500.000 | Deposit Rp 250.000
• 11–15 orang: Total Rp 585.000 | Deposit Rp 292.500
• 16–20 orang: Total Rp 740.000 | Deposit Rp 370.000
• 21–30 orang: Total Rp 1.000.000 | Deposit Rp 500.000

🔹 *Big Group:*
• 31–40 orang: Total Rp 1.400.000 | Deposit Rp 700.000
• 41–50 orang: Total Rp 1.700.000 | Deposit Rp 850.000
• 51–100 orang: Rp 35.000/pax | Deposit Rp 17.500/pax

🛠 *Fasilitas Tambahan (Opsional):*
• Sewa Room (sound, mic, LCD, proyektor): +Rp 200.000
• Tambah Waktu (per jam): +Rp 50.000

📝 *Silakan kirim data reservasi:*
Format: "Tanggal: [dd/mm/yyyy], Jam: [hh.mm], Tamu: [jumlah], Area: [indoor/outdoor/private], Acara: [keterangan]"

Contoh: "Tanggal: 25/05/2024, Jam: 14.00, Tamu: 15, Area: indoor, Acara: Ulang Tahun"

🔙 Ketik *BACK* untuk kembali ke menu utama`,
        nextState: 'awaiting_reservation_input'
      };
    },

    '2': async () => {
      return {
        text: `🍽️ *DAFTAR MENU - Loka Coffee & Eatery*

☕ *COFFEE:*
• Americano ............ Rp 25.000
• Latte ................ Rp 30.000
• Cappuccino ........... Rp 30.000
• Manual Brew .......... Rp 35.000
• Espresso ............. Rp 20.000

🍰 *FOOD & SNACK:*
• Croissant ............ Rp 22.000
• Sandwich ............. Rp 28.000
• Pasta ................ Rp 35.000
• Cake Slice ........... Rp 25.000
• Platter Snack ........ Rp 75.000

🧃 *NON-COFFEE:*
• Matcha Latte ......... Rp 32.000
• Chocolate ............ Rp 28.000
• Fresh Juice .......... Rp 25.000
• Mocktail ............. Rp 30.000

💬 *Cara pesan:*
Ketik: "PESAN [Nama Menu] [Jumlah]"
Contoh: "PESAN Latte 2, Croissant 3"

🔙 Ketik *BACK* untuk kembali ke menu utama`,
        nextState: 'awaiting_order_input'
      };
    },

    '3': async () => {
      return {
        text: `ℹ️ *INFO & FAQ - SOP Loka Coffee*

❓ *Pertanyaan Umum:*

🔹 *Berapa minimal reservasi?*
→ Sesuai paket jumlah tamu (lihat menu 1)

🔹 *Berapa deposit yang harus dibayar?*
→ 50% dari total minimum spending

🔹 *Bisa reschedule?*
→ Bisa, maksimal H-1 (sesuai ketersediaan)

🔹 *Apa yang terjadi jika batal?*
→ Deposit tidak dapat dikembalikan (hangus)

🔹 *Fasilitas apa saja?*
• WiFi, AC, Sound System
• Proyektor & Mic (opsional +Rp 200.000)
• Parkir luas

🔹 *Bisa tambah waktu?*
→ Bisa, Rp 50.000/jam (di luar paket)

💳 *Rekening Pembayaran:*
• BCA 8620305732 a.n Nabillah Aisah Amir
• BRI 0058010437257 a.n Nabillah Aisah Amir

🔙 Ketik *BACK* untuk kembali ke menu utama`,
        nextState: 'menu_main'
      };
    },

    '4': async () => {
      await sock.sendMessage(senderJid, {
        text: `👤 *HUBUNGI ADMIN*

Anda akan dihubungkan dengan tim kami.

📞 *WhatsApp Admin:*
• https://wa.me/6285150738708
• https://wa.me/6285649204151

⏱️ *Response time:* < 15 menit (jam operasional)

💬 Atau ketik pesan Anda di bawah, admin akan membalas secepatnya.

🔙 Ketik *BACK* untuk kembali ke menu utama`
      });
      return { nextState: 'awaiting_admin_message' };
    }
  };

  const handler = menus[choice];
  if (!handler) {
    return {
      text: `❌ Pilihan tidak valid. Silakan ketik angka *1*, *2*, *3*, atau *4*.\n\n🔙 Ketik *BACK* untuk kembali ke menu utama.`,
      nextState: 'menu_main'
    };
  }
  return await handler();
}

// ─────────────────────────────────────────────
// HELPER: Handle Reservation Input
// ─────────────────────────────────────────────
async function handleReservationInput(senderJid, rawInput, existingData) {
  // Simple parser - bisa dikembangkan dengan NLP
  const parsed = {
    tanggal: rawInput.match(/tanggal[:\s]*([0-9/\\-\s]+)/i)?.[1]?.trim(),
    jam: rawInput.match(/jam[:\s]*([0-9:.]+\s*(WIB)?)/i)?.[1]?.trim(),
    jumlah_orang: parseInt(rawInput.match(/tamu[:\s]*(\d+)/i)?.[1]) || 0,
    area: rawInput.match(/area[:\s]*(indoor|outdoor|private)/i)?.[1]?.trim(),
    acara: rawInput.match(/(acara|event|keperluan)[:\s]*(.+?)(?:,|$)/i)?.[2]?.trim()
  };

  if (!parsed.tanggal || !parsed.jam || parsed.jumlah_orang < 1) {
    await sock.sendMessage(senderJid, {
      text: `❌ Data belum lengkap. Pastikan mengisi:\n• Tanggal\n• Jam\n• Jumlah Tamu\n\n💡 Contoh:\n"Tanggal: 25/05/2024, Jam: 14.00, Tamu: 15, Area: indoor"`
    });
    return;
  }

  // Calculate deposit based on SOP
  const guests = parsed.jumlah_orang;
  let total = 0, deposit = 0;
  
  if (guests < 10) { total = 500000; deposit = 250000; }
  else if (guests <= 15) { total = 585000; deposit = 292500; }
  else if (guests <= 20) { total = 740000; deposit = 370000; }
  else if (guests <= 30) { total = 1000000; deposit = 500000; }
  else if (guests <= 40) { total = 1400000; deposit = 700000; }
  else if (guests <= 50) { total = 1700000; deposit = 850000; }
  else { total = guests * 35000; deposit = guests * 17500; }

  const reservationData = {
    ...parsed,
    total, deposit,
    sisa_pembayaran: total - deposit,
    status: 'PENDING_DEPOSIT',
    whatsapp: senderJid.replace('@s.whatsapp.net', ''),
    created_at: new Date().toISOString()
  };

  // Forward to agent/memory for persistence
  const structuredInput = `RESERVASI_REQUEST: ${JSON.stringify(reservationData)}`;
  const result = await processMessage(agentExecutor, memoryManager, senderJid, structuredInput);
  
  // Send confirmation preview
  await sock.sendMessage(senderJid, {
    text: `✅ *Preview Reservasi*

📅 Tanggal: ${parsed.tanggal}
⏰ Jam: ${formatTime(parsed.jam)}
👥 Tamu: ${parsed.jumlah_orang} orang
🏠 Area: ${parsed.area || '-'}

💰 *Pembayaran (SOP):*
• Total: ${formatCurrency(total)}
• Deposit (50%): ${formatCurrency(deposit)}
• Sisa: ${formatCurrency(total - deposit)}

🏦 *Transfer ke:*
• BCA 8620305732 a.n Nabillah Aisah Amir
• BRI 0058010437257 a.n Nabillah Aisah Amir

📸 Kirim bukti transfer untuk konfirmasi.
🔙 Ketik *BACK* untuk batal.`
  });
  
  userStates.set(senderJid, { state: 'awaiting_payment_proof', data: reservationData });
}

// ─────────────────────────────────────────────
// HELPER: Handle Order Input
// ─────────────────────────────────────────────
async function handleOrderInput(senderJid, rawInput) {
  const items = rawInput
    .replace(/PESAN|ORDER/i, '')
    .split(',')
    .map(item => {
      const match = item.trim().match(/(.+?)\s+(\d+)$/);
      return match ? { name: match[1].trim(), qty: parseInt(match[2]) } : null;
    })
    .filter(Boolean);

  if (items.length === 0) {
    await sock.sendMessage(senderJid, {
      text: `❌ Format pesanan tidak valid.\n\n💡 Contoh: "PESAN Latte 2, Croissant 3"`
    });
    return;
  }

  const structuredInput = `ORDER_REQUEST: ${JSON.stringify(items)}`;
  const result = await processMessage(agentExecutor, memoryManager, senderJid, structuredInput);
  await sock.sendMessage(senderJid, { text: result.output });
  userStates.delete(senderJid);
}

// ─────────────────────────────────────────────
// POST-RESERVATION: Confirmation Messages
// ─────────────────────────────────────────────
async function sendConfirmationToGroup(reservationData) {
  try {
    log('WA', 'Group', `Sending confirmation for ID: ${reservationData.id}`)
    const message = `🎉 *Reservasi Baru Dikonfirmasi* ✅

📋 *Detail Reservasi:*
• ID: ${reservationData.id}
• Nama: ${reservationData.nama}
• WhatsApp: ${reservationData.whatsapp}
• 📅 Tanggal: ${formatDate(new Date(reservationData.tanggal))}
• ⏰ Jam: ${formatTime(reservationData.jam)}
• 👥 Jumlah Tamu: ${reservationData.jumlah_orang} orang
• 🏠 Area: ${reservationData.kategori || reservationData.area}
• 📝 Status: ${reservationData.status}

💰 *Pembayaran (SOP):*
• Total Minimum: ${formatCurrency(reservationData.total)}
• Deposit (50%): ${formatCurrency(reservationData.deposit)}
• Sisa Pembayaran: ${formatCurrency(reservationData.sisa_pembayaran)}

⚠️ *Ketentuan:*
• Durasi: 3 jam
• Sisa 50% dibayar hari-H sebelum acara
• Pembatalan: deposit hangus

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
💰 *Deposit:* ${formatCurrency(reservationData.deposit)}
📅 *Batas:* H-1 sebelum acara

🏦 *Transfer ke:*
• BCA *8620305732* a.n. Nabillah Aisah Amir
• BRI *0058010437257* a.n. Nabillah Aisah Amir

📸 Setelah transfer, kirim bukti ke chat ini.

⚠️ *Catatan SOP:*
• Deposit mengikat reservasi
• Sisa dibayar hari-H sebelum acara
• Pembatalan = deposit hangus

Terima kasih! ☕✨`
    
    await sock.sendMessage(customerJid, { text: message })
    log('SUCCESS', 'Payment', `Payment instruction sent → ${customerJid}`)
  } catch (error) {
    log('ERROR', 'Payment', `Failed: ${error.message}`)
  }
}

async function notifyAdminForVerification(reservationData) {
  try {
    const message = `🔔 *Reservasi Baru - Verifikasi Deposit*

📋 ID: ${reservationData.id}
👤 Customer: ${reservationData.nama}
📱 WA: ${reservationData.whatsapp}
📅 ${formatDate(new Date(reservationData.tanggal))} | ${formatTime(reservationData.jam)}
👥 Tamu: ${reservationData.jumlah_orang} orang
💳 Deposit: ${formatCurrency(reservationData.deposit)}

⏳ Menunggu bukti transfer dari customer.`
    
    await sock.sendMessage(ADMIN_JID, { text: message })
    log('SUCCESS', 'Admin', `Admin notified → ${ADMIN_JID}`)
  } catch (error) {
    log('ERROR', 'Admin', `Failed: ${error.message}`)
  }
}

// ─────────────────────────────────────────────
// HELPER: Detect reservation success from agent
// ─────────────────────────────────────────────
function isReservationConfirmed(response) {
  const lower = response.toLowerCase()
  const keywords = ['reservasi berhasil', 'booking berhasil', 'id reservasi', 'reservation created', '✅', 'berhasil dibuat']
  return keywords.some(k => lower.includes(k))
}

function extractReservationId(response) {
  const match = response.match(/ID[:\s]*([a-f0-9-]{36})/i)
  return match ? match[1] : null
}

// ─────────────────────────────────────────────
// POST-RESERVATION WORKFLOW
// ─────────────────────────────────────────────
async function handleAgentResponse(userInput, agentResponse, senderJid, isGroup) {
  if (!isReservationConfirmed(agentResponse)) return
  const reservationId = extractReservationId(agentResponse)
  if (!reservationId) return

  log('AGENT', 'Workflow', `Starting post-reservation for ID: ${reservationId}`)
  try {
    const detail = await memoryManager.searchMemories(reservationId, senderJid, 1)
    const reservationData = { ...(detail[0]?.metadata || {}), id: reservationId }

    await sendConfirmationToGroup(reservationData)
    await sendPaymentInstruction(senderJid, reservationData)
    await notifyAdminForVerification(reservationData)
    
    log('SUCCESS', 'Workflow', `Completed for ID: ${reservationId}`)
  } catch (error) {
    log('ERROR', 'Workflow', `Failed: ${error.message}`)
  }
}

// ─────────────────────────────────────────────
// PROCESS USER MESSAGE (Main Entry)
// ─────────────────────────────────────────────
async function processUserMessage(senderJid, text, isGroup, msg) {
  if (!agentExecutor || !memoryManager) {
    await sock.sendMessage(senderJid, { text: '⏳ Sistem sedang inisialisasi...' })
    return
  }

  const normalizedText = text.trim().toUpperCase()
  const currentState = userStates.get(senderJid)

  // ── SPECIAL COMMANDS ──
  if (['MENU', 'BACK', 'MULAI'].includes(normalizedText)) {
    userStates.delete(senderJid)
    await sock.sendMessage(senderJid, { text: getWelcomeMessage(msg.pushName || 'Kakak') })
    log('INFO', 'Menu', `Reset to main menu for ${senderJid}`)
    return
  }

  // ── NUMBERED MENU SELECTION (1-4) ──
  if (!currentState && /^[1-4]$/.test(normalizedText)) {
    const result = await handleMenuSelection(senderJid, normalizedText)
    if (result?.text) await sock.sendMessage(senderJid, { text: result.text })
    if (result?.nextState) userStates.set(senderJid, { state: result.nextState, data: {} })
    return
  }

  // ── STATE-BASED FLOWS ──
  if (currentState) {
    switch (currentState.state) {
      case 'awaiting_reservation_input':
        await handleReservationInput(senderJid, text, currentState.data)
        return
      case 'awaiting_order_input':
        await handleOrderInput(senderJid, text)
        return
      case 'awaiting_admin_message':
        await sock.sendMessage(ADMIN_JID, {
          text: `📨 *Pesan dari Customer*\n\n👤: ${msg.pushName}\n📱: ${senderJid}\n💬: ${text}`
        })
        await sock.sendMessage(senderJid, { text: '✅ Pesan diteruskan ke admin. Kami akan segera membalas. 🙏' })
        userStates.delete(senderJid)
        return
      case 'awaiting_payment_proof':
        // Handle payment proof (image/text)
        await sock.sendMessage(senderJid, { 
          text: '📸 Bukti transfer diterima! Admin akan memverifikasi dalam <15 menit. 🙏' 
        })
        await notifyAdminForVerification(currentState.data)
        userStates.delete(senderJid)
        return
    }
  }

  // ── FIRST TIME USER ──
  const isFirstChat = !greetedUsers.has(senderJid)
  if (isFirstChat) {
    greetedUsers.add(senderJid)
    await sock.sendMessage(senderJid, { text: getWelcomeMessage(msg.pushName || 'Kakak') })
    log('INFO', 'Welcome', `Welcome sent to ${senderJid}`)
    return
  }

  // ── DEFAULT: Forward to AI Agent ──
  const sessionId = jidNormalizedUser(senderJid)
  const dedupKey = sessionId + text
  if (processingMessages.has(dedupKey)) return
  processingMessages.add(dedupKey)

  try {
    await sock.sendPresenceUpdate('composing', senderJid)
    const result = await processMessage(agentExecutor, memoryManager, sessionId, text)
    await sock.sendPresenceUpdate('available', senderJid)
    
    await sock.sendMessage(senderJid, { text: result.output })
    await handleAgentResponse(text, result.output, senderJid, isGroup)
  } catch (error) {
    log('ERROR', 'Agent', `Failed: ${error.message}`)
    await sock.sendMessage(senderJid, {
      text: 'Maaf, terjadi kendala. Ketik *MENU* untuk kembali ke pilihan utama. 🙏'
    })
  } finally {
    processingMessages.delete(dedupKey)
  }
}

// ─────────────────────────────────────────────
// INITIALIZE AGENT
// ─────────────────────────────────────────────
async function initializeAgent() {
  log('AGENT', 'Init', 'Initializing Loka Agent...')
  try {
    const { agentExecutor: executor, memoryManager: manager } = await createLokaAgent()
    agentExecutor = executor
    memoryManager = manager
    log('SUCCESS', 'Init', 'Loka Agent initialized')
    return true
  } catch (error) {
    log('ERROR', 'Init', `Failed: ${error.message}`)
    return false
  }
}

// ─────────────────────────────────────────────
// WHATSAPP SOCKET
// ─────────────────────────────────────────────
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
    const { connection, lastDisconnect, qr, isNewLogin } = update

    if (qr) {
      log('WA', 'QR', 'Scan QR to login')
      try {
        const qrDataUrl = await qrcode.toDataURL(qr)
        console.log('\n🔗 QR Data URL:\n', qrDataUrl, '\n')
      } catch { console.log('QR (raw):', qr) }
    }

    if (connection === 'open') {
      logDivider('═')
      log('SUCCESS', 'Socket', 'WhatsApp connected!')
      log('WA', 'Socket', `Admin: ${ADMIN_JID} | Group: ${GROUP_CONFIRMATION_JID}`)
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
    const sender = isGroup ? msg.key.participant : jid
    const senderName = msg.pushName || 'Pengguna'
    const contentType = getContentType(msg.message)

    let text = ''
    if (contentType === 'conversation') text = msg.message.conversation
    else if (contentType === 'extendedTextMessage') text = msg.message.extendedTextMessage?.text || ''
    else if (contentType === 'imageMessage' && msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption
    else if (contentType === 'videoMessage' && msg.message.videoMessage?.caption) text = msg.message.videoMessage.caption

    if (!text?.trim()) {
      log('INFO', 'Msg', `Non-text from ${senderName} — ignored`)
      return
    }

    logDivider()
    log('EVENT', 'Msg', `[${isGroup?'GROUP':'PRIVATE'}] ${senderName} (${sender})`)
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

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
logDivider('═')
log('SYSTEM', 'Boot', '🚀 Starting Loka Coffee Bot...')
log('SYSTEM', 'Boot', '📱 WhatsApp Baileys + LangChain Agent + FAISS Memory')
log('SYSTEM', 'Boot', `⏰ Reminder: ${GROUP_CONFIRMATION_JID} | 👤 Admin: ${ADMIN_JID}`)
logDivider('═')

startSock().catch((error) => {
  log('ERROR', 'Boot', `Fatal: ${error.message}`)
  console.error(error.stack)
  process.exit(1)
})