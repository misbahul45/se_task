# 🤖 WA Agent — Loka Coffee & Eatery Bot

> WhatsApp reservation assistant built with Baileys + LangChain + FAISS memory.

Bot WhatsApp otomatis untuk menangani **reservasi ruang**, **informasi paket**, **pengingat jadwal**, dan **komunikasi admin** di **Loka Coffee & Eatery**. Menggunakan agen ReAct (Reasoning + Acting) berbasis LLM dengan memori jangka pendek dan panjang per pelanggan.

---

## ✨ Fitur

| Fitur | Deskripsi |
|-------|-----------|
| **📅 Reservasi** | Panduan booking langkah demi langkah → nama, tanggal, jam, jumlah tamu, area, add-on |
| **💾 Memori Cerdas** | Short-term memory (riwayat chat) + Long-term memory (FAISS vector search) per session |
| **💳 Pembayaran** | Kirim instruksi transfer (BCA/BRI) + notifikasi admin saat bukti diterima |
| **👥 Konfirmasi Grup** | Notifikasi reservasi baru ke grup internal |
| **⏰ Reminder Otomatis** | Cron setiap 30 menit — kirim pengingat ke grup + customer H-5 jam |
| **🔗 Hubungi Admin** | Forward pesan customer ke admin WhatsApp |
| **🧠 ReAct Agent** | Agent bisa panggil tools: `loka_reservation_create`, `search_memory`, dll |
| **📱 Menu Interaktif** | Menu 1=Reservasi, 2=Info & FAQ, 3=Hubungi Admin |

---

## 🏗️ Arsitektur

```
wa-agent/
├── main.js                     ← Entry point — WhatsApp socket + message routing
├── agent/
│   ├── ai.js                   ← Factory agent (LLM, tools, memory)
│   ├── workflow.js             ← ReAct loop engine (max 6 iterasi)
│   ├── prompts.js              ← Builder system prompt + schema tools
│   ├── system-prompt.md        ← Knowledge base + aturan (Bahasa Indonesia)
│   ├── sheet.js                ← Tools: CRUD reservasi via Google Sheets API
│   ├── memory-manager.js       ← Short-term (JSON) + Long-term (FAISS) memory
│   ├── memory-tools.js         ← Tools: save/search/forget/clear memory
│   ├── cron-reminder.js        ← Cron reminder otomatis tiap 30 menit
│   └── xenova-embeddings.js    ← Local embeddings (all-MiniLM-L6-v2)
├── auth_info/                  ← Auth WhatsApp (auto-generated)
├── memory-store/               ← Data runtime:
│   ├── short-term/             ←   Riwayat chat per session (JSON)
│   ├── long-term/              ←   Vector store FAISS per session
│   └── reminder-state.json     ←   State pengingat (cegah duplikat)
├── test.js                     ← Test Google Sheets API
├── test-agent-init.js          ← Test inisialisasi agent
├── package.json
├── .env                        ← Config: API key, model, base URL
└── .gitignore
```

---

## 🧠 Alur Kerja

### 1. Pesan Masuk
```
User WA → main.js → Cek state (menu/payment/admin/agent)
```

### 2. State Machine
| State | Aksi |
|-------|------|
| Baru pertama chat | Kirim **menu utama** (1/2/3) |
| Pilih **1** (Reservasi) | Context prompt → Agent mulai booking flow |
| Pilih **2** (Info & FAQ) | Context prompt → Agent jawab informasi |
| Pilih **3** (Hubungi Admin) | Forward pesan ke admin |
| `awaiting_payment_proof` | User kirim bukti → notifikasi admin |
| `relaying_to_admin` | Pesan diferuskan ke admin JID |
| Lainnya | **Free chat** → Agent dengan semua tools |

### 3. ReAct Agent Loop
```
Input → (system prompt + chat history + user input)
     → LLM → output mengandung TOOL_CALL?
         → Ya → parse → run tool → TOOL_RESULT → loop (max 6x)
         → Tidak → final output ke user
```
Tools yang tersedia:
- **Reservasi:** `loka_reservation_list`, `loka_reservation_detail`, `loka_reservation_create`, `loka_reservation_info`
- **Memory:** `save_memory`, `search_memory`, `forget_memory`, `get_all_memories`, `memory_stats`, `clear_all_memories`

### 4. Post-Reservation
Setelah `loka_reservation_create` sukses:
1. Kirim konfirmasi ke grup internal
2. Kirim instruksi pembayaran (deposit 50%) ke customer
3. Notifikasi admin untuk verifikasi
4. Set state `awaiting_payment_proof`

