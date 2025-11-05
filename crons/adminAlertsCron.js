const cron = require('node-cron');
require('dotenv').config();

/** Starts the cron */
async function startAdminAlertsCron() {

  cron.schedule('0,30 * * * *', async () => {
  // cron.schedule('* * * * *', async () => {
    console.log('⏰ Running admin alerts cron…');
    try {
        console.log(process.env.PORTAL_BASE_URL + '/admin-alerts/send-alerts');
      const res = await fetch(process.env.PORTAL_BASE_URL + '/admin-alerts/send-alerts', {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${encryptedKey()}`
        }
      });

      if (!res.ok) {
        console.log('❌ Admin alerts cron failed');
        return;
      }

      console.log(`✅ Alerts sent successfully!`);
    } catch (err) {
      console.error('❌ Admin alerts call failed:', err.message);
    }
  });
}

async function encryptedKey() {
  return 'test'; 
}

module.exports = { startAdminAlertsCron };