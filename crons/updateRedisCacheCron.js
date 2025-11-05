const cron = require('node-cron');
const { getRedis } = require('../redisClient');
require('dotenv').config();

let redis;

/** Starts the cron */
async function startUpdateRedisCacheCron() {
  if (!redis) redis = await getRedis();

  cron.schedule('0 0 * * *', async () => {
  // cron.schedule('* * * * *', async () => {
    console.log('🌙 Running at midnight…');
    try {
      const res = await fetch(process.env.PORTAL_BASE_URL + '/update-redis-cache', {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${encryptedKey()}`
        }
      });

      if (!res.ok) {
        console.log('❌ Failed to fetch school configs');
        return;
      }

      console.log(`✅ Cache updated successfully!`);
    } catch (err) {
      console.error('❌ Sync failed:', err.message);
    }
  });
}

async function encryptedKey() {
  return 'test'; 
}

module.exports = { startUpdateRedisCacheCron };