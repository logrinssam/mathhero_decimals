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

const ALLOWED_ATK = new Set([10, 15, 25, 55, 110, 300, 600, 1000, 1500]);
const ALLOWED_COMBO = new Set([0, 3, 7, 12, 22, 40, 60, 85, 120]);
const ALLOWED_BONUS_TIME = new Set([5, 7, 9, 12, 16, 22]);
const ALLOWED_EXP_BONUS = new Set([0, 50, 100, 200]);

function getToday() {
  // Cloud Functions는 UTC 기준 → KST(UTC+9) 변환하여 한국 자정에 리셋
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day   = String(d.getUTCDate()).padStart(2, "0");
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
    if (!s.endsWith("초")) variants.add(`${s}초`);
    if (s.endsWith("초")) variants.add(`${s}등학교`);
    if (!s.endsWith("초등학교")) variants.add(`${s}초등학교`);
  }
  return [...variants].filter(Boolean);
}

function schoolCore(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/초등학교$/, "")
    .replace(/초$/, "");
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
  let best = null;
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const snap = await db.ref(`players/${id}`).get();
    if (snap.exists()) {
      const player = snap.val();
      if (!best || (player?.lv || 0) > (best.player?.lv || 0)) {
        best = { userId: id, player };
      }
    }
  }
  return best || { userId: primaryUserId, player: null };
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
  if (!/^[A-Za-z0-9]{4,12}$/.test(pw)) {
    fail("비밀번호는 영문/숫자 4~12자만 사용할 수 있습니다.");
  }
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

// ===== 상점/몬스터 데이터 =====
const SHOP_ITEMS = [
  { type: "w", name: "연습용 목검",      price: 100,   val: 15   },
  { type: "w", name: "소수점 단검",      price: 300,   val: 25   },
  { type: "w", name: "강철 분할도",      price: 800,   val: 55   },
  { type: "w", name: "황금 나눗셈검",    price: 1800,  val: 110  },
  { type: "w", name: "진리검: 제로",     price: 4500,  val: 300  },
  { type: "w", name: "드래곤의 발톱검",  price: 15000, val: 600  },
  { type: "w", name: "마왕 처단자",      price: 35000, val: 1000 },
  { type: "w", name: "창조신의 별빛검",  price: 70000, val: 1500 },
  { type: "a", name: "질긴 가죽옷",      price: 150,   val: 3    },
  { type: "a", name: "집중의 예복",      price: 450,   val: 7    },
  { type: "a", name: "사슬 갑옷",        price: 1000,  val: 12   },
  { type: "a", name: "기사의 판금",      price: 2500,  val: 22   },
  { type: "a", name: "용사의 성갑",      price: 5500,  val: 40   },
  { type: "a", name: "드래곤 본 아머",   price: 12000, val: 60   },
  { type: "a", name: "마왕의 망토",      price: 28000, val: 85   },
  { type: "a", name: "창조신의 날개옷",  price: 60000, val: 120  },
  { type: "x", name: "나무 시계",        price: 200,   val: 7    },
  { type: "x", name: "은빛 반지",        price: 600,   val: 9    },
  { type: "x", name: "푸른 보석 목걸이", price: 1300,  val: 12   },
  { type: "x", name: "차원의 나침반",    price: 2800,  val: 16   },
  { type: "x", name: "시간의 지배자",    price: 6500,  val: 22   },
  { type: "e", name: "학자의 두루마리",  price: 8000,  val: 50   },
  { type: "e", name: "현자의 모자",      price: 25000, val: 100  },
  { type: "e", name: "깨달음의 성배",    price: 55000, val: 200  },
];

const MONSTER_DATA = [
  { name: "소수점 슬라임",      reqLv: 1   },
  { name: "나눗셈 고스트",      reqLv: 1   },
  { name: "분할 골렘",          reqLv: 1   },
  { name: "소수 가시",          reqLv: 1   },
  { name: "소수점 드래곤",      reqLv: 50  },
  { name: "무한소수 마왕",      reqLv: 100 },
  { name: "시공의 지배자 제로", reqLv: 200 },
];

// ===== 매크로 차단 상수 =====
const activeProblems  = new Map();
const lastAttackTime  = new Map();

