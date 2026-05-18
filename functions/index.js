const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp({
  databaseURL:
    "https://division-of-fractions-default-rtdb.asia-southeast1.firebasedatabase.app",
});

const db = admin.database();
const REGION = "asia-northeast3";
const MAX_LV = 2000;
const BANNED_NICK_RE = /운영자|관리자|관리자환영|운영자환영|^gm$|^admin$|치트|hack/i;

const ALLOWED_ATK = new Set([
  10, 15, 25, 55, 110, 300, 600, 1000, 1500,
]);
const ALLOWED_COMBO = new Set([0, 3, 7, 12, 22, 40, 60, 85, 120]);
const ALLOWED_BONUS_TIME = new Set([5, 7, 9, 12, 16, 22]);
const ALLOWED_EXP_BONUS = new Set([0, 50, 100, 200]);

function getToday() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fail(message, code = "invalid-argument") {
  throw new functions.https.HttpsError(code, message);
}

function normalizeSchool(raw) {
  let school = String(raw || "").trim().replace(/\s+/g, "");
  if (!school) return "";
  if (school.endsWith("초")) school += "등학교";
  else if (!school.endsWith("초등학교")) school += "초등학교";
  return school;
}

function legacySchoolCandidates(raw) {
  const trimmed = String(raw || "").trim();
  const compact = trimmed.replace(/\s+/g, "");
  const variants = new Set([normalizeSchool(trimmed), normalizeSchool(compact)]);
  for (const s of [trimmed, compact]) {
    if (!s) continue;
    variants.add(s);
    if (s.endsWith("초")) variants.add(`${s}등학교`);
    if (!s.endsWith("초등학교")) variants.add(`${s}초등학교`);
  }
  return [...variants].filter(Boolean);
}

function cleanName(raw, max) {
  return String(raw || "").trim().slice(0, max);
}

function validateIdentity(school, nickname) {
  if (!school || !nickname) fail("학교와 닉네임을 입력해 주세요.");
  if (school.length > 80) fail("학교 이름이 너무 깁니다.");
  if (nickname.length > 40) fail("닉네임이 너무 깁니다.");
  if (/[.#$\[\]/\\]/.test(`${school}${nickname}`)) {
    fail("학교/닉네임에 사용할 수 없는 문자가 있습니다.");
  }
  if (BANNED_NICK_RE.test(school) || BANNED_NICK_RE.test(nickname)) {
    fail("사용할 수 없는 학교/닉네임입니다.");
  }
}

function userIdFor(school, nickname) {
  validateIdentity(school, nickname);
  return `${school}-${nickname}`;
}

function candidateUserIds(rawSchool, nickname) {
  return legacySchoolCandidates(rawSchool)
    .map((school) => {
      try {
        validateIdentity(school, nickname);
        return `${school}-${nickname}`;
      } catch (e) {
        return "";
      }
    })
    .filter(Boolean);
}

async function findExistingPlayer(rawSchool, nickname, primaryUserId) {
  const ids = [primaryUserId, ...candidateUserIds(rawSchool, nickname)];
  const seen = new Set();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const snap = await db.ref(`players/${id}`).get();
    if (snap.exists()) return { userId: id, player: snap.val() };
  }
  return { userId: primaryUserId, player: null };
}

function passwordHash(userId, password) {
  return crypto
    .createHash("sha256")
    .update(`${userId}:${String(password || "")}`, "utf8")
    .digest("hex");
}

function normalizePassword(raw) {
  const pw = String(raw || "").trim();
  if (!pw) return "";
  if (!/^\d{4}$/.test(pw)) fail("비밀번호는 숫자 4자리만 사용할 수 있습니다.");
  return pw;
}

