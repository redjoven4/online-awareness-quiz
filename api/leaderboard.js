/*
  Leaderboard + progress API for the Online Awareness Quiz.

  GET  /api/leaderboard   -> top 10 Challenge players (including people still playing)
  POST /api/leaderboard   -> save progress after each question (both modes).
                             First call creates a game and returns { id, token };
                             later calls send { id, token } to update that same game.

  Every game (Challenge and Learning) is kept for the teacher dashboard (quiz:games).
  Only Challenge games appear on the public leaderboard (quiz:board).
*/

const crypto = require("crypto");
const { KEYS, getClient, overLimit, readBody } = require("../lib/db");

const TOP = 10;                       // leaderboard rows shown
const KEEP_ON_BOARD = 100;            // best Challenge results kept on the leaderboard
const KEEP_GAMES = 3000;              // most recent games kept for teachers
const MAX_POINTS_PER_QUESTION = 1000;
const MAX_QUESTIONS = 50;
const STALE_MS = 20 * 60 * 1000;      // unfinished games idle this long are hidden from the leaderboard
const RATE_LIMIT = 300;               // requests per minute per network (a class shares one school Wi-Fi)

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

// answers: [{ q: question index, s: chosen answer index (-1 = time ran out), c: correct? }]
function cleanAnswers(raw, total) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > total) return null;
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") return null;
    const q = Number(a.q), sel = Number(a.s);
    if (!Number.isInteger(q) || q < 0 || q >= total) return null;
    if (!Number.isInteger(sel) || sel < -1 || sel > 3) return null;
    out.push({ q: q, s: sel, c: a.c === true });
  }
  return out;
}

async function readTop(redis) {
  const ids = await redis.zRange(KEYS.BOARD, 0, TOP * 3 - 1, { REV: true });
  if (!ids.length) return [];
  const rows = await redis.hmGet(KEYS.ENTRIES, ids);
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

async function trim(redis) {

  // Leaderboard: keep the best KEEP_ON_BOARD (the game records stay for teachers)
  const boardSize = await redis.zCard(KEYS.BOARD);
  if (boardSize > KEEP_ON_BOARD) {
    await redis.zRemRangeByRank(KEYS.BOARD, 0, boardSize - KEEP_ON_BOARD - 1);
  }

  // Teacher history: keep the most recent KEEP_GAMES games
  const gamesSize = await redis.zCard(KEYS.GAMES);
  if (gamesSize > KEEP_GAMES) {
    const old = await redis.zRange(KEYS.GAMES, 0, gamesSize - KEEP_GAMES - 1);
    if (old.length) {
      await redis.zRem(KEYS.GAMES, old);
      await redis.zRem(KEYS.BOARD, old);
      await redis.hDel(KEYS.ENTRIES, old);
    }
  }
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

      if (await overLimit(redis, "save", req, RATE_LIMIT)) {
        return res.status(429).json({ error: "Too many requests. Please wait a minute." });
      }

      const body = await readBody(req);

      const total = Number(body.total);
      const score = Number(body.score);
      const points = Number(body.points);
      const mode = body.mode === "learning" ? "learning" : "challenge";

      // Older versions of the page sent only the final score (no "answered"):
      // treat those as a finished game so they still count.
      const legacy = body.answered === undefined;
      const answered = legacy ? total : Number(body.answered);
      const finished = legacy ? true : body.finished === true;

      const maxPoints = mode === "learning" ? 0 : MAX_POINTS_PER_QUESTION;

      let problem =
        !Number.isInteger(total) || total < 1 || total > MAX_QUESTIONS ? "total questions = " + body.total :
        !Number.isInteger(answered) || answered < 1 || answered > total ? "question number = " + body.answered :
        finished && answered !== total ? "finished before the last question" :
        !Number.isInteger(score) || score < 0 || score > answered ? "correct answers = " + body.score :
        !Number.isInteger(points) || points < 0 ? "points = " + body.points :
        points > score * maxPoints ? "points " + points + " too high for " + score + " correct" :
        null;

      const answers = problem ? null : cleanAnswers(body.answers, total);
      if (!problem && !answers) problem = "answer list";
      if (!problem && answers.length && answers.length !== answered) problem = "answer list length";
      if (!problem && answers.length && answers.filter(function (a) { return a.c; }).length !== score) {
        problem = "answer list does not match score";
      }

      if (problem) {
        return res.status(400).json({ error: "Invalid score (" + String(problem).slice(0, 60) + ")." });
      }

      let id, token, entry;

      if (body.id) {

        // Update an existing game: must match its secret token
        id = String(body.id).slice(0, 40);
        const json = await redis.hGet(KEYS.ENTRIES, id);
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
        if (answers.length) entry.answers = answers;
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
          name: name, avatar: avatar, mode: mode, total: total, answered: answered,
          score: score, points: points, finished: finished, answers: answers,
          token: token, at: Date.now(), updated: Date.now()
        };
      }

      await redis.hSet(KEYS.ENTRIES, id, JSON.stringify(entry));
      await redis.zAdd(KEYS.GAMES, { score: entry.at, value: id });

      let rank = null;

      if ((entry.mode || "challenge") === "challenge") {
        await redis.zAdd(KEYS.BOARD, { score: entry.points, value: id });
        const rankIndex = await redis.zRevRank(KEYS.BOARD, id);
        rank = rankIndex === null ? null : rankIndex + 1;
      }

      await trim(redis);

      return res.status(200).json({
        id: id,
        token: token,
        rank: rank,
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
