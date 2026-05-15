import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'

const API_URL = 'https://script.google.com/macros/s/AKfycbz0qMDYXJZrOp3xbDk4cNYoODRqs05-32_hd89FXECm6fQAuVyaJSTIYNk7zc3ZYXaN7Q/exec'
const REMINDER_STATE_FILE = './memory-store/reminder-state.json'
const GROUP_JID = '120363406492419821@g.us'
const REMINDER_HOURS_BEFORE = 5
const DEFAULT_INTERVAL_MINUTES = 30
const TIMEZONE_OFFSET_HOURS = 7

let sock = null

const LOG_LEVELS = {
  INFO: '📘 INFO',
  WARN: '⚠️  WARN',
  ERROR: '❌ ERROR',
  SUCCESS: '✅ OK  ',
  CRON: '⏰ CRON ',
  SEND: '📤 SEND '
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

export function setWhatsAppSocket(socket) {
  sock = socket
  log('SUCCESS', 'Cron', 'WhatsApp socket registered')
}

async function loadReminderState() {
  try {
    if (existsSync(REMINDER_STATE_FILE)) {
      const data = await readFile(REMINDER_STATE_FILE, 'utf-8')
      const state = JSON.parse(data)
      log('INFO', 'State', `Loaded reminder state — ${Object.keys(state.sent || {}).length} sent entries`)
      return state
    }
    log('INFO', 'State', 'No existing state file — starting fresh')
  } catch (error) {
    log('ERROR', 'State', `Failed to load reminder state: ${error.message}`)
  }
  return { sent: {} }
}

async function saveReminderState(state) {
  try {
    const dir = dirname(REMINDER_STATE_FILE)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    await writeFile(REMINDER_STATE_FILE, JSON.stringify(state, null, 2))
    log('SUCCESS', 'State', `Reminder state saved — ${Object.keys(state.sent).length} total entries`)
  } catch (error) {
    log('ERROR', 'State', `Failed to save reminder state: ${error.message}`)
  }
}

async function fetchReservations() {
  log('CRON', 'Fetch', 'Fetching reservations from API...')
  try {
    const response = await fetch(`${API_URL}?action=list`, {
      headers: { 'Content-Type': 'application/json' },
      redirect: 'follow'
    })
    const data = await response.json()
    if (data.success && Array.isArray(data.data)) {
      log('SUCCESS', 'Fetch', `Fetched ${data.data.length} reservations`)
      return data.data
    }
    log('WARN', 'Fetch', `API returned no data: ${data.message || data.error || '-'}`)
    return []
  } catch (error) {
    log('ERROR', 'Fetch', `Failed to fetch: ${error.message}`)
    return []
  }
}

async function markReminderSentOnSheet(id) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'follow',
      body: JSON.stringify({ action: 'mark_reminder_sent', id })
    })
    const data = await response.json()
    if (data.success) {
      log('SUCCESS', 'Sheet', `reminder_status updated — ID: ${id}, sentAt: ${data.sentAt}`)
    } else {
      log('WARN', 'Sheet', `Gagal update Sheets untuk ID: ${id} — ${data.error}`)
    }
  } catch (error) {
    log('ERROR', 'Sheet', `Gagal hit API mark_reminder_sent: ${error.message}`)
  }
}

