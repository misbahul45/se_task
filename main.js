import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from 'baileys'
import P from 'pino'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: true
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('Scan QR berikut:\n')

      const qrDataUrl = await qrcode.toDataURL(qr)

      console.log(qr)
      console.log('\nBuka ini di browser:')
      console.log(qrDataUrl)
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected')

      await sock.sendMessage('6285856264665@s.whatsapp.net', {
        text: 'Halo dari Baileys 🚀'
      })
    }

    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut

      console.log('❌ Connection closed')

      if (shouldReconnect) {
        startSock()
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const msg = messages[0]

    if (!msg.message) return
    if (msg.key.fromMe) return

    const jid = msg.key.remoteJid
    const isGroup = jid.endsWith('@g.us')

    const sender =
      isGroup
        ? msg.key.participant
        : msg.key.remoteJid

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      ''

    if (!text) return

    console.log('\n====================')

    if (isGroup) {
      console.log('📦 GROUP MESSAGE')
      console.log('Group:', jid)
      console.log('Sender:', sender)
      console.log('Text:', text)
    } else {
      console.log('💬 PRIVATE MESSAGE')
      console.log('Sender:', sender)
      console.log('Text:', text)
    }

    console.log('====================\n')

    // AUTO REPLY PRIVATE CHAT
    if (!isGroup) {
      await sock.sendMessage(jid, {
        text: `Kamu bilang: ${text}`
      })
    }

    // AUTO REPLY GROUP
    if (isGroup && text.toLowerCase() === 'ping') {
      await sock.sendMessage(jid, {
        text: 'pong 🏓'
      })
    }
  })

  return sock
}

startSock()