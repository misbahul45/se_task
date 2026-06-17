# WA Agent - Loka Coffee & Eatery Bot

Bot WhatsApp untuk membantu operasional reservasi ruang di Loka Coffee & Eatery. Project ini menggabungkan Baileys untuk koneksi WhatsApp, LangChain untuk agent ReAct, Google Apps Script/Google Sheets sebagai backend reservasi, FAISS sebagai vector memory, dan model LLM OpenAI-compatible melalui Flaz ID.

## Daftar Isi

- [Fitur Utama](#fitur-utama)
- [Teknologi](#teknologi)
- [Struktur Project](#struktur-project)
- [Cara Kerja Singkat](#cara-kerja-singkat)
- [Prasyarat](#prasyarat)
- [Instalasi](#instalasi)
- [Konfigurasi Environment](#konfigurasi-environment)
- [Menjalankan Bot](#menjalankan-bot)
- [Script NPM](#script-npm)
- [Alur Percakapan Private Chat](#alur-percakapan-private-chat)
- [Alur Grup Internal](#alur-grup-internal)
- [Tools Agent](#tools-agent)
- [Sistem Memori](#sistem-memori)
- [Reminder Otomatis](#reminder-otomatis)
- [Integrasi API Reservasi](#integrasi-api-reservasi)
- [File Runtime](#file-runtime)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Keamanan](#keamanan)
- [Catatan Operasional](#catatan-operasional)

## Fitur Utama

- Reservasi ruang lewat WhatsApp private chat.
- Menu awal: reservasi ruang, info/FAQ, dan hubungi admin.
- Agent ReAct yang dapat memanggil tool reservasi, tool tanggal/waktu, dan tool memori.
- Integrasi Google Apps Script untuk list, detail, create, dan update status reservasi.
- Notifikasi reservasi baru ke grup internal.
- Instruksi pembayaran deposit otomatis ke customer.
- Notifikasi admin saat reservasi baru perlu diverifikasi.
- Penerimaan bukti pembayaran berupa gambar saat user berada di state menunggu bukti transfer.
- Agent khusus grup internal untuk cek daftar reservasi dan update status melalui mention/reply.
- Reminder otomatis H-5 jam ke grup dan customer.
- Short-term memory berbasis JSON dan long-term memory berbasis FAISS per session WhatsApp.
- Auto reconnect WhatsApp dengan batas percobaan.

## Teknologi

| Komponen | Library/Runtime | Fungsi |
| --- | --- | --- |
| Runtime | Node.js ESM | Menjalankan aplikasi bot |
| Package manager | pnpm | Instalasi dependency |
| WhatsApp client | `baileys` | WhatsApp Web multi-device socket |
| LLM client | `@langchain/openai` | Client OpenAI-compatible untuk Flaz ID |
| Agent | LangChain + custom ReAct loop | Reasoning dan tool calling |
| Schema tool | `zod` | Validasi input tool |
| Vector store | `faiss-node` | Long-term memory similarity search |
| Embedding lokal | `@xenova/transformers` | Embedding `Xenova/all-MiniLM-L6-v2` |
| Logger | `pino` | Logger Baileys |
| QR | `qrcode`, `qrcode-terminal` | QR login WhatsApp |
| Env loader | `dotenv` | Membaca konfigurasi `.env` |

## Struktur Project

```text
.
├── main.js                         # Entry point WhatsApp socket, routing pesan, state user
├── test.js                         # Script test Google Apps Script API
├── package.json                    # Metadata, scripts, dependencies
├── pnpm-workspace.yaml             # Konfigurasi pnpm build dependencies
├── pnpm-lock.yaml                  # Lockfile dependency
├── .env.example                    # Contoh konfigurasi environment
├── agent/
│   ├── ai.js                       # Factory private agent dan processMessage
│   ├── group-agent.js              # Agent khusus grup internal
│   ├── workflow.js                 # Custom ReAct loop dan eksekusi tool
│   ├── prompts.js                  # Builder prompt dan deskripsi tool
│   ├── system-prompt.md            # Knowledge base dan SOP respons bot
│   ├── sheet.js                    # Tool reservasi via Google Apps Script
│   ├── datetime-tool.js            # Tool tanggal/waktu WIB
│   ├── memory-manager.js           # Short-term dan long-term memory manager
│   ├── memory-tools.js             # Tool save/search/forget memory
│   ├── xenova-embeddings.js        # Adapter embeddings lokal Xenova
│   └── cron-reminder.js            # Reminder reservasi otomatis
├── auth_info/                      # Kredensial login WhatsApp, dibuat otomatis
└── memory-store/                   # Data runtime memori dan reminder, dibuat otomatis
    ├── short-term/
    ├── long-term/
    └── reminder-state.json
```

Folder `auth_info/`, `memory-store/`, dan `node_modules/` adalah data lokal/runtime dan tidak seharusnya masuk git.

## Cara Kerja Singkat

```text
Pesan WhatsApp masuk
  -> main.js membaca tipe chat dan konten pesan
  -> private chat diproses oleh state machine user
  -> pesan diteruskan ke private agent jika perlu jawaban AI/tool
  -> agent menjalankan ReAct loop
  -> tool dipanggil jika model mengeluarkan TOOL_CALL
  -> hasil akhir dibersihkan dari format internal
  -> bot mengirim balasan ke WhatsApp
```

Untuk grup internal, bot hanya merespons jika pesan berada di grup konfirmasi dan memenuhi salah satu trigger:

- mention akun bot;
- teks mengandung `@loka`;
- pesan adalah reply ke pesan bot.

## Prasyarat

- Node.js 18 atau lebih baru.
- pnpm.
- Nomor WhatsApp yang akan dipakai sebagai bot.
- API key Flaz ID atau provider LLM OpenAI-compatible.
- Akses ke Google Apps Script API reservasi yang dipakai di `agent/sheet.js`, `agent/cron-reminder.js`, dan `test.js`.
- Environment yang mendukung native build dependency untuk `faiss-node`.

## Instalasi

```bash
pnpm install
```

Jika dependency native perlu dibangun ulang:

```bash
pnpm rebuild
```

`pnpm-workspace.yaml` sudah mengizinkan build untuk dependency berikut:

- `baileys`
- `faiss-node`
- `protobufjs`
- `sharp`

## Konfigurasi Environment

Buat file `.env` di root project:

```env
FLAZ_BASE_URL=https://ai.flaz.id/v1
FLAZ_API_KEY=sk-isi-api-key-anda
LLM_MODEL=MiniMax-M2.7-highspeed
```

| Variable | Wajib | Default di kode | Keterangan |
| --- | --- | --- | --- |
| `FLAZ_BASE_URL` | Tidak | `https://ai.flaz.id/v1` | Base URL provider LLM OpenAI-compatible |
| `FLAZ_API_KEY` | Ya | Tidak ada | API key untuk LLM |
| `LLM_MODEL` | Tidak | `MiniMax-M2.7-highspeed` | Nama model yang dipakai private dan group agent |

Pastikan `.env` tidak dikomit. File `.gitignore` sudah mengecualikan `.env`.

## Menjalankan Bot

```bash
pnpm dev
```

Atau:

```bash
pnpm start
```

Saat pertama kali berjalan, bot akan menampilkan QR code di terminal. Scan QR tersebut menggunakan WhatsApp pada nomor yang akan dijadikan bot.

Setelah koneksi terbuka:

- agent private diinisialisasi;
- agent grup diinisialisasi;
- socket WhatsApp disimpan untuk cron reminder;
- reminder cron berjalan setiap 30 menit;
- admin menerima pesan bahwa bot online.

## Script NPM

| Script | Perintah | Keterangan |
| --- | --- | --- |
| `dev` | `node main.js` | Menjalankan bot untuk development |
| `start` | `node main.js` | Menjalankan bot |
| `build` | `echo 'Build completed'` | Placeholder build script |

## Alur Percakapan Private Chat

### Menu awal

Jika user pertama kali mengirim pesan, bot mengecek memori lama melalui `search_memory`. Jika tidak ada memori relevan, bot menampilkan menu:

```text
1. Reservasi Ruang
2. Info & FAQ
3. Hubungi Admin
```

User dapat mengetik `MENU`, `BACK`, atau `MULAI` untuk kembali ke menu utama.

### Pilihan 1: Reservasi Ruang

Bot meneruskan konteks reservasi ke agent. Agent akan mengumpulkan data secara bertahap:

- nama;
- nomor WhatsApp;
- tanggal reservasi;
- jam;
- jumlah tamu;
- area;
- room charge jika diperlukan;
- extra hour jika diperlukan;
- catatan tambahan.

Jika data sudah dikonfirmasi, agent memanggil `loka_reservation_create`. Setelah reservasi berhasil dibuat, sistem menjalankan post-reservation flow:

1. Mengirim detail reservasi ke grup internal.
2. Mengirim instruksi pembayaran deposit ke customer.
3. Mengirim notifikasi ke admin untuk verifikasi.
4. Mengubah state customer menjadi `awaiting_payment_proof`.

### Pilihan 2: Info & FAQ

Bot menjawab pertanyaan tentang paket, harga, fasilitas, aturan reservasi, pembayaran, atau informasi lain berdasarkan `agent/system-prompt.md` dan tool yang tersedia.

### Pilihan 3: Hubungi Admin

Bot memberikan kontak admin dan dapat meneruskan pesan customer ke admin. Jika output agent mengarah ke admin, state user dapat berubah menjadi `relaying_to_admin`.

### Bukti pembayaran

Jika user berada pada state `awaiting_payment_proof`:

- pesan teks seperti "sudah transfer" akan dibalas dengan permintaan mengirim foto bukti transfer;
- gambar tanpa caption akan dianggap sebagai bukti transfer;
- bot memberi tahu customer bahwa bukti diterima;
- admin dinotifikasi untuk verifikasi.

## Alur Grup Internal

Bot hanya membaca grup dengan JID:

```text
120363406492419821@g.us
```

Di grup ini, bot dapat membantu staff untuk:

- melihat reservasi hari ini;
- melihat reservasi besok;
- melihat reservasi minggu ini;
- mencari reservasi berdasarkan nama;
- memfilter berdasarkan area;
- melihat reservasi mendatang;
- update status reservasi jika ID jelas.

Agent grup dibatasi hanya memakai tool berikut:

- `get_datetime`
- `loka_reservation_list`
- `loka_reservation_detail`
- `loka_reservation_update_status`

Agent grup tidak boleh membuat reservasi baru.

## Tools Agent

### Date/time

| Tool | Fungsi |
| --- | --- |
| `get_datetime` | Mengambil tanggal dan waktu sekarang dalam timezone Asia/Jakarta, termasuk `tanggal_iso` dan `besok_iso` |

### Reservasi

| Tool | Fungsi |
| --- | --- |
| `loka_reservation_info` | Debug/info API |
| `loka_reservation_list` | Mengambil daftar reservasi dengan filter tanggal, rentang tanggal, status, area, atau nama |
| `loka_reservation_detail` | Mengambil detail reservasi berdasarkan ID |
| `loka_reservation_create` | Membuat reservasi baru |
| `loka_reservation_update_status` | Mengubah status reservasi menjadi `PENDING`, `CONFIRMED`, `CANCELLED`, atau `DONE` |

### Memori

| Tool | Fungsi |
| --- | --- |
| `save_memory` | Menyimpan informasi penting user ke long-term memory |
| `search_memory` | Mencari memori relevan berdasarkan query |
| `forget_memory` | Menghapus memori tertentu berdasarkan query |
| `get_all_memories` | Melihat semua memori untuk session tertentu |
| `memory_stats` | Melihat statistik short-term dan long-term memory |
| `clear_all_memories` | Menghapus semua long-term memory session tertentu |

## Sistem Memori

Project menggunakan dua lapis memori per session WhatsApp.

### Short-term memory

- Disimpan sebagai JSON di `memory-store/short-term/`.
- Maksimal 50 pesan terakhir per session.
- Dipakai untuk menjaga konteks percakapan berjalan.

### Long-term memory

- Disimpan sebagai FAISS vector store di `memory-store/long-term/`.
- Menggunakan embedding lokal `Xenova/all-MiniLM-L6-v2`.
- Dipakai untuk mengingat preferensi, nama, atau informasi penting customer.
- Agent dapat mencari ulang memori lama melalui `search_memory`.

## Reminder Otomatis

`agent/cron-reminder.js` menjalankan pengecekan reservasi berkala.

| Konfigurasi | Nilai |
| --- | --- |
| Interval default | 30 menit |
| Reminder dikirim | 5 jam sebelum acara |
| Timezone | Asia/Jakarta/WIB |
| State lokal | `memory-store/reminder-state.json` |

Alur reminder:

1. Ambil daftar reservasi dari Google Apps Script.
2. Lewati reservasi `CANCELLED`.
3. Lewati reservasi yang sudah memiliki `reminder_status` terkirim.
4. Parse tanggal dan jam reservasi.
5. Jika waktu acara berada dalam window H-5 jam, kirim reminder ke grup dan customer.
6. Simpan state lokal dan update status reminder di sheet.

## Integrasi API Reservasi

Project memakai Google Apps Script sebagai API backend reservasi. URL API saat ini masih hardcoded di beberapa file:

- `agent/sheet.js`
- `agent/cron-reminder.js`
- `test.js`

Endpoint digunakan dengan pola berikut:

### List reservasi

```text
GET <API_URL>?action=list
GET <API_URL>?action=list&tanggal=YYYY-MM-DD
GET <API_URL>?action=list&tanggal_dari=YYYY-MM-DD&tanggal_sampai=YYYY-MM-DD
GET <API_URL>?action=list&status=PENDING
GET <API_URL>?action=list&area=Indoor
GET <API_URL>?action=list&nama=Budi
```

### Detail reservasi

```text
GET <API_URL>?action=detail&id=<reservation-id>
```

### Create reservasi

```json
{
  "nama": "Budi Santoso",
  "whatsapp": "081234567890",
  "tanggal": "2026-05-10",
  "jam": "14:00",
  "jumlah_orang": 10,
  "area": "Indoor",
  "room_charge": false,
  "extra_hour": 0,
  "catatan": ""
}
```

### Update status

```json
{
  "action": "update_status",
  "id": "<reservation-id>",
  "status": "CONFIRMED"
}
```

### Mark reminder sent

```json
{
  "action": "mark_reminder_sent",
  "id": "<reservation-id>"
}
```

## File Runtime

| Path | Fungsi | Aman dihapus? |
| --- | --- | --- |
| `auth_info/` | Kredensial session WhatsApp | Ya, tetapi bot harus scan QR ulang |
| `memory-store/short-term/` | Riwayat chat pendek | Ya, konteks chat hilang |
| `memory-store/long-term/` | Vector memory FAISS | Ya, memori customer hilang |
| `memory-store/reminder-state.json` | State reminder terkirim | Hati-hati, dapat memicu reminder duplikat |
| `node_modules/` | Dependency | Ya, install ulang dengan `pnpm install` |

## Testing

### Test API reservasi

```bash
node test.js
```

Script ini akan:

- mengambil info API;
- mengambil daftar reservasi;
- mengambil detail reservasi pertama jika ada;
- membuat data reservasi test;
- mengambil detail data test yang baru dibuat.

Perhatian: `node test.js` dapat membuat data reservasi baru di backend yang dikonfigurasi.

### Test bot manual

1. Jalankan `pnpm dev`.
2. Scan QR WhatsApp jika belum login.
3. Kirim pesan private ke nomor bot.
4. Coba ketik `MENU`.
5. Coba pilih `1`, `2`, atau `3`.
6. Untuk grup, mention bot atau kirim pesan dengan `@loka` di grup internal.

## Troubleshooting

### QR muncul terus atau login gagal

Hapus session WhatsApp lalu jalankan ulang:

```bash
rm -rf auth_info
pnpm dev
```

Lalu scan QR baru.

### Bot logged out

Jika log menampilkan status logged out, session tidak bisa dipakai lagi. Hapus `auth_info/` dan login ulang.

### Agent gagal inisialisasi

Periksa:

- `.env` sudah ada;
- `FLAZ_API_KEY` valid;
- `FLAZ_BASE_URL` benar;
- model pada `LLM_MODEL` tersedia di provider;
- koneksi internet server aktif.

### Error native dependency FAISS

Coba jalankan:

```bash
pnpm rebuild
```

Jika masih gagal, pastikan versi Node.js dan toolchain build native module sesuai untuk environment.

### Reminder tidak terkirim

Periksa:

- bot sudah connected;
- `setWhatsAppSocket(sock)` berhasil dipanggil setelah socket open;
- cron berjalan setelah agent init;
- data reservasi memiliki `tanggal`, `jam`, `id`, dan `whatsapp`;
- reservasi belum berstatus `CANCELLED`;
- `reminder_status` belum `SENT`;
- `memory-store/reminder-state.json` tidak menandai ID tersebut sebagai sudah terkirim.

### Bot tidak membalas di grup

Pastikan:

- pesan dikirim di grup JID yang sama dengan `GROUP_CONFIRMATION_JID`;
- bot dimention, pesan mengandung `@loka`, atau pesan adalah reply ke pesan bot;
- pesan memiliki teks/caption yang bisa dibaca.

### Data reservasi tidak sesuai

Periksa Google Apps Script API yang dipakai di:

- `agent/sheet.js`
- `agent/cron-reminder.js`
- `test.js`

Saat ini URL API tersebar di beberapa file, jadi perubahan endpoint perlu disamakan manual.

## Keamanan

- Jangan commit file `.env`.
- Jangan commit `auth_info/` karena berisi kredensial session WhatsApp.
- Jangan commit `memory-store/` karena dapat berisi riwayat chat dan data customer.
- Jangan menaruh API key asli di `.env.example`.
- Rotasi API key jika pernah tidak sengaja tersimpan di repo atau file contoh.
- Nomor admin, JID grup, dan URL Google Apps Script masih hardcoded di kode. Untuk production yang lebih rapi, pindahkan nilai tersebut ke environment variable.

## Catatan Operasional

- Bot menggunakan timezone `Asia/Jakarta`.
- Format tanggal tool reservasi adalah `YYYY-MM-DD`.
- Format jam tool reservasi adalah `HH:mm` atau `HH.mm`.
- Nomor WhatsApp customer dinormalisasi menjadi format lokal `08xxx` saat create reservasi.
- Deposit yang dikirim ke customer mengikuti data finansial dari response API.
- Jika `loka_reservation_create` sukses tetapi response API tidak mengembalikan ID atau data finansial, post-reservation flow akan dilewati.
- Pembatalan dan reschedule belum memiliki tool khusus di private agent. Arahkan customer ke admin jika kasus tersebut muncul.

## Lisensi

Proprietary. Digunakan untuk kebutuhan internal Loka Coffee & Eatery.
