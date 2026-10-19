/*
  Shared leaderboard API for the Online Awareness Quiz.

  GET  /api/leaderboard          -> top 10 players
  POST /api/leaderboard          -> save a finished game, returns top 10 + your rank

  Data lives in the Redis database connected to this Vercel project (REDIS_URL):
    quiz:board      sorted set   member = entry id, score = points
    quiz:entries    hash         entry id -> JSON { name, points, score, total, avatar, at }
*/

const { createClient } = require("redis");

const BOARD_KEY = "quiz:board";
const ENTRIES_KEY = "quiz:entries";
const KEEP = 100;          // only the best 100 results are stored
const TOP = 10;            // how many are shown
const MAX_POINTS_PER_QUESTION = 1000;
const MAX_QUESTIONS = 50;

// Values the avatar builder can produce. Anything else is rejected.
const AVATAR_STYLES = {
  hair: ["short", "spiky", "long", "bun", "curly", "none"],
  shirt: ["tee", "hoodie", "stripes", "jersey"],
  legs: ["jeans", "joggers", "shorts", "skirt"],
  shoes: ["sneakers", "hightops", "boots", "sandals"]
};
const AVATAR_COLOURS = ["skin", "hairColor", "shirtColor", "legColor", "shoeColor"];
const HEX = /^#[0-9a-fA-F]{6}$/;

// Basic word filter for display names
const BLOCKED = [
  "fuck", "shit", "bitch", "cunt", "dick", "pussy", "nigg", "fag", "slut", "whore",
  "bastard", "asshole", "porn", "sex", "rape", "nazi", "kill", "pukimak", "babi", "bodoh", "sial", "lancau"
];

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

function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001F\u007F<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
  if (!name) return null;
  const squashed = name.toLowerCase().replace(/[^a-z]/g, "");
  if (BLOCKED.some(function (w) { return squashed.includes(w); })) return null;
  return name;
}

function cleanAvatar(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const key of Object.keys(AVATAR_STYLES)) {
    if (!AVATAR_STYLES[key].includes(raw[key])) return null;
    out[key] = raw[key];
  }
  for (const key of AVATAR_COLOURS) {
    if (typeof raw[key] !== "string" || !HEX.test(raw[key])) return null;
    out[key] = raw[key];
  }
  return out;
}

async function readTop(redis) {
  const ids = await redis.zRange(BOARD_KEY, 0, TOP - 1, { REV: true });
  if (!ids.length) return [];
  const rows = await redis.hmGet(ENTRIES_KEY, ids);
  return rows
    .map(function (json, i) {
      if (!json) return null;
      try {
        const e = JSON.parse(json);
        return { id: ids[i], name: e.name, points: e.points, score: e.score, total: e.total, avatar: e.avatar };
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean);
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise(function (resolve) {
    let data = "";
    req.on("data", function (chunk) {
      data += chunk;
      if (data.length > 10000) req.destroy();
    });
    req.on("end", function () {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); }
    });
  });
}

module.exports = async function handler(req, res) {

  res.setHeader("Cache-Control", "no-store");

  if (!process.env.REDIS_URL) {
    return res.status(500).json({ error: "Database is not connected." });
  }

  let redis;
  try {
    redis = await getClient();
  } catch (e) {
    return res.status(503).json({ error: "Could not reach the database." });
  }

  try {

    if (req.method === "GET") {
      return res.status(200).json({ top: await readTop(redis) });
    }

    if (req.method === "POST") {

      // Simple rate limit: 10 submissions per minute per IP address
      const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
      const rlKey = "quiz:rl:" + ip;
      const count = await redis.incr(rlKey);
      if (count === 1) await redis.expire(rlKey, 60);
      if (count > 10) {
        return res.status(429).json({ error: "Too many submissions. Please wait a minute." });
      }

      const body = await readBody(req);

      const name = cleanName(body.name);
      if (!name) return res.status(400).json({ error: "Please choose a different name." });

      const avatar = cleanAvatar(body.avatar);
      if (!avatar) return res.status(400).json({ error: "Invalid avatar." });

      const total = Number(body.total);
      const score = Number(body.score);
      const points = Number(body.points);

      if (!Number.isInteger(total) || total < 1 || total > MAX_QUESTIONS ||
          !Number.isInteger(score) || score < 0 || score > total ||
          !Number.isInteger(points) || points < 0 || points > total * MAX_POINTS_PER_QUESTION ||
          points > score * MAX_POINTS_PER_QUESTION) {
        return res.status(400).json({ error: "Invalid score." });
      }

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

      await redis.hSet(ENTRIES_KEY, id, JSON.stringify({ name, points, score, total, avatar, at: Date.now() }));
      await redis.zAdd(BOARD_KEY, { score: points, value: id });

      // Keep only the best KEEP results
      const size = await redis.zCard(BOARD_KEY);
      if (size > KEEP) {
        const drop = await redis.zRange(BOARD_KEY, 0, size - KEEP - 1);
        if (drop.length) {
          await redis.zRem(BOARD_KEY, drop);
          await redis.hDel(ENTRIES_KEY, drop);
        }
      }

      const rankIndex = await redis.zRevRank(BOARD_KEY, id);

      return res.status(200).json({
        id: id,
        rank: rankIndex === null ? null : rankIndex + 1,
        top: await readTop(redis)
      });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });

  } catch (e) {
    return res.status(500).json({ error: "Something went wrong saving the score." });
  }
};