function assertPassword(existing, userId, password) {
  const pw = normalizePassword(password);
  if (!existing) return pw;
  if (existing.pwHash) {
    if (!pw || existing.pwHash !== passwordHash(userId, pw)) {
      fail("비밀번호가 맞지 않습니다.", "permission-denied");
    }
    return pw;
  }
  if (existing.pw) {
    if (!pw || String(existing.pw) !== pw) {
      fail("비밀번호가 맞지 않습니다.", "permission-denied");
    }
    return pw;
  }
  return pw;
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function allowedOrDefault(value, allowed, fallback) {
  const n = clampInt(value, -999999, 999999, fallback);
  return allowed.has(n) ? n : fallback;
}

function maskNicknamePlain(nickname) {
  const n = String(nickname || "");
  if (n.length <= 2) return n.length ? `${n[0]}★` : "★";
  return `${n[0]}${"★".repeat(n.length - 2)}${n[n.length - 1]}`;
}

function defaultPlayer(school, nickname) {
  return {
    nickname,
    school,
    lv: 1,
    hp: 100,
    maxHp: 100,
    gold: 0,
    exp: 0,
    maxExp: 50,
    atk: 10,
    comboRate: 0,
    bonusTime: 5,
    expBonus: 0,
    curCombo: 0,
    isSecret: true,
    weapon: "무딘 검",
    armor: "평상복",
    acc: "없음",
    expItem: "없음",
    collection: {},
    todayAns: 0,
    lastDate: getToday(),
  };
}

function sanitizeCollection(collection) {
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(collection).slice(0, 30)) {
    const name = cleanName(key, 40);
    if (!name || /[.#$\[\]/\\]/.test(name)) continue;
    out[name] = clampInt(value, 0, 100000, 0);
  }
  return out;
}

function sanitizePlayer(input, existing, school, nickname) {
  const p = input && typeof input === "object" ? input : {};
  const base = existing && typeof existing === "object" ? existing : defaultPlayer(school, nickname);
  const today = getToday();
  const out = {
    ...base,
    nickname,
    school,
    lv: clampInt(p.lv, 1, MAX_LV, base.lv || 1),
    hp: clampInt(p.hp, 0, 500000, base.hp || 100),
    maxHp: clampInt(p.maxHp, 10, 500000, base.maxHp || 100),
    gold: clampInt(p.gold, 0, 1000000000, base.gold || 0),
    exp: clampInt(p.exp, 0, 100000, base.exp || 0),
    maxExp: clampInt(p.maxExp, 1, 100000, base.maxExp || 50),
    atk: allowedOrDefault(p.atk, ALLOWED_ATK, base.atk || 10),
    comboRate: allowedOrDefault(p.comboRate, ALLOWED_COMBO, base.comboRate || 0),
    bonusTime: allowedOrDefault(p.bonusTime, ALLOWED_BONUS_TIME, base.bonusTime || 5),
    expBonus: allowedOrDefault(p.expBonus, ALLOWED_EXP_BONUS, base.expBonus || 0),
    curCombo: clampInt(p.curCombo, 0, 999999, base.curCombo || 0),
    isSecret: p.isSecret !== false,
    weapon: cleanName(p.weapon || base.weapon || "무딘 검", 40),
    armor: cleanName(p.armor || base.armor || "평상복", 40),
    acc: cleanName(p.acc || base.acc || "없음", 40),
    expItem: cleanName(p.expItem || base.expItem || "없음", 40),
    collection: sanitizeCollection(p.collection || base.collection),
    todayAns: clampInt(p.todayAns, 0, 100000, base.todayAns || 0),
    lastDate: cleanName(p.lastDate || base.lastDate || today, 64),
  };

  if (out.lastDate !== today) {
    out.todayAns = 0;
    out.lastDate = today;
  }

  if (existing) {
    out.lv = Math.max(base.lv || 1, Math.min(out.lv, (base.lv || 1) + 1));
    out.todayAns = Math.max(base.todayAns || 0, Math.min(out.todayAns, (base.todayAns || 0) + 3));
    out.gold = Math.max(0, Math.max((base.gold || 0) - 70000, Math.min(out.gold, (base.gold || 0) + 6000)));
    out.atk = Math.max(1, Math.max((base.atk || 10) - 1, out.atk));
    out.hp = Math.max((base.hp || 0) - 20, Math.min(out.hp, out.maxHp + 25));
  }

  delete out.pw;
  delete out.kick;
  return out;
}

function rankDataFor(p) {
  return {
    lv: p.lv || 1,
    todayAns: p.todayAns || 0,
    school: p.school || "",
    nickname: p.isSecret === false ? p.nickname || "" : maskNicknamePlain(p.nickname || ""),
    lastDate: p.lastDate || getToday(),
    isSecret: p.isSecret !== false,
  };
}

function publicPlayer(p) {
  const out = { ...p };
  delete out.pw;
  delete out.pwHash;
  return out;
}

exports.loginPlayer = functions.region(REGION).https.onCall(async (data) => {
  const rawSchool = data?.school;
  const school = normalizeSchool(rawSchool);
  const nickname = cleanName(data?.nickname, 40);
  const userId = userIdFor(school, nickname);
  const pw = normalizePassword(data?.password);
  const found = await findExistingPlayer(rawSchool, nickname, userId);
  const existing = found.player;
  const checkedPw = assertPassword(existing, found.userId, pw);

  let player;
  let isNew = false;
  if (existing) {
    player = sanitizePlayer(existing, existing, school, nickname);
  } else {
    player = defaultPlayer(school, nickname);
    isNew = true;
  }

  const updates = {};
  if (checkedPw) player.pwHash = passwordHash(userId, checkedPw);
  if (existing?.pw) player.pw = null;
  updates[`players/${userId}`] = player;
  updates[`leaderboard/${userId}`] = rankDataFor(player);
  await db.ref().update(updates);

  return { player: publicPlayer(player), isNew, locked: Boolean(player.pwHash) };
});

exports.savePlayer = functions.region(REGION).https.onCall(async (data) => {
  const rawPlayer = data?.player;
  if (!rawPlayer || typeof rawPlayer !== "object") fail("저장할 데이터가 없습니다.");

  const rawSchool = rawPlayer.school;
  const school = normalizeSchool(rawSchool);
  const nickname = cleanName(rawPlayer.nickname, 40);
  const userId = userIdFor(school, nickname);
  const found = await findExistingPlayer(rawSchool, nickname, userId);
  const existing = found.player;
  const checkedPw = assertPassword(existing, found.userId, data?.password);
  const player = sanitizePlayer(rawPlayer, existing, school, nickname);

  if (existing?.pwHash || existing?.pw || checkedPw) {
    player.pwHash = passwordHash(userId, checkedPw);
  }

  const updates = {};
  updates[`players/${userId}`] = player;
  updates[`leaderboard/${userId}`] = rankDataFor(player);
  await db.ref().update(updates);

  return { player: publicPlayer(player) };
});
