import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const API_URL = 'https://script.google.com/macros/s/AKfycbxcmAqb5ASUipihtlxfFbIeZ0Y2ITQ3cuG_q6s86zaxnFsXWTyYtss1NAC9hp8473GUeQ/exec'
const REMINDER_STATE_FILE = './memory-store/reminder-state.json'
const GROUP_JID = '120363406492419821@g.us'
const REMINDER_HOURS_BEFORE = 5
const DEFAULT_INTERVAL_MINUTES = 600 // ✅ 10 jam

let sock = null

// ─────────────────────────────────────────────
// LOGGER (konsisten dengan index.js)
// ─────────────────────────────────────────────
const LOG_LEVELS = { INFO: '📘 INFO', WARN: '⚠️  WARN', ERROR: '❌ ERROR', SUCCESS: '✅ OK  ', CRON: '⏰ CRON ' }

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
// SET SOCKET
// ─────────────────────────────────────────────
export function setWhatsAppSocket(socket) {
  sock = socket
  log('SUCCESS', 'Cron', 'WhatsApp socket registered')
}

// ─────────────────────────────────────────────
// STATE: load & save reminder yang sudah terkirim
// ─────────────────────────────────────────────
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
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
      log('INFO', 'State', `Created directory: ${dir}`)
    }
    await writeFile(REMINDER_STATE_FILE, JSON.stringify(state, null, 2))
    log('SUCCESS', 'State', `Reminder state saved — ${Object.keys(state.sent).length} total entries`)
  } catch (error) {
    log('ERROR', 'State', `Failed to save reminder state: ${error.message}`)
  }
}

// ─────────────────────────────────────────────
// FETCH RESERVASI
// ─────────────────────────────────────────────
async function fetchReservations() {
  log('CRON', 'Fetch', `Fetching reservations from API...`)
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
    log('WARN', 'Fetch', `API returned success=false or no data: ${data.message || data.error || '-'}`)
    return []
  } catch (error) {
    log('ERROR', 'Fetch', `Failed to fetch reservations: ${error.message}`)
    return []
  }
}

// ─────────────────────────────────────────────
// UTIL
// ─────────────────────────────────────────────
function parseReservationDateTime(tanggal, jam) {
  try {
    const [year, month, day] = tanggal.split('-').map(Number)
    const timeMatch = jam?.match(/(\d{2}):(\d{2})/)
    const hours = timeMatch ? parseInt(timeMatch[1]) : 0
    const minutes = timeMatch ? parseInt(timeMatch[2]) : 0
    return new Date(year, month - 1, day, hours, minutes, 0)
  } catch {
    return null
  }
}

function isWithinReminderWindow(eventDateTime, hoursBefore = REMINDER_HOURS_BEFORE) {
  const now = new Date()
  const reminderTime = new Date(eventDateTime.getTime() - hoursBefore * 60 * 60 * 1000)
  const windowEnd = new Date(reminderTime.getTime() + 2 * 60 * 60 * 1000) // window 2 jam
  const inWindow = now >= reminderTime && now <= windowEnd
  return inWindow
}

function formatTime(date) {
  return date.toLocaleString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', minimumFractionDigits: 0
  }).format(amount)
}

// ─────────────────────────────────────────────
// KIRIM REMINDER KE GRUP
// ─────────────────────────────────────────────
async function sendReminderToGroup(reservation) {
  if (!sock) {
    log('ERROR', 'Reminder', 'WhatsApp socket not initialized — cannot send reminder')
    return false
  }

  const eventDateTime = parseReservationDateTime(reservation.tanggal, reservation.jam)
  if (!eventDateTime) {
    log('ERROR', 'Reminder', `Invalid date/time for reservation ID: ${reservation.id}`)
    return false
  }

  const minutesUntil = Math.round((eventDateTime - new Date()) / (1000 * 60))
  const hours = Math.floor(minutesUntil / 60)
  const minutes = minutesUntil % 60

  log('CRON', 'Reminder', `Preparing reminder for ${reservation.nama} (ID: ${reservation.id}) — in ${hours}h ${minutes}m`)

  const message = `⏰ *Reminder Reservasi - Loka Coffee*

📋 *Detail Acara:*
• ID: ${reservation.id}
• Nama: ${reservation.nama}
• 📅 Tanggal: ${formatTime(eventDateTime)}
• ⏰ Dalam: ${hours} jam ${minutes} menit lagi
• 👥 Tamu: ${reservation.jumlah_orang} orang
• 🏠 Area: ${reservation.area || reservation.kategori || '-'}
• 📝 Catatan: ${reservation.catatan || '-'}

💰 *Status Pembayaran:*
• Total: ${formatCurrency(reservation.total)}
• Deposit: ${formatCurrency(reservation.deposit)}
• Sisa: ${formatCurrency(reservation.sisa_pembayaran)}
• Status: ${reservation.status || 'PENDING'}

⚠️ *Penting:*
• Pastikan deposit sudah dibayar
• Konfirmasi kehadiran H-1
• Hubungi admin jika ada perubahan

Terima kasih! ☕✨`

  try {
    await sock.sendMessage(GROUP_JID, { text: message })
    log('SUCCESS', 'Reminder', `Reminder sent for ID: ${reservation.id} → ${GROUP_JID}`)
    return true
  } catch (error) {
    log('ERROR', 'Reminder', `Failed to send reminder for ID ${reservation.id}: ${error.message}`)
    return false
  }
}