const MINUTE_LIMIT    = 20;                          // 1분 최대 20회
const DAILY_LIMIT     = 2000;                        // 하루 최대 2000회
const MIN_INTERVAL_MS = 3000;                        // 호출 최소 간격 3초 (DB 저장)
const BLOCK_DURATIONS = [
  60  * 60 * 1000,                                   // 1차 위반: 1시간
  6   * 60 * 60 * 1000,                              // 2차 위반: 6시간
  24  * 60 * 60 * 1000,                              // 3차 위반: 24시간
  100 * 365 * 24 * 60 * 60 * 1000,                  // 4차 이상: 영구차단
];
const BLOCK_LABELS = ["1시간", "6시간", "24시간", "영구"];
// ===== 상수 끝 =====

// ===== 매크로 차단: Rate Limit (DB 저장 방식 → 서버 재시작해도 유지) =====
async function checkRateLimit(userId) {
  const now   = Date.now();
  const today = getToday();

  // 새벽 1~6시 차단 (한국시간 UTC+9 기준)
  const koreaHour = new Date(now + 9 * 60 * 60 * 1000).getUTCHours();
  if (koreaHour >= 1 && koreaHour < 6) {
    fail("서비스 점검 시간입니다. (새벽 1시~6시)", "resource-exhausted");
  }

  const ref  = db.ref(`rateLimit/${userId}`);
  const snap = await ref.get();
  const data = snap.val() || {
    count: 0, windowStart: now,
    dailyCount: 0, dailyDate: today,
    lastCallTime: 0, violationCount: 0, blockedUntil: 0,
  };

  // 차단 중 확인
  if (data.blockedUntil && now < data.blockedUntil) {
    const minLeft = Math.ceil((data.blockedUntil - now) / 60000);
    fail(
      data.violationCount >= 4
        ? "계정이 영구 차단되었습니다. 선생님께 문의하세요."
        : `비정상 사용으로 차단 중입니다. ${minLeft}분 후 가능합니다.`,
      "resource-exhausted"
    );
  }

  // 날짜 바뀌면 일일 카운트 리셋
  if (data.dailyDate !== today) {
    data.dailyCount = 0;
    data.dailyDate  = today;
  }

  // 일일 한도 초과
  if (data.dailyCount >= DAILY_LIMIT) {
    fail("오늘 학습 한도(2000개)에 도달했어요! 내일 만나요 🎉", "resource-exhausted");
  }

  // 최소 호출 간격 1.5초 위반 → 즉시 차단
  if (now - (data.lastCallTime || 0) < MIN_INTERVAL_MS) {
    data.violationCount = (data.violationCount || 0) + 1;
    const idx = Math.min(data.violationCount - 1, BLOCK_DURATIONS.length - 1);
    data.blockedUntil = now + BLOCK_DURATIONS[idx];
    await ref.update(data);
    fail(
      `자동화 도구 감지 (${data.violationCount}회 경고) → ${BLOCK_LABELS[idx]} 차단`,
      "resource-exhausted"
    );
  }

  // 1분 윈도우 리셋
  if (now - (data.windowStart || 0) > 60 * 1000) {
    data.count       = 0;
    data.windowStart = now;
  }

  data.count++;
  data.dailyCount++;
  data.lastCallTime = now;

  // 1분 40회 초과 → 차단
  if (data.count > MINUTE_LIMIT) {
    data.violationCount = (data.violationCount || 0) + 1;
    const idx = Math.min(data.violationCount - 1, BLOCK_DURATIONS.length - 1);
    data.blockedUntil = now + BLOCK_DURATIONS[idx];
    await ref.update(data);
    fail(
      `자동화 도구 감지 (${data.violationCount}회 경고) → ${BLOCK_LABELS[idx]} 차단`,
      "resource-exhausted"
    );
  }

  await ref.update(data);
}

