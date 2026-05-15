const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "bot-session" // nama session
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});


client.on('qr', (qr) => {
  console.log("Scan QR ini di WhatsApp:");
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp Client is ready!');
});


client.on('message', async (msg) => {

  console.log(`📩 ${msg.from}: ${msg.body}`);
  console.log(msg)

  // command sederhana
  if (msg.body === '!ping') {
    msg.reply('pong 🏓');
  }

});

client.on('auth_failure', msg => {
  console.error('❌ Auth failure:', msg);
});

client.on('disconnected', reason => {
  console.log('⚠️ Client disconnected:', reason);
});

client.initialize();