const Redis = require("ioredis");

let client = null;

function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      lazyConnect: false,
      enableReadyCheck: false,
    });
    client.on("error", (e) => console.error("[redis]", e.message));
  }
  return client;
}

async function publish(channel, payloadObj) {
  try {
    await getRedis()?.publish(channel, JSON.stringify(payloadObj));
  } catch (e) {
    /* non-fatal */
  }
}

module.exports = { publish };