// ===== 이상 행동 탐지 (의심 계정 자동 기록) =====
async function detectAnomalies(userId, isCorrect, elapsed) {
  try {
    const ref  = db.ref(`anomaly/${userId}`);
    const snap = await ref.get();
    const data = snap.val() || { recentTimes: [], correctStreak: 0, suspicionScore: 0 };

    // 최근 10개 응답시간 기록
    data.recentTimes    = [...(data.recentTimes || []).slice(-9), elapsed];
    data.correctStreak  = isCorrect ? (data.correctStreak || 0) + 1 : 0;

    let score = data.suspicionScore || 0;

    // 신호 1: 응답시간 분산 작음 (자동화 패턴)
    if (data.recentTimes.length >= 5) {
      const avg      = data.recentTimes.reduce((a, b) => a + b, 0) / data.recentTimes.length;
      const variance = data.recentTimes.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / data.recentTimes.length;
      if (variance < 0.3 && avg < 3.3) score += 2;
    }

    // 신호 2: 500연속 정답 + 빠른 속도
    if (data.correctStreak > 500 && elapsed < 5.0) score += 5;

    // 오답 발생 시 점수 감쇠 (정상 학생 보호)
    if (!isCorrect) score = Math.max(0, score - 2);

    data.suspicionScore = Math.min(score, 20);
    await ref.update(data);

    // 관리자 검토용 로그 (점수 10점 이상)
    if (data.suspicionScore >= 10) {
      await db.ref(`suspiciousUsers/${userId}`).update({
        score:         data.suspicionScore,
        detectedAt:    new Date().toISOString(),
        correctStreak: data.correctStreak,
      });
    }

    // 자동 차단: 세 조건이 동시에 충족될 때만 (사람이 걸릴 수 없는 조건)
    // ① 의심점수 15점 이상 (여러 신호가 반복 누적)
    // ② 500연속 정답 유지 중
    // → 이 둘이 동시에 성립하는 실제 학생은 없음
    if (data.suspicionScore >= 15 && data.correctStreak > 500) {
      const rlRef  = db.ref(`rateLimit/${userId}`);
      const rlSnap = await rlRef.get();
      const rl     = rlSnap.val() || {};
      if (!rl.blockedUntil || Date.now() >= rl.blockedUntil) {
        rl.violationCount = (rl.violationCount || 0) + 1;
        const idx         = Math.min(rl.violationCount - 1, BLOCK_DURATIONS.length - 1);
        rl.blockedUntil   = Date.now() + BLOCK_DURATIONS[idx];
        await rlRef.update(rl);
      }
    }
  } catch (e) {
    // 이상 탐지 실패해도 게임 진행에 영향 없도록 조용히 처리
    console.error("detectAnomalies error:", e);
  }
}

// ===== 공통 유틸 =====
async function resolvePlayerSession(data) {
  const rawSchool = data?.school;
  const school    = normalizeSchool(rawSchool);
  const nickname  = cleanName(data?.nickname, 40);
  const userId    = userIdFor(school, nickname);
  const found     = await findExistingPlayer(rawSchool || school, nickname, userId);
  const existing  = found.player;
  if (!existing) fail("플레이어를 찾을 수 없습니다.", "not-found");
  const checkedPw = assertPassword(existing, found.userId, data?.password);
  const player    = sanitizePlayer(existing, existing, school, nickname);
  if (existing.pwHash || existing.pw || checkedPw) {
    player.pwHash = passwordHash(userId, checkedPw);
  }
  return { school, nickname, userId, player };
}

async function saveTrustedPlayer(userId, player) {
  const updates = {};
  updates[`players/${userId}`]     = player;
  updates[`leaderboard/${userId}`] = rankDataFor(player);
  await db.ref().update(updates);
}

function pickMonsterForLevel(lv) {
  const available = MONSTER_DATA.filter((m) => lv >= m.reqLv);
  return available[Math.floor(Math.random() * available.length)] || MONSTER_DATA[0];
}

function makeProblemForLevel(lv) {
  const divisor  = Math.floor(Math.random() * 8) + 2;
  const quotient = lv <= 20
    ? (Math.floor(Math.random() * 89)  + 11)  / 10
    : (Math.floor(Math.random() * 899) + 101) / 100;
  const dividend = Number((divisor * quotient).toFixed(2));
  return { question: `${dividend} ÷ ${divisor} = ?`, answer: quotient };
}

// ===== Cloud Functions =====

exports.loginPlayer = functions
  .region(REGION)
  .runWith({ maxInstances: 5, timeoutSeconds: 10, enforceAppCheck: true })
  .https.onCall(async (data) => {
    const rawSchool = data?.school;
    const school    = normalizeSchool(rawSchool);
    const nickname  = cleanName(data?.nickname, 40);
    const userId    = userIdFor(school, nickname);
    const pw        = normalizePassword(data?.password);
    const found     = await findExistingPlayer(rawSchool, nickname, userId);
    const existing  = found.player;
    const checkedPw = assertPassword(existing, found.userId, pw);

    let player;
    let isNew = false;
    if (existing) {
      player = sanitizePlayer(existing, existing, school, nickname);
    } else {
      player = defaultPlayer(school, nickname);
      isNew  = true;
    }

    const updates = {};
    if (checkedPw) player.pwHash = passwordHash(userId, checkedPw);
    if (existing?.pw) player.pw  = null;
    updates[`players/${userId}`]     = player;
    updates[`leaderboard/${userId}`] = rankDataFor(player);
    await db.ref().update(updates);

    return { player: publicPlayer(player), isNew, locked: Boolean(player.pwHash) };
  });

