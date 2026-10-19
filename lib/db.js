/*
  Shared Redis connection + key names for the quiz APIs.

  Data in Redis (REDIS_URL):
    quiz:entries   hash        game id -> JSON game record (name, avatar, mode, answers, score, points…)
    quiz:board     sorted set  Challenge games only, score = points        (public leaderboard)
    quiz:games     sorted set  every game (both modes), score = start time (teacher dashboard)
*/

const { createClient } = require("redis");

const KEYS = {
  ENTRIES: "quiz:entries",
  BOARD: "quiz:board",
  GAMES: "quiz:games"
};

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", function () {});
    clientPromise = client.connect().then(function () { return client; });
    clientPromise.catch(function () { clientPromise = null; });
  }
  return clientPromise;
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
}

// Returns true if this IP is over `limit` requests per minute for `bucket`
async function overLimit(redis, bucket, req, limit) {
  const key = "quiz:rl:" + bucket + ":" + clientIp(req);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count > limit;
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === "object" && !Buffer.isBuffer(b)) return Promise.resolve(b);
  if (typeof b === "string" || Buffer.isBuffer(b)) {
    try { return Promise.resolve(JSON.parse(String(b) || "{}")); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise(function (resolve) {
    let data = "";
    req.on("data", function (chunk) {
      data += chunk;
      if (data.length > 20000) req.destroy();
    });
    req.on("end", function () {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); }
    });
  });
}

module.exports = { KEYS, getClient, overLimit, readBody };
