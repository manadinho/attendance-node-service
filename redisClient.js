// redisClient.js
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://192.168.1.14:6379';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let clientPromise; // ensure we only spin up once even under contention

async function buildClient() {
  const client = createClient({
    url: REDIS_URL,
    socket: {
      keepAlive: 10_000,
      reconnectStrategy: (retries) => Math.min(1000 * retries, 5000), // cap retry delay
    },
  });
  let connectedOnce = false;

  client.on('error', (err) => {
    if (!connectedOnce && err?.code === 'ECONNRESET') {
      console.warn('⚠️ Redis connection reset during initial handshake, retrying automatically…');
      return;
    }
    console.error('Redis error:', err);
  });

  client.on('end', () => {
    console.warn('⚠️ Redis connection closed, it will reconnect on next request');
    clientPromise = null;
  });

  client.on('reconnecting', (delay) => {
    console.warn(`🔄 Redis reconnecting in ${delay}ms...`);
  });

  const connectWithRetry = async (attempt = 1) => {
    try {
      await client.connect();
      connectedOnce = true;
      console.log('✅ Redis connected:', REDIS_URL);
    } catch (err) {
      const maxAttempts = 5;
      if (attempt >= maxAttempts) {
        console.error('❌ Redis failed to connect after retries');
        throw err;
      }
      const delay = Math.min(attempt * 1000, 5000);
      console.warn(`⚠️ Redis connect attempt ${attempt} failed (${err.code || err.message}); retrying in ${delay}ms`);
      await sleep(delay);
      return connectWithRetry(attempt + 1);
    }
  };

  await connectWithRetry();

  // graceful shutdown (once)
  const shutdown = async () => {
    try { await client.quit(); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return client;
}

async function getRedis() {
  if (!clientPromise) {
    clientPromise = buildClient();
  }
  return clientPromise;
}

module.exports = { getRedis };