exports.savePlayer = functions
  .region(REGION)
  .runWith({ maxInstances: 5, timeoutSeconds: 10, enforceAppCheck: true })
  .https.onCall(async (data) => {
    const rawPlayer = data?.player;
    if (!rawPlayer || typeof rawPlayer !== "object") fail("저장할 데이터가 없습니다.");

    const rawSchool = rawPlayer.school;
    const school    = normalizeSchool(rawSchool);
    const nickname  = cleanName(rawPlayer.nickname, 40);
    const userId    = userIdFor(school, nickname);
    const found     = await findExistingPlayer(rawSchool, nickname, userId);
    const existing  = found.player;
    const checkedPw = assertPassword(existing, found.userId, data?.password);
    if (!existing) fail("플레이어를 찾을 수 없습니다.", "not-found");

    const player     = sanitizePlayer(existing, existing, school, nickname);
    player.isSecret  = rawPlayer.isSecret !== false;

    if (existing?.pwHash || existing?.pw || checkedPw) {
      player.pwHash = passwordHash(userId, checkedPw);
    }

    await saveTrustedPlayer(userId, player);
    return { player: publicPlayer(player) };
  });

exports.getProblem = functions
  .region(REGION)
  .runWith({ maxInstances: 5, timeoutSeconds: 10, enforceAppCheck: true })
  .https.onCall(async (data) => {
    const { userId, player } = await resolvePlayerSession(data);
    await saveTrustedPlayer(userId, player);

    const lv       = player.lv || 1;
    const existing = activeProblems.get(userId);
    let monster;
    if (existing && existing.monsterHp > 0) {
      monster = {
        name:  existing.monsterName,
        hp:    existing.monsterHp,
        maxHp: existing.monsterMaxHp,
      };
    } else {
      const picked = pickMonsterForLevel(lv);
      const maxHp  = 36 + lv * 18 + Math.floor(lv * lv * 0.012);
      monster      = { name: picked.name, hp: maxHp, maxHp };
    }

    const problem = makeProblemForLevel(lv);
    activeProblems.set(userId, {
      answer:       problem.answer,
      createdAt:    Date.now(),
      monsterName:  monster.name,
      monsterHp:    monster.hp,
      monsterMaxHp: monster.maxHp,
    });

    return { question: problem.question, monster, player: publicPlayer(player) };
  });

exports.submitAnswer = functions
  .region(REGION)
  .runWith({ maxInstances: 5, timeoutSeconds: 10, enforceAppCheck: true })
  .https.onCall(async (data, context) => {                    // ✅ context 추가
    const { userId, player } = await resolvePlayerSession(data);

    await checkRateLimit(userId);                              // ✅ Rate Limit 체크

    const rawAnswer = String(data?.answer ?? "").trim();
    if (!/^-?\d*\.?\d+$/.test(rawAnswer)) fail("잘못된 답입니다.");
    const userAnswer = Number.parseFloat(rawAnswer);
    if (!Number.isFinite(userAnswer) || Math.abs(userAnswer) > 10000) {
      fail("잘못된 답입니다.");
    }

    const now  = Date.now();
    const last = lastAttackTime.get(userId) || 0;
    if (now - last < 400) fail("너무 빠릅니다.", "resource-exhausted");
    lastAttackTime.set(userId, now);

    const problem = activeProblems.get(userId);
    if (!problem) fail("문제를 먼저 받아 주세요.", "not-found");

    const isCorrect = Math.abs(userAnswer - problem.answer) < 0.001;
    const elapsed   = (now - problem.createdAt) / 1000;
    const result    = { correct: isCorrect, correctAnswer: problem.answer };

    if (isCorrect) {
      player.curCombo  = (player.curCombo || 0) + 1;
      player.todayAns  = Math.min((player.todayAns || 0) + 1, 100000);

      const killedCount     = (player.collection && player.collection[problem.monsterName]) || 0;
      const collectionBonus = killedCount >= 50 ? 1.2 : killedCount >= 25 ? 1.1 : 1;
      const baseAtk         = Math.floor((player.atk || 10) * collectionBonus);
      const timeBonus       = elapsed <= (player.bonusTime || 5) ? 2 : 1;
      const comboBonus      = 1 + player.curCombo * ((player.comboRate || 0) / 100);
      const damage          = Math.floor(baseAtk * timeBonus * comboBonus);

      problem.monsterHp -= damage;
      result.damage      = damage;
      result.timeBonus   = timeBonus === 2;

      if (problem.monsterHp <= 0) {
        const goldReward = Math.floor(50 * (killedCount >= 50 ? 1.1 : killedCount >= 10 ? 1.05 : 1));
        const expReward  = Math.floor(20 * (1 + (player.expBonus || 0) / 100));
        player.gold      = Math.min((player.gold || 0) + goldReward, 1000000000);
        player.exp       = Math.min((player.exp  || 0) + expReward,  100000);
        player.collection = sanitizeCollection(player.collection);
        player.collection[problem.monsterName] = Math.min(killedCount + 1, 100000);

        if (player.exp >= player.maxExp && player.lv < MAX_LV) {
          player.lv    = Math.min(player.lv + 1, MAX_LV);
          player.exp   = 0;
          player.maxExp = Math.min(50 + player.lv * 5, 100000);
          player.maxHp  = Math.min((player.maxHp || 100) + 20, 500000);
          player.hp     = player.maxHp;
          result.levelUp = true;
        }

        result.monsterDefeated = true;
        result.goldReward      = goldReward;
        result.expReward       = expReward;
        activeProblems.delete(userId);
      } else {
        activeProblems.set(userId, problem);
        result.monsterHp = problem.monsterHp;
      }
    } else {
      player.curCombo = 0;
      player.hp       = (player.hp || 100) - 15;
      if (player.hp <= 0) player.hp = 30;
      activeProblems.set(userId, problem);
      result.monsterHp = problem.monsterHp;
    }

    await detectAnomalies(userId, isCorrect, elapsed);         // ✅ 이상 탐지
    await saveTrustedPlayer(userId, player);
    result.player = publicPlayer(player);
    return result;
  });

