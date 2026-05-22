import { Tool } from '@langchain/core/tools'
import { z } from 'zod'

const TIMEZONE = 'Asia/Jakarta'

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
]

export class GetDateTimeTool extends Tool {
  constructor() {
    super()
    this.name = 'get_datetime'
    this.description = `
Gunakan tool ini untuk mengetahui waktu dan tanggal saat ini (WIB/Jakarta).
Gunakan sebelum membuat reservasi atau saat user bertanya tentang hari/tanggal/jam sekarang.
Tidak memerlukan input apapun.
`.trim()
    this.schema = z.object({})
  }

  async _call() {
    const now = new Date()

    // Format ke timezone WIB
    const formatter = new Intl.DateTimeFormat('id-ID', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'long'
    })

    const parts = formatter.formatToParts(now)
    const get = (type) => parts.find(p => p.type === type)?.value ?? ''

    const year = get('year')
    const month = get('month')
    const day = get('day')
    const hour = get('hour')
    const minute = get('minute')
    const second = get('second')

    // Tanggal ISO untuk dipakai di tool lain (YYYY-MM-DD)
    const isoDate = `${year}-${month}-${day}`
    const timeStr = `${hour}:${minute}`

    // Nama hari & bulan dalam bahasa Indonesia
    const jsDate = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }))
    const namaHari = HARI[jsDate.getDay()]
    const namaBulan = BULAN[jsDate.getMonth()]
    const tanggalLengkap = `${namaHari}, ${parseInt(day)} ${namaBulan} ${year}`

    // Hitung besok
    const tomorrow = new Date(jsDate)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const isoTomorrow = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    return JSON.stringify({
      success: true,
      sekarang: {
        tanggal_lengkap: tanggalLengkap,
        tanggal_iso: isoDate,       // format YYYY-MM-DD, gunakan ini untuk reservasi
        jam: timeStr,               // format HH:mm WIB
        jam_lengkap: `${hour}:${minute}:${second} WIB`,
        hari: namaHari,
        tanggal: parseInt(day),
        bulan: namaBulan,
        bulan_angka: parseInt(month),
        tahun: parseInt(year),
        besok_iso: isoTomorrow
      }
    })
  }
}

export function createDateTimeTools() {
  return [new GetDateTimeTool()]
}
