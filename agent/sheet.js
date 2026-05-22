import { Tool } from '@langchain/core/tools'
import { z } from 'zod'

const API_URL =
  'https://script.google.com/macros/s/AKfycbwrohUnOPWvKy1HX1b0ool2GE1XZtDjPLsZp7Zx5fL22GtInvMmwReRaiueJFL-oXt0Xw/exec'

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json'
}

const LOG = {
  INFO: '📘 INFO',
  ERROR: '❌ ERROR',
  SUCCESS: '✅ OK',
  WARN: '⚠️ WARN',
  API: '🌐 API'
}

function logger(level, context, message, data) {
  const ts = new Date().toLocaleTimeString('id-ID', {
    hour12: false
  })

  console.log(
    `${ts} ${LOG[level] || level} [${context}] ${message}`
  )

  if (data !== undefined && data !== null) {
    console.log(
      '↳',
      typeof data === 'object'
        ? JSON.stringify(data, null, 2)
        : data
    )
  }
}

function normalizeWhatsapp(number) {
  if (!number) return ''

  let clean = String(number)
    .replace(/\D/g, '')
    .trim()

  if (clean.startsWith('62')) {
    clean = '0' + clean.slice(2)
  }

  if (!clean.startsWith('0')) {
    clean = '0' + clean
  }

  return clean
}

function normalizeDate(date) {
  if (!date) return ''

  const clean = String(date).trim()

  const match = clean.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/
  )

  if (!match) {
    throw new Error(
      'Format tanggal harus YYYY-MM-DD'
    )
  }

  const year = match[1]
  const month = match[2].padStart(2, '0')
  const day = match[3].padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeTime(time) {
  if (!time) return ''
  const clean = String(time).trim().replace('.', ':')
  const stripped = clean.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1')
  const match = stripped.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) throw new Error('Format jam harus HH:mm atau HH.mm')
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) throw new Error('Jam tidak valid')
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0
  }).format(Number(amount || 0))
}

function normalizeReservation(item) {
  let formattedJam = item.jam

  try {
    if (
      item.jam &&
      String(item.jam).includes('T')
    ) {
      const timeDate = new Date(item.jam)

      formattedJam = `${String(
        timeDate.getUTCHours()
      ).padStart(2, '0')}:${String(
        timeDate.getUTCMinutes()
      ).padStart(2, '0')}`
    }
  } catch {}

  let formattedTanggal = item.tanggal

  try {
    if (
      item.tanggal &&
      String(item.tanggal).includes('T')
    ) {
      formattedTanggal = String(item.tanggal)
        .split('T')[0]
    }
  } catch {}

  return {
    ...item,
    tanggal: formattedTanggal,
    jam: formattedJam,
    formatted_subtotal: formatCurrency(
      item.subtotal
    ),
    formatted_deposit: formatCurrency(
      item.deposit
    ),
    formatted_sisa_pembayaran:
      formatCurrency(item.sisa_pembayaran)
  }
}

async function apiFetch(
  params,
  body,
  method = 'GET'
) {
  const url = new URL(API_URL)

  if (params) {
    Object.entries(params).forEach(
      ([key, value]) => {
        if (
          value !== undefined &&
          value !== null
        ) {
          url.searchParams.append(
            key,
            String(value)
          )
        }
      }
    )
  }

  logger(
    'API',
    'Request',
    `${method} ${url.toString()}`
  )

  if (body) {
    logger(
      'INFO',
      'API-BODY',
      'Request body',
      body
    )
  }

  const options = {
    method,
    headers: DEFAULT_HEADERS,
    redirect: 'follow'
  }

  if (body && method === 'POST') {
    options.body = JSON.stringify(body)
  }

  try {
    const response = await fetch(
      url.toString(),
      options
    )

    logger(
      'INFO',
      'API',
      `Status: ${response.status} ${response.statusText}`
    )

    logger(
      'INFO',
      'API',
      'Response headers',
      Object.fromEntries(
        response.headers.entries()
      )
    )

    const text = await response.text()

    logger(
      'INFO',
      'API-RAW',
      'Raw response text',
      text
    )

    const data = safeJsonParse(text)

    logger(
      'INFO',
      'API-PARSED',
      'Parsed JSON',
      data
    )

    if (!data) {
      throw new Error(
        'Invalid JSON response'
      )
    }

    logger(
      'SUCCESS',
      'API',
      'Response received successfully'
    )

    return data
  } catch (error) {
    logger(
      'ERROR',
      'API',
      error.message,
      {
        stack: error.stack
      }
    )

    throw error
  }
}

