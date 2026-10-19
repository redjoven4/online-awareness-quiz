/*
  Teacher dashboard API.

  GET /api/teacher?since=<ms timestamp>
      header  x-teacher-code: <code>
  -> { games: [ { id, name, avatar, mode, total, answered, score, points, finished, answers, at, updated } ] }

  The code is set in the Vercel project as the environment variable TEACHER_CODE.
  Wrong codes are limited to 10 attempts per minute per network.
*/

const crypto = require("crypto");
const { KEYS, getClient } = require("../lib/db");

const MAX_GAMES = 3000;
const MAX_FAILS_PER_MINUTE = 10;

function sameCode(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = async function handler(req, res) {

  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const expected = process.env.TEACHER_CODE;
  if (!expected) {
    return res.status(500).json({ error: "Teacher access isn't set up yet (TEACHER_CODE is missing)." });
  }

  let redis;
  try {
    redis = await getClient();
  } catch (e) {
    return res.status(503).json({ error: "Could not reach the database." });
  }

  try {

    const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
    const failKey = "quiz:rl:teacherfail:" + ip;

    const fails = Number(await redis.get(failKey)) || 0;
    if (fails >= MAX_FAILS_PER_MINUTE) {
      return res.status(429).json({ error: "Too many wrong codes. Please wait a minute." });
    }

    const given = String(req.headers["x-teacher-code"] || "").trim();
    if (!given || !sameCode(given.toLowerCase(), String(expected).trim().toLowerCase())) {
      const n = await redis.incr(failKey);
      if (n === 1) await redis.expire(failKey, 60);
      return res.status(401).json({ error: "That teacher code isn't right." });
    }

    const url = new URL(req.url || "/", "http://localhost");
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);

    const ids = await redis.zRangeByScore(KEYS.GAMES, since, "+inf");
    const recent = ids.slice(-MAX_GAMES);
    if (!recent.length) return res.status(200).json({ games: [] });

    const rows = await redis.hmGet(KEYS.ENTRIES, recent);

    const games = rows
      .map(function (json, i) {
        if (!json) return null;
        try {
          const e = JSON.parse(json);
          return {
            id: recent[i],
            name: e.name,
            avatar: e.avatar,
            mode: e.mode || "challenge",
            total: e.total,
            answered: e.answered || e.total,
            score: e.score,
            points: e.points,
            finished: e.finished !== false,
            answers: Array.isArray(e.answers) ? e.answers : [],
            at: e.at,
            updated: e.updated || e.at
          };
        } catch (err) {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();   // newest first

    return res.status(200).json({ games: games });

  } catch (e) {
    console.error("teacher error:", e);
    return res.status(500).json({ error: "Something went wrong loading results." });
  }
};
