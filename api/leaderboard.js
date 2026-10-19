/*
  Shared leaderboard API for the Online Awareness Quiz.

  GET  /api/leaderboard          -> top 10 players (including people still playing)
  POST /api/leaderboard          -> save progress after each question.
                                    First call creates an entry and returns { id, token };
                                    later calls send { id, token } to update that same entry.

  Data lives in the Redis database connected to this Vercel project (REDIS_URL):
    quiz:board      sorted set   member = entry id, score = points
    quiz:entries    hash         entry id -> JSON { name, points, score, total, avatar, at }
*/

const { createClient } = require("redis");
const crypto = require("crypto");

const BOARD_KEY = "quiz:board";
const ENTRIES_KEY = "quiz:entries";
const KEEP = 100;          // only the best 100 results are stored
const TOP = 10;            // how many are shown
const MAX_POINTS_PER_QUESTION = 1000;
const MAX_QUESTIONS = 50;
const STALE_MS = 20 * 60 * 1000;   // unfinished games idle this long are hidden
const RATE_LIMIT = 300;            // requests per minute per network (a class shares one school Wi-Fi)

// Values the avatar builder can produce. Anything else is rejected.
const AVATAR_STYLES = {
  hair: ["short", "spiky", "long", "bun", "curly", "none"],
  shirt: ["tee", "hoodie", "stripes", "jersey"],
  legs: ["jeans", "joggers", "shorts", "skirt"],
  shoes: ["sneakers", "hightops", "boots", "sandals"]
};
const AVATAR_COLOURS = ["skin", "hairColor", "shirtColor", "legColor", "shoeColor"];
const HEX = /^#[0-9a-fA-F]{6}$/;

// Basic word filter for display names.
// BLOCKED_ANYWHERE: blocked even inside other words / with spaces removed.
// BLOCKED_WORDS: blocked only as whole words, so normal names like "Dicky" or "Skilla" are allowed.
const BLOCKED_ANYWHERE = [
  "fuck", "shit", "bitch", "cunt", "nigg", "pussy", "whore", "slut", "asshole", "porn", "pukimak", "lancau"
];
const BLOCKED_WORDS = [
  "sex", "kill", "rape", "nazi", "babi", "bodoh", "sial", "dick", "fag", "bastard"
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
  if (BLOCKED_ANYWHERE.some(function (w) { return squashed.includes(w); })) return null;
  const words = name.toLowerCase().split(/[^a-z]+/);
  if (words.some(function (w) { return BLOCKED_WORDS.includes(w); })) return null;
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
  const ids = await redis.zRange(BOARD_KEY, 0, TOP * 3 - 1, { REV: true });
  if (!ids.length) return [];
  const rows = await redis.hmGet(ENTRIES_KEY, ids);
  const now = Date.now();
  return rows
    .map(function (json, i) {
      if (!json) return null;
      try {
        const e = JSON.parse(json);
        const finished = e.finished !== false;   // older entries were all finished games
        if (!finished && now - (e.updated || e.at || 0) > STALE_MS) return null;
        return {
          id: ids[i], name: e.name, points: e.points, score: e.score, total: e.total,
          answered: e.answered || e.total, finished: finished, avatar: e.avatar
        };
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, TOP);
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

      // Health check: /api/leaderboard?selftest=1 writes, reads and deletes a test value
      const url = new URL(req.url || "/", "http://localhost");
      if (url.searchParams.get("selftest") === "1") {
        const key = "quiz:selftest";
        await redis.set(key, "ok", { EX: 30 });
        const back = await redis.get(key);
        await redis.del(key);
        const size = await redis.zCard(BOARD_KEY);
        return res.status(200).json({ write: back === "ok", savedResults: size });
      }

      return res.status(200).json({ top: await readTop(redis) });
    }

    if (req.method === "POST") {

      // Rate limit per network
      const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
      const rlKey = "quiz:rl:" + ip;
      const count = await redis.incr(rlKey);
      if (count === 1) await redis.expire(rlKey, 60);
      if (count > RATE_LIMIT) {
        return res.status(429).json({ error: "Too many requests. Please wait a minute." });
      }

      const body = await readBody(req);

      const total = Number(body.total);
      const score = Number(body.score);
      const points = Number(body.points);

      // Older versions of the page sent only the final score (no "answered"):
      // treat those as a finished game so they still count.
      const legacy = body.answered === undefined;
      const answered = legacy ? total : Number(body.answered);
      const finished = legacy ? true : body.finished === true;

      const problem =
        !Number.isInteger(total) || total < 1 || total > MAX_QUESTIONS ? "total questions = " + body.total :
        !Number.isInteger(answered) || answered < 1 || answered > total ? "question number = " + body.answered :
        finished && answered !== total ? "finished before the last question" :
        !Number.isInteger(score) || score < 0 || score > answered ? "correct answers = " + body.score :
        !Number.isInteger(points) || points < 0 ? "points = " + body.points :
        points > score * MAX_POINTS_PER_QUESTION ? "points " + points + " too high for " + score + " correct" :
        null;

      if (problem) {
        return res.status(400).json({ error: "Invalid score (" + String(problem).slice(0, 60) + ")." });
      }

      let id, token, entry;

      if (body.id) {

        // Update an existing game: must match its secret token
        id = String(body.id).slice(0, 40);
        const json = await redis.hGet(ENTRIES_KEY, id);
        if (!json) return res.status(404).json({ error: "Game not found." });
        entry = JSON.parse(json);
        token = String(body.token || "");
        if (!entry.token || entry.token !== token) {
          return res.status(403).json({ error: "Not allowed to update this game." });
        }
        if (entry.finished) {
          return res.status(409).json({ error: "This game is already finished." });
        }
        if (answered < entry.answered || points < entry.points || score < entry.score) {
          return res.status(400).json({ error: "Score can't go down." });
        }
        entry.answered = answered;
        entry.score = score;
        entry.points = points;
        entry.finished = finished;
        entry.updated = Date.now();

      } else {

        // New game
        const name = cleanName(body.name);
        if (!name) return res.status(400).json({ error: "Please choose a different name." });

        const avatar = cleanAvatar(body.avatar);
        if (!avatar) return res.status(400).json({ error: "Invalid avatar." });

        id = Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
        token = crypto.randomBytes(16).toString("hex");
        entry = {
          name: name, avatar: avatar, total: total, answered: answered,
          score: score, points: points, finished: finished,
          token: token, at: Date.now(), updated: Date.now()
        };
      }

      await redis.hSet(ENTRIES_KEY, id, JSON.stringify(entry));
      await redis.zAdd(BOARD_KEY, { score: entry.points, value: id });

      // Keep only the best KEEP results
      const size = await redis.zCard(BOARD_KEY);
      if (size > KEEP) {
        const drop = (await redis.zRange(BOARD_KEY, 0, size - KEEP - 1)).filter(function (d) { return d !== id; });
        if (drop.length) {
          await redis.zRem(BOARD_KEY, drop);
          await redis.hDel(ENTRIES_KEY, drop);
        }
      }

      const rankIndex = await redis.zRevRank(BOARD_KEY, id);

      return res.status(200).json({
        id: id,
        token: token,
        rank: rankIndex === null ? null : rankIndex + 1,
        top: await readTop(redis)
      });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });

  } catch (e) {
    console.error("leaderboard error:", e);
    return res.status(500).json({
      error: "Something went wrong saving the score.",
      detail: String((e && e.message) || e).slice(0, 200)
    });
  }
};