export class LokaReservationInfoTool extends Tool {
  constructor() {
    super()

    this.name = 'loka_reservation_info'

    this.description = `
Gunakan tool ini hanya untuk debugging API.
`.trim()

    this.schema = z.object({})
  }

  async _call() {
    try {
      const data = await apiFetch()

      return JSON.stringify(data, null, 2)
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error.message
      })
    }
  }
}

export class LokaReservationListTool extends Tool {
  constructor() {
    super()

    this.name = 'loka_reservation_list'

    this.description = `
Gunakan tool ini untuk melihat daftar reservasi. Semua parameter bersifat opsional — gunakan filter untuk mempersempit hasil.
Contoh penggunaan:
- Semua reservasi: args kosong {}
- Reservasi hari ini: { "tanggal": "2026-05-22" }
- Reservasi rentang: { "tanggal_dari": "2026-05-22", "tanggal_sampai": "2026-05-28" }
- Filter status: { "status": "PENDING" } atau multi: { "status": "PENDING,CONFIRMED" }
- Filter area: { "area": "Indoor" }
- Cari nama: { "nama": "Budi" }
- Kombinasi: { "tanggal": "2026-05-22", "status": "PENDING" }
`.trim()

    this.schema = z.object({
      tanggal:        z.string().optional().describe('Filter tanggal tepat, format YYYY-MM-DD'),
      tanggal_dari:   z.string().optional().describe('Awal rentang tanggal, format YYYY-MM-DD'),
      tanggal_sampai: z.string().optional().describe('Akhir rentang tanggal, format YYYY-MM-DD'),
      status:         z.string().optional().describe('Filter status: PENDING, CONFIRMED, CANCELLED, DONE. Bisa multi pisah koma'),
      area:           z.string().optional().describe('Filter area, partial match case-insensitive'),
      nama:           z.string().optional().describe('Cari berdasarkan nama customer, partial match')
    })
  }

  async _call(input = {}) {
    try {
      const params = { action: 'list' }

      if (input.tanggal)        params.tanggal        = input.tanggal
      if (input.tanggal_dari)   params.tanggal_dari   = input.tanggal_dari
      if (input.tanggal_sampai) params.tanggal_sampai = input.tanggal_sampai
      if (input.status)         params.status         = input.status
      if (input.area)           params.area           = input.area
      if (input.nama)           params.nama           = input.nama

      const data = await apiFetch(params)

      if (!data.success) {
        return JSON.stringify({
          success: false,
          error: data.error || data.message
        })
      }

      const reservations = Array.isArray(data.data) ? data.data : []

      // Deduplicate by nama+tanggal+jam
      const uniqueReservations = Object.values(
        reservations.reduce((acc, item) => {
          const key = `${item.nama}_${item.tanggal}_${item.jam}`
          if (!acc[key]) acc[key] = normalizeReservation(item)
          return acc
        }, {})
      )

      logger('SUCCESS', 'Reservation', `Fetched ${uniqueReservations.length} reservations`, { filters: params })

      return JSON.stringify({
        success: true,
        count: uniqueReservations.length,
        reservations: uniqueReservations
      }, null, 2)
    } catch (error) {
      logger('ERROR', 'Reservation-List', error.message)
      return JSON.stringify({ success: false, error: error.message })
    }
  }
}

export class LokaReservationDetailTool extends Tool {
  constructor() {
    super()

    this.name = 'loka_reservation_detail'

    this.description = `
Gunakan tool ini untuk melihat detail reservasi berdasarkan ID.
`.trim()

    this.schema = z.object({
      id: z.string().min(1)
    })
  }