// ===== 리더보드 집계 + 30분 캐시 =====
const LEADERBOARD_TTL_MS = 30 * 60 * 1000;

async function buildAndSaveLeaderboard() {
  const today = getToday();
  const snap  = await db.ref("leaderboard").orderByChild("lv").limitToLast(1500).get();
  const all   = [];
  snap.forEach((c) => { if (c.val()?.lv) all.push(c.val()); });

  const personal = [...all].sort((a, b) => b.lv - a.lv).slice(0, 50);

  const daily = [...all]
    .filter((p) => p.lastDate === today && p.todayAns > 0)
    .sort((a, b) => b.todayAns - a.todayAns)
    .slice(0, 10);

  const schoolMap = {};
  all.forEach((p) => {
    if (p.school) schoolMap[p.school] = (schoolMap[p.school] || 0) + (p.lv || 0);
  });
  const school = Object.entries(schoolMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([name, totalLv]) => ({ school: name, totalLv }));

  await db.ref("cachedLeaderboard").set({
    personal, daily, school,
    updatedAt: Date.now(),
  });
}

exports.scheduledLeaderboard = functions
  .pubsub.schedule("every 30 minutes")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    await buildAndSaveLeaderboard();
  });

exports.buyItem = functions
  .region(REGION)
  .runWith({ maxInstances: 5, timeoutSeconds: 10, enforceAppCheck: true })
  .https.onCall(async (data) => {
    const { userId, player } = await resolvePlayerSession(data);
    const itemName = cleanName(data?.itemName, 40);
    const item     = SHOP_ITEMS.find((i) => i.name === itemName);
    if (!item) fail("없는 아이템입니다.", "not-found");

    const isBetter =
      (item.type === "w" && item.val > (player.atk       || 0)) ||
      (item.type === "a" && item.val > (player.comboRate  || 0)) ||
      (item.type === "x" && item.val > (player.bonusTime  || 0)) ||
      (item.type === "e" && item.val > (player.expBonus   || 0));
    if (!isBetter) fail("이미 더 좋은 장비를 장착 중입니다.", "failed-precondition");
    if ((player.gold || 0) < item.price) fail("골드가 부족합니다.", "failed-precondition");

    player.gold -= item.price;
    if      (item.type === "w") { player.weapon   = item.name; player.atk       = item.val; }
    else if (item.type === "a") { player.armor    = item.name; player.comboRate  = item.val; }
    else if (item.type === "x") { player.acc      = item.name; player.bonusTime  = item.val; }
    else                        { player.expItem  = item.name; player.expBonus   = item.val; }

    await saveTrustedPlayer(userId, player);
    return { player: publicPlayer(player) };
  });