// ─────────────────────────────────────────────
// ✅ DATE/TIME PARSER & FORMATTER (SOP-COMPLIANT)
// ─────────────────────────────────────────────
function parseReservationDateTime(tanggal, jam) {
  try {
    let year, month, day, hours = 0, minutes = 0

    // Parse tanggal dari berbagai format (Google Sheets serial, ISO, string)
    if (typeof tanggal === 'number') {
      // Excel/Sheets serial date
      const d = new Date((tanggal - 25569) * 86400000)
      year = d.getUTCFullYear(); month = d.getUTCMonth() + 1; day = d.getUTCDate()
    } else if (typeof tanggal === 'string' && tanggal.includes('T')) {
      // ISO format
      const d = new Date(tanggal)
      year = d.getUTCFullYear(); month = d.getUTCMonth() + 1; day = d.getUTCDate()
    } else {
      // String format: "YYYY-MM-DD" atau "DD-MM-YYYY"
      const parts = String(tanggal).split(/[-/]/).map(Number)
      if (parts[0] > 31) { year = parts[0]; month = parts[1]; day = parts[2] }
      else { day = parts[0]; month = parts[1]; year = parts[2] || new Date().getFullYear() }
    }

    // Parse jam dari berbagai format
    if (typeof jam === 'number') {
      // Excel decimal time (0.5 = 12:00)
      const totalMinutes = Math.round(jam * 24 * 60)
      hours = Math.floor(totalMinutes / 60) % 24
      minutes = totalMinutes % 60
    } else if (typeof jam === 'string' && jam.includes('T')) {
      const t = new Date(jam)
      hours = t.getUTCHours(); minutes = t.getUTCMinutes()
    } else {
      // String: "14:00", "14.00", "2 PM"
      const timeMatch = String(jam).match(/(\d{1,2})[:.](\d{2})/)
      if (timeMatch) {
        hours = parseInt(timeMatch[1]); minutes = parseInt(timeMatch[2])
      } else {
        const pmMatch = String(jam).match(/(\d{1,2})\s*(pm|pagi|siang|sore|malam)/i)
        if (pmMatch) {
          hours = parseInt(pmMatch[1])
          if (/pm|sore|malam/i.test(pmMatch[2]) && hours < 12) hours += 12
          if (/pagi/i.test(pmMatch[2]) && hours === 12) hours = 0
        }
      }
    }

    // Convert ke UTC untuk konsistensi, lalu akan diformat ke WIB saat display
    const utcMs = Date.UTC(year, month - 1, day, hours - TIMEZONE_OFFSET_HOURS, minutes, 0)
    return new Date(utcMs)
  } catch (err) {
    log('ERROR', 'Parse', `Failed to parse datetime: ${err.message}`)
    return null
  }
}

// ✅ Format: "Sabtu, 25 Mei 2024, 14.00 WIB"
function formatDateTime(date) {
  return date.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(',', '') + ' WIB'
}

// ✅ Format singkat untuk reminder: "25 Mei 2024, 14.00 WIB"
function formatDateTimeShort(date) {
  const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu']
  const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']
  
  const d = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }))
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2,'0')}.${String(d.getMinutes()).padStart(2,'0')} WIB`
}

function formatCurrency(amount) {
  const num = typeof amount === 'string'
    ? parseInt(amount.replace(/\./g, '').replace(',', '.'))
    : Number(amount)
  return `Rp ${new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0 }).format(num || 0)}`
}

// ─────────────────────────────────────────────
// SEND REMINDER (Group + Customer)
// ─────────────────────────────────────────────
async function sendReminderToGroup(reservation, eventDateTime) {
  if (!sock) {
    log('ERROR', 'Reminder', 'WhatsApp socket not initialized')
    return false
  }

  const now = new Date()
  const minutesUntil = Math.round((eventDateTime - now) / (1000 * 60))
  const hoursLeft = Math.floor(minutesUntil / 60)
  const minsLeft = minutesUntil % 60

  const message = `⏰ *Reminder Reservasi - Loka Coffee & Eatery*

📋 *Detail Acara:*
• ID: ${reservation.id}
• Nama: ${reservation.nama}
• 📅 Tanggal: ${formatDateTimeShort(eventDateTime)}
• ⏰ Dalam: ${hoursLeft} jam ${minsLeft} menit lagi
• 👥 Tamu: ${reservation.jumlah_orang} orang
• 🏠 Area: ${reservation.area || reservation.kategori || '-'}
• 📝 Catatan: ${reservation.catatan || '-'}

💰 *Status Pembayaran (SOP):*
• Total Minimum: ${formatCurrency(reservation.subtotal || reservation.total)}
• Deposit (50%): ${formatCurrency(reservation.deposit)}
• Sisa (50%): ${formatCurrency(reservation.sisa_pembayaran)}
• Status: ${reservation.status || 'PENDING'}

⚠️ *Penting:*
• Pastikan deposit sudah dibayar H-1
• Sisa pembayaran dilunasi sebelum acara dimulai
• Durasi penggunaan ruang: 3 jam
• Hubungi admin jika ada perubahan/reschedule