// ─────────────────────────────────────────────
// MAIN: jalankan pengecekan reminder
// ─────────────────────────────────────────────
export async function runReservationReminders() {
  logDivider()
  log('CRON', 'Run', `Reminder check started at ${new Date().toLocaleString('id-ID')}`)

  const state = await loadReminderState()
  const reservations = await fetchReservations()

  if (reservations.length === 0) {
    log('INFO', 'Run', 'No reservations found — skipping')
    logDivider()
    return
  }

  const now = new Date()
  let checked = 0, skippedPast = 0, skippedCancelled = 0, skippedAlreadySent = 0, skippedOutOfWindow = 0, remindersSent = 0

  for (const reservation of reservations) {
    checked++

    if (reservation.status === 'CANCELLED') {
      skippedCancelled++
      log('INFO', 'Check', `[SKIP-CANCELLED] ${reservation.nama} (ID: ${reservation.id})`)
      continue
    }

    const eventDateTime = parseReservationDateTime(reservation.tanggal, reservation.jam)
    if (!eventDateTime) {
      log('WARN', 'Check', `[SKIP-INVALID-DATE] ${reservation.nama} (ID: ${reservation.id}) — tanggal: ${reservation.tanggal}, jam: ${reservation.jam}`)
      continue
    }

    if (eventDateTime < now) {
      skippedPast++
      log('INFO', 'Check', `[SKIP-PAST] ${reservation.nama} (ID: ${reservation.id}) — event sudah lewat: ${formatTime(eventDateTime)}`)
      continue
    }

    const reminderKey = `${reservation.id}_${REMINDER_HOURS_BEFORE}h`
    if (state.sent[reminderKey]) {
      skippedAlreadySent++
      log('INFO', 'Check', `[SKIP-SENT] ${reservation.nama} (ID: ${reservation.id}) — reminder sudah terkirim pada ${state.sent[reminderKey].sentAt}`)
      continue
    }

    if (!isWithinReminderWindow(eventDateTime, REMINDER_HOURS_BEFORE)) {
      const minutesUntilReminder = Math.round(
        (eventDateTime.getTime() - REMINDER_HOURS_BEFORE * 3600000 - now.getTime()) / 60000
      )
      skippedOutOfWindow++
      log('INFO', 'Check', `[SKIP-NOT-YET] ${reservation.nama} — reminder dalam ~${minutesUntilReminder} menit`)
      continue
    }

    log('CRON', 'Check', `[SEND] ${reservation.nama} (ID: ${reservation.id}) — dalam window H-${REMINDER_HOURS_BEFORE}h`)
    const sent = await sendReminderToGroup(reservation)

    if (sent) {
      state.sent[reminderKey] = {
        sentAt: new Date().toISOString(),
        reservationId: reservation.id,
        nama: reservation.nama,
        eventDateTime: eventDateTime.toISOString()
      }
      remindersSent++
    }
  }

  await saveReminderState(state)

  logDivider()
  log('SUCCESS', 'Run', `Reminder check selesai — ${new Date().toLocaleString('id-ID')}`)
  log('INFO', 'Summary', `Total    : ${checked} reservasi`)
  log('INFO', 'Summary', `Terkirim : ${remindersSent}`)
  log('INFO', 'Summary', `Skip (sudah terkirim) : ${skippedAlreadySent}`)
  log('INFO', 'Summary', `Skip (belum waktunya) : ${skippedOutOfWindow}`)
  log('INFO', 'Summary', `Skip (event lewat)    : ${skippedPast}`)
  log('INFO', 'Summary', `Skip (dibatalkan)     : ${skippedCancelled}`)
  logDivider()
}

// ─────────────────────────────────────────────
// START CRON (default: 10 jam = 600 menit)
// ─────────────────────────────────────────────
export function startReminderCron(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
  const intervalHours = (intervalMinutes / 60).toFixed(1)
  logDivider('═')
  log('CRON', 'Start', `Reservation reminder cron started`)
  log('CRON', 'Start', `Interval     : every ${intervalMinutes} minutes (${intervalHours} hours)`)
  log('CRON', 'Start', `Reminder at  : H-${REMINDER_HOURS_BEFORE} hours before event`)
  log('CRON', 'Start', `Target group : ${GROUP_JID}`)
  logDivider('═')

  // Jalankan sekali langsung saat start
  runReservationReminders()

  const intervalId = setInterval(() => {
    log('CRON', 'Tick', `Interval triggered — running reminder check...`)
    runReservationReminders()
  }, intervalMinutes * 60 * 1000)

  return () => {
    clearInterval(intervalId)
    log('CRON', 'Stop', 'Reminder cron stopped')
  }
}

// ─────────────────────────────────────────────
// STANDALONE MODE
// ─────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  logDivider('═')
  log('CRON', 'Standalone', '🚀 Running in standalone mode')
  log('CRON', 'Standalone', `Group JID    : ${GROUP_JID}`)
  log('CRON', 'Standalone', `Reminder     : H-${REMINDER_HOURS_BEFORE} hours`)
  log('CRON', 'Standalone', `Interval     : ${DEFAULT_INTERVAL_MINUTES} minutes (${DEFAULT_INTERVAL_MINUTES / 60} hours)`)
  logDivider('═')

  const stopCron = startReminderCron(DEFAULT_INTERVAL_MINUTES)

  process.on('SIGINT', () => { stopCron(); process.exit(0) })
  process.on('SIGTERM', () => { stopCron(); process.exit(0) })
}