### 5. Reminder Otomatis
Cron tiap 30 menit → fetch semua reservasi dari API → parse datetime → jika event < 5 jam lagi → kirim reminder ke grup + customer → update state.

---

## 💾 Sistem Memori

### Short-Term Memory
- Riwayat chat per session ID (file JSON di `memory-store/short-term/`)
- Maks 50 pesan terakhir
- Disimpan otomatis setiap kali agent merespon

### Long-Term Memory
- **FAISS vector store** per session (`memory-store/long-term/`)
- **Embeddings lokal** via `@xenova/transformers` (all-MiniLM-L6-v2)
- Auto-extract memori penting (nama, preferensi, dll)
- Pencarian similarity (`search_memory`) untuk recall konteks sesi sebelumnya

---

## 🔗 External APIs

| API | URL | Kegunaan |
|-----|-----|----------|
| **Flaz ID** (OpenAI-compatible) | `https://ai.flaz.id/v1` | LLM provider (MiniMax-M2.7-highspeed) |
| **Google Apps Script** | `https://script.google.com/macros/s/.../exec` | Backend CRUD reservasi (Google Sheets) |

---

## 🚀 Cara Menjalankan

### Prasyarat
- Node.js >= 18
- pnpm

### Instalasi

```bash
# Clone repo
git clone <repo-url>
cd wa-agent

# Install dependencies
pnpm install

# Build native modules (faiss-node, sharp, dll)
pnpm rebuild
```

### Konfigurasi

Buat file `.env` (sudah tersedia untuk development):

```env
FLAZ_BASE_URL=https://ai.flaz.id/v1
FLAZ_API_KEY=sk-xxx
LLM_MODEL=MiniMax-M2.7-highspeed
```

### Menjalankan

```bash
# Mode development
pnpm dev

# Atau langsung
node main.js
```

**Pertama kali**: scan QR code yang muncul di terminal dengan WhatsApp.

### Testing

```bash
# Test Google Sheets API
node test.js

# Test inisialisasi agent
node test-agent-init.js

# Test reminder standalone
node agent/cron-reminder.js
```

---

## ⚙️ Konfigurasi Penting

### main.js
| Variabel | Nilai | Keterangan |
|----------|-------|------------|
| `GROUP_CONFIRMATION_JID` | `120363406492419821@g.us` | Grup notifikasi |
| `PAYMENT_VERIFICATION_JID` | `6285150738708@s.whatsapp.net` | Admin verifikasi pembayaran |
| `ADMIN_JID` | `6285649204151@s.whatsapp.net` | Admin utama |
| `MAX_RECONNECT_ATTEMPTS` | `5` | Maks reconnect WhatsApp |
| `MAX_ITERATIONS` (workflow.js) | `6` | Maks loop ReAct |

### system-prompt.md
Berisi knowledge base lengkap: paket harga, ketentuan, alur booking, format chat WhatsApp, aturan penggunaan tools.

### cron-reminder.js
| Variabel | Nilai |
|----------|-------|
| `REMINDER_HOURS_BEFORE` | `5` jam |
| `DEFAULT_INTERVAL_MINUTES` | `30` menit |

---

## 📦 Teknologi

| Teknologi | Versi | Fungsi |
|-----------|-------|--------|
| **Baileys** | `7.0.0-rc11` | WhatsApp Web API (multi-device) |
| **LangChain** | `^0.2.x` | Agent framework (ReAct, tools, memory) |
| **ChatOpenAI** | `0.2.11` | OpenAI-compatible LLM client |
| **FAISS** (faiss-node) | `^0.5.1` | Vector similarity search |
| **Xenova Transformers** | `^2.17.2` | Local embeddings (ONNX runtime) |
| **Zod** | `^3.23.8` | Schema validation tools |
| **Pino** | `^9.0.0` | Logger (silent for Baileys) |
| **QR Code** | `^1.5.4` | QR login display |

---

## 📝 Catatan Penting

- **Cancel/Reschedule** tidak memiliki tool — hubungi admin langsung
- **Reschedule** maks H-1, **pembatalan** deposit hangus
- **Format pesan WA**: bold dengan `*teks*`, maks 3-4 kalimat/pesan, satu topik/pesan
- **Auto-reconnect** jika koneksi WhatsApp putus (max 5 kali, exponential backoff)
- **Duplikasi reminder dicegah** via `reminder-state.json` dan kolom `reminder_status` di Google Sheets

---

## 📄 Lisensi

Proprietary — Internal use Loka Coffee & Eatery.