Terima kasih! ☕✨`

  try {
    // Send to Group
    await sock.sendMessage(GROUP_JID, { text: message })
    log('SUCCESS', 'Reminder', `Reminder sent to group — ${reservation.nama} (ID: ${reservation.id})`)

    // Send to Customer (if whatsapp number available)
    if (reservation.whatsapp) {
      const customerJid = reservation.whatsapp.includes('@s.whatsapp.net')
        ? reservation.whatsapp
        : `${reservation.whatsapp.replace(/^0/, '62')}@s.whatsapp.net`

      await sock.sendMessage(customerJid, { text: message })
      log('SUCCESS', 'Reminder', `Reminder sent to customer — ${reservation.nama}`)
    }
    return true
  } catch (error) {
    log('ERROR', 'Reminder', `Failed to send — ID ${reservation.id}: ${error.message}`)
    return false
  }
}

// ─────────────────────────────────────────────
// MAIN CRON RUNNER
// ─────────────────────────────────────────────
export async function runReservationReminders() {
  logDivider()
  log('CRON', 'Run', `Reminder check started — ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`)

  const state = await loadReminderState()
  const reservations = await fetchReservations()

  if (!reservations.length) {
    log('INFO', 'Run', 'No reservations found')
    return
  }

  const now = Date.now()
  const thresholdMs = REMINDER_HOURS_BEFORE * 60 * 60 * 1000
  let checked = 0, sent = 0

  for (const r of reservations) {
    checked++
    const id = r.id
    const status = String(r.status || '').toUpperCase()

    // Skip cancelled or already reminded
    if (status === 'CANCELLED') continue
    if (String(r.reminder_status || '').toUpperCase().startsWith('SENT')) continue
    if (state.sent[id]) continue

    const eventDateTime = parseReservationDateTime(r.tanggal, r.jam)
    if (!eventDateTime) continue

    const eventMs = eventDateTime.getTime()
    if (eventMs <= now) {
      log('INFO', 'SKIP', `Expired event: ${r.nama}`)
      continue
    }

    const diff = eventMs - now
    if (diff > thresholdMs) continue // Only send if within 5-hour window

    log('SEND', 'Reminder', `Sending reminder → ${r.nama} (${id})`)
    const success = await sendReminderToGroup(r, eventDateTime)

    if (success) {
      sent++
      state.sent[id] = { sentAt: new Date().toISOString(), event: eventDateTime.toISOString() }
      await markReminderSentOnSheet(id)
    }
  }

  await saveReminderState(state)
  log('SUCCESS', 'Run', `Done. Checked=${checked}, Sent=${sent}`)
  logDivider()
}

export function startReminderCron(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
  logDivider('═')
  log('CRON', 'Start', `Reminder cron started`)
  log('CRON', 'Start', `Interval    : setiap ${intervalMinutes} menit`)
  log('CRON', 'Start', `Kirim jika  : event < ${REMINDER_HOURS_BEFORE} jam lagi`)
  log('CRON', 'Start', `Target grup : ${GROUP_JID}`)
  logDivider('═')

  runReservationReminders()
  const intervalId = setInterval(() => {
    log('CRON', 'Tick', 'Interval triggered — running reminder check...')
    runReservationReminders()
  }, intervalMinutes * 60 * 1000)

  return () => {
    clearInterval(intervalId)
    log('CRON', 'Stop', 'Reminder cron stopped')
  }
}

// Standalone mode
if (import.meta.url === `file://${process.argv[1]}`) {
  logDivider('═')
  log('CRON', 'Standalone', '🚀 Running in standalone mode')
  log('CRON', 'Standalone', `Group JID  : ${GROUP_JID}`)
  log('CRON', 'Standalone', `Kirim jika : event < ${REMINDER_HOURS_BEFORE} jam lagi`)
  log('CRON', 'Standalone', `Interval   : ${DEFAULT_INTERVAL_MINUTES} menit`)
  logDivider('═')
  const stopCron = startReminderCron(DEFAULT_INTERVAL_MINUTES)
  process.on('SIGINT', () => { stopCron(); process.exit(0) })
  process.on('SIGTERM', () => { stopCron(); process.exit(0) })
}