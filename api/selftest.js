/*
  Health check for the leaderboard database.
  GET /api/selftest -> { write: true/false, savedResults: n } or an error message.
*/
const { createClient } = require("redis");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.REDIS_URL) {
    return res.status(500).json({ ok: false, error: "REDIS_URL is not set" });
  }
  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", function () {});
  try {
    await client.connect();
    await client.set("quiz:selftest", "ok", { EX: 30 });
    const back = await client.get("quiz:selftest");
    await client.del("quiz:selftest");
    const saved = await client.zCard("quiz:board");
    await client.quit();
    return res.status(200).json({ ok: true, write: back === "ok", savedResults: saved });
  } catch (e) {
    try { await client.quit(); } catch (x) {}
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
};