  async _call(input) {
    try {
      const data = await apiFetch({
        action: 'detail',
        id: input.id
      })

      if (data?.data) {
        data.data = normalizeReservation(
          data.data
        )
      }

      logger(
        'SUCCESS',
        'Reservation-Detail',
        'Reservation detail fetched',
        data
      )

      return JSON.stringify(data, null, 2)
    } catch (error) {
      logger(
        'ERROR',
        'Reservation-Detail',
        error.message
      )

      return JSON.stringify({
        success: false,
        error: error.message
      })
    }
  }
}

export class LokaReservationCreateTool extends Tool {
  constructor() {
    super()

    this.name = 'loka_reservation_create'

    this.description = `
Gunakan tool ini untuk membuat reservasi baru. Semua field menggunakan nama bahasa Indonesia.
Field wajib: nama (string), whatsapp (string, format 08xxx), tanggal (string, format YYYY-MM-DD), jam (string, format HH:mm), jumlah_orang (number).
Field opsional: area ("Indoor" | "Outdoor"), room_charge (boolean), extra_hour (number 0-5), catatan (string).
`.trim()

    this.schema = z.object({
      nama: z.string().min(2),

      whatsapp: z.string().min(10),

      tanggal: z.string(),

      jam: z.string(),

      jumlah_orang: z.number()
        .int()
        .min(1)
        .max(100),

      area: z
        .enum(['Indoor', 'Outdoor'])
        .optional(),

      room_charge: z
        .boolean()
        .optional(),

      extra_hour: z.number()
        .int()
        .min(0)
        .max(5)
        .optional(),

      catatan: z.string().optional()
    })
  }

  async _call(input) {
    console.log('🔥 TOOL DIPANGGIL:', JSON.stringify(input)) 
    try {
      const payload = {
        nama: input.nama.trim(),

        whatsapp: normalizeWhatsapp(
          input.whatsapp
        ),

        tanggal: normalizeDate(
          input.tanggal
        ),

        jam: normalizeTime(input.jam),

        jumlah_orang: Number(
          input.jumlah_orang
        ),

        area: input.area || '',

        room_charge:
          input.room_charge || false,

        extra_hour:
          input.extra_hour || 0,

        catatan: input.catatan || ''
      }

      logger(
        'INFO',
        'Reservation',
        'Creating reservation',
        payload
      )

      const data = await apiFetch(
        null,
        payload,
        'POST'
      )

      if (!data.success) {
        return JSON.stringify({
          success: false,
          error:
            data.error || data.message
        })
      }

      const reservation =
        normalizeReservation(
          data.data || {}
        )

      logger(
        'SUCCESS',
        'Reservation',
        'Reservation created successfully',
        reservation
      )

      console.log('[CreateTool] Full data.data from API:', JSON.stringify(data.data, null, 2))

      return JSON.stringify(
        {
          success: true,
          message:
            'Reservation created successfully',
          reservation
        },
        null,
        2
      )
    } catch (error) {
      logger(
        'ERROR',
        'Reservation',
        error.message,
        {
          stack: error.stack
        }
      )

      return JSON.stringify({
        success: false,
        error: error.message
      })
    }
  }
}

export class LokaReservationUpdateStatusTool extends Tool {
  constructor() {
    super()
    this.name = 'loka_reservation_update_status'
    this.description = `
Gunakan tool ini untuk mengubah status reservasi.
Status yang valid: PENDING, CONFIRMED, CANCELLED, DONE.
Field wajib: id (string UUID), status (string).
`.trim()
    this.schema = z.object({
      id:     z.string().min(1).describe('ID reservasi (UUID)'),
      status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'DONE']).describe('Status baru')
    })
  }

  async _call(input) {
    try {
      const data = await apiFetch(null, {
        action: 'update_status',
        id:     input.id,
        status: input.status
      }, 'POST')

      logger('SUCCESS', 'Reservation-UpdateStatus', `Status updated: ${input.id} → ${input.status}`)
      return JSON.stringify(data, null, 2)
    } catch (error) {
      logger('ERROR', 'Reservation-UpdateStatus', error.message)
      return JSON.stringify({ success: false, error: error.message })
    }
  }
}

export function createLokaReservationTools() {
  return [
    new LokaReservationInfoTool(),
    new LokaReservationListTool(),
    new LokaReservationDetailTool(),
    new LokaReservationCreateTool(),
    new LokaReservationUpdateStatusTool()
  ]
}