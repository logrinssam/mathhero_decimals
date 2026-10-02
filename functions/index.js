const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { findBannedWord } = require("./badwords");

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
  // KST 기준 — 정답왕·오늘 정답은 매일 오전 8시에 초기화 (8시 전은 전날 집계)
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  let year = kst.getUTCFullYear();
  let month = kst.getUTCMonth();
  let day = kst.getUTCDate();
  if (kst.getUTCHours() < 8) {
    const prev = new Date(Date.UTC(year, month, day) - 86400000);
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth();
    day = prev.getUTCDate();
  }
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
  const ids = [...new Set([primaryUserId, ...candidateUserIds(rawSchool, nickname)].filter(Boolean))];
  let best = null;

  const snapshots = await Promise.all(
    ids.map(async (id) => ({ id, snap: await db.ref(`players/${id}`).get() }))
  );

  for (const { id, snap } of snapshots) {
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

// ===== 비밀번호 대입 방지 =====
// 계정별로 10분 안에 8번 틀리면 15분 잠금. 경로 authLock/<userId> 는 1·2학기가 같이 쓴다
// (2학기 첫 로그인은 1학기 비밀번호로 확인하므로, 어느 쪽에서 대입해도 같은 잠금에 걸린다).
const AUTH_FAIL_LIMIT     = 8;
const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000;
const AUTH_LOCK_MS        = 15 * 60 * 1000;

async function checkPasswordGuarded(existing, userId, password, prefetchedLock) {
  if (!existing || !(existing.pwHash || existing.pw)) return assertPassword(existing, userId, password);
  const ref  = db.ref(`authLock/${userId}`);
  // 미리 같이 읽어 둔 잠금 기록이 있으면 그걸 쓴다 (요청마다 DB 왕복 1번 절약)
  const lock = (prefetchedLock && prefetchedLock.userId === userId ? prefetchedLock.val : (await ref.get()).val()) || {};
  const now  = Date.now();
  if (lock.lockedUntil && now < lock.lockedUntil) {
    const min = Math.ceil((lock.lockedUntil - now) / 60000);
    fail(`비밀번호를 여러 번 틀려서 잠시 잠겼어요. ${min}분 뒤에 다시 해 보세요. (내 계정이 맞다면 선생님께 말해 주세요)`, "resource-exhausted");
  }
  try {
    const pw = assertPassword(existing, userId, password);
    if (lock.fails || lock.lockedUntil) await ref.remove();
    return pw;
  } catch (e) {
    if (e.code === "permission-denied") {
      const fails = [...(lock.fails || []), now].filter((t) => now - t < AUTH_FAIL_WINDOW_MS);
      await ref.set(fails.length >= AUTH_FAIL_LIMIT ? { fails: [], lockedUntil: now + AUTH_LOCK_MS } : { fails });
    }
    throw e;
  }
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
  const today = getToday();
  const lastDate = p.lastDate || today;
  return {
    lv: p.lv || 1,
    todayAns: lastDate === today ? cappedTodayAns(p) : 0,
    school: p.school || "",
    nickname: p.isSecret === false ? p.nickname || "" : maskNicknamePlain(p.nickname || ""),
    lastDate: today,
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
const MINUTE_LIMIT    = 90;                          // 1분 최대 90회
const DAILY_LIMIT     = 2000;                        // 하루 최대 2000회
const MIN_INTERVAL_MS = 400;                         // 호출 최소 간격 0.4초 (연타만 거부)

// 풀이 시간 하한(초). 서버가 문제를 낸 시각부터 답이 도착한 시각까지 (네트워크 왕복 포함).
//  HARD: 사람이 물리적으로 불가능 → 답을 받지 않고 다시 풀게 함 (벌점 없음, 10분 안에 25회면 차단)
//  SOFT: 아주 빠른 학생도 드물게만 넘는 선 → 의심 점수 계산에만 사용 (몫이 두 자리 소수인 21레벨부터만)
const HARD_FLOOR_SEC = 0.8;
const SOFT_FLOOR_SEC = 2.0;
const FAST_REJECT_BLOCK = 25;
const FAST_REJECT_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_DURATIONS = [
  60  * 60 * 1000,                                   // 1차 위반: 1시간
  6   * 60 * 60 * 1000,                              // 2차 위반: 6시간
  24  * 60 * 60 * 1000,                              // 3차 위반: 24시간
  100 * 365 * 24 * 60 * 60 * 1000,                  // 4차 이상: 영구차단
];
const BLOCK_LABELS = ["1시간", "6시간", "24시간", "영구"];
// ===== 상수 끝 =====

function assertNotMaintenanceHours() {
  const koreaHour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
  if (koreaHour >= 0 && koreaHour < 6) {
    fail("서비스 점검 시간입니다. (밤 12시~새벽 6시)", "resource-exhausted");
  }
}

function cappedTodayAns(p, maxFromRateLimit) {
  const today = getToday();
  if ((p.lastDate || "") !== today) return 0;
  let n = Math.min(Math.max(0, Math.floor(p.todayAns || 0)), DAILY_LIMIT);
  if (maxFromRateLimit != null) {
    n = Math.min(n, Math.max(0, Math.floor(maxFromRateLimit)));
  }
  return n;
}

async function syncTodayAnsWithRateLimit(userId, player) {
  const today = getToday();
  if ((player.lastDate || "") !== today) {
    player.todayAns = 0;
    player.lastDate = today;
    return player;
  }
  const rl = (await db.ref(`rateLimit/${userId}`).get()).val();
  const maxOk =
    rl && rl.dailyDate === today
      ? Math.min(Math.max(0, Math.floor(rl.dailyCount || 0)), DAILY_LIMIT)
      : 0;
  if ((player.todayAns || 0) > maxOk) {
    player.todayAns = maxOk;
  }
  return player;
}

// ===== 매크로 차단: Rate Limit (DB 저장 방식 → 서버 재시작해도 유지) =====
async function checkRateLimit(userId) {
  const now   = Date.now();
  const today = getToday();

  assertNotMaintenanceHours();

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

  // 최소 호출 간격 위반은 차단하지 않고 이번 제출만 거부한다.
  // 빠른 학생도 걸릴 수 있어, 자동화 차단은 분당 호출 수/이상 행동 탐지에 맡긴다.
  if (now - (data.lastCallTime || 0) < MIN_INTERVAL_MS) {
    fail("너무 빠릅니다. 잠깐만 천천히 눌러 주세요.", "resource-exhausted");
  }

  // 1분 윈도우 리셋
  if (now - (data.windowStart || 0) > 60 * 1000) {
    data.count       = 0;
    data.windowStart = now;
  }

  data.count++;
  data.dailyCount++;
  data.lastCallTime = now;

  // 1분 제한 초과 → 차단
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
  return data.dailyCount;
}

// ===== 이상 행동 탐지 (의심 계정 자동 기록) =====
// 자동 차단: rateLimit의 위반 횟수를 올리고 차단 시간을 건다 (1시간 → 6시간 → 24시간 → 영구)
async function applyAutoBlock(userId, reason) {
  const rlRef = db.ref(`rateLimit/${userId}`);
  const rl    = (await rlRef.get()).val() || {};
  if (rl.blockedUntil && Date.now() < rl.blockedUntil) return;
  rl.violationCount  = (rl.violationCount || 0) + 1;
  const idx          = Math.min(rl.violationCount - 1, BLOCK_DURATIONS.length - 1);
  rl.blockedUntil    = Date.now() + BLOCK_DURATIONS[idx];
  rl.lastBlockReason = reason;
  await rlRef.update(rl);
  await db.ref(`suspiciousUsers/${userId}`).update({
    autoBlockedAt: new Date().toISOString(), reason, violationCount: rl.violationCount,
  });
}

// 시간 하한(HARD_FLOOR) 위반 기록. "너무 빠른데 정답"이 10분 안에 반복되면 차단.
// 너무 빠른데 틀린 답(아이가 아무 숫자나 연타)은 거절만 하고 차단 횟수에는 세지 않는다 — 봇은 정답을 낸다.
async function recordFastReject(userId, elapsed, correct = true) {
  try {
    const ref  = db.ref(`anomaly/${userId}`);
    const data = (await ref.get()).val() || {};
    const now  = Date.now();
    const recentRejects = [...(data.fastRejectTimes || []), ...(correct ? [now] : [])].filter((t) => now - t < FAST_REJECT_WINDOW_MS).slice(-FAST_REJECT_BLOCK);
    await ref.update({
      fastRejects: (data.fastRejects || 0) + 1,
      fastWrongRejects: (data.fastWrongRejects || 0) + (correct ? 0 : 1),
      fastRejectTimes: recentRejects,
      lastFastReject: { at: now, elapsed },
    });
    if (recentRejects.length >= FAST_REJECT_BLOCK) {
      await applyAutoBlock(userId, `10분 안에 시간 하한 위반 ${recentRejects.length}회`);
      await ref.update({ fastRejectTimes: [] });
    }
  } catch (e) {
    console.error("recordFastReject error:", e);
  }
}

async function detectAnomalies(userId, isCorrect, elapsed, lv) {
  try {
    const ref  = db.ref(`anomaly/${userId}`);
    const snap = await ref.get();
    const data = snap.val() || { recentTimes: [], recent: [], correctStreak: 0, suspicionScore: 0 };

    // 최근 10개 응답시간 + 최근 20개 (시간, 정답) 기록
    data.recentTimes   = [...(data.recentTimes || []).slice(-9), elapsed];
    data.recent        = [...(data.recent || []).slice(-19), { t: Math.round(elapsed * 100) / 100, c: isCorrect ? 1 : 0, lv }];
    data.correctStreak = isCorrect ? (data.correctStreak || 0) + 1 : 0;

    let score = data.suspicionScore || 0;
    let fired = false;                               // 이번 답에서 신호가 하나라도 걸렸는지

    // 신호 1: 응답시간이 기계처럼 일정함 — 사람은 빨라도 문제마다 들쭉날쭉하다 (편차/평균 < 10%)
    if (data.recentTimes.length >= 10) {
      const avg = data.recentTimes.reduce((a, b) => a + b, 0) / data.recentTimes.length;
      const std = Math.sqrt(data.recentTimes.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / data.recentTimes.length);
      if (avg < 6 && std / avg < 0.10) { score += 2; fired = true; }
    }

    // 신호 2: (21레벨부터, 몫이 두 자리 소수) 최근 20문제 중 80% 이상이 SOFT 하한보다 빠르고 전부 정답
    //   → 23.45 ÷ 5 = 4.69 같은 문제를 2초 안에 20개 연속 다 맞히는 학생은 없다 (21레벨 이후 답만 센다)
    const hardOnes = data.recent.filter((r) => (r.lv || 0) > 20);
    if (hardOnes.length >= 20) {
      const fast = hardOnes.filter((r) => r.t < SOFT_FLOOR_SEC).length;
      const allCorrect = hardOnes.every((r) => r.c === 1);
      if (fast >= 16 && allCorrect) { score += 3; fired = true; }
    }

    // 신호 3: 1000문제 연속 정답 — 1000개 연속으로 틀리지 않는 학생은 없다
    if (data.correctStreak > 1000) { score += 1; fired = true; }

    // 감쇠: 신호가 없으면 1점, 오답이면 2점 더 깎는다 (정상 학생은 점수가 쌓이지 않는다)
    if (!fired) score = Math.max(0, score - 1);
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

    // 자동 차단: 의심점수 15점 이상 + 150연속 정답 유지 중일 때만
    // → 오답이 한 번이라도 나오면 연속정답이 풀리고 점수도 깎이므로 실제 학생은 걸리지 않는다
    if (data.suspicionScore >= 15 && data.correctStreak > 150) {
      await applyAutoBlock(userId, `의심점수 ${data.suspicionScore}, 연속정답 ${data.correctStreak}`);
      await ref.update({ suspicionScore: 0 });
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
  // 저장된 이름(userId)과 비밀번호 잠금 기록을 동시에 읽는다.
  // 로그인 때 항상 userId 로 저장하므로 거의 여기서 끝나고, 없을 때만 옛 학교 표기 후보를 더 찾는다.
  const [primarySnap, lockSnap] = await Promise.all([
    db.ref(`players/${userId}`).get(),
    db.ref(`authLock/${userId}`).get(),
  ]);
  const found = primarySnap.exists()
    ? { userId, player: primarySnap.val() }
    : await findExistingPlayer(rawSchool || school, nickname, userId);
  const existing  = found.player;
  if (!existing) fail("플레이어를 찾을 수 없습니다.", "not-found");
  const checkedPw = await checkPasswordGuarded(existing, found.userId, data?.password, { userId, val: lockSnap.val() });
  const player    = sanitizePlayer(existing, existing, school, nickname);
  if (existing.pwHash || existing.pw || checkedPw) {
    player.pwHash = passwordHash(userId, checkedPw);
  }
  // 저장된 값과 똑같으면 다시 저장할 필요가 없다 (문제 받기마다 쓰기를 줄인다)
  const unchanged = found.userId === userId && stableJson(player) === stableJson(existing);
  return { school, nickname, userId, player, unchanged };
}

function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
}

async function saveTrustedPlayer(userId, player, opts = {}) {
  const synced = opts.skipSync ? player : await syncTodayAnsWithRateLimit(userId, player);
  const updates = {};
  updates[`players/${userId}`]     = synced;
  updates[`leaderboard/${userId}`] = rankDataFor(synced);
  await db.ref().update(updates);
}

function activeProblemRef(userId) {
  return db.ref(`activeProblems/${userId}`);
}

function pickMonsterForLevel(lv) {
  const safeLv = Math.max(1, Math.floor(Number(lv) || 1));
  const available = MONSTER_DATA.filter((m) => safeLv >= m.reqLv);
  if (!available.length) return MONSTER_DATA[0];
  return available[Math.floor(Math.random() * available.length)];
}

function defaultMonsterForLevel(lv) {
  const safeLv = Math.max(1, Math.floor(Number(lv) || 1));
  const picked = pickMonsterForLevel(safeLv);
  const maxHp = 36 + safeLv * 18 + Math.floor(safeLv * safeLv * 0.012);
  return { name: picked.name, hp: maxHp, maxHp };
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
  .runWith({ maxInstances: 1000, timeoutSeconds: 30, enforceAppCheck: true })
  .https.onCall(async (data) => {
    assertNotMaintenanceHours();
    const rawSchool = data?.school;
    const school    = normalizeSchool(rawSchool);
    const nickname  = cleanName(data?.nickname, 40);
    const userId    = userIdFor(school, nickname);
    const pw        = normalizePassword(data?.password);
    const found     = await findExistingPlayer(rawSchool, nickname, userId);
    const existing  = found.player;
    const checkedPw = await checkPasswordGuarded(existing, found.userId, pw);

    let player;
    let isNew = false;
    if (existing) {
      player = sanitizePlayer(existing, existing, school, nickname);
    } else {
      if (findBannedWord(nickname) || findBannedWord(school)) {
        fail("😥 욕설이나 나쁜 말이 들어간 닉네임은 쓸 수 없어요. 다른 닉네임으로 정해 주세요.");
      }
      player = defaultPlayer(school, nickname);
      isNew  = true;
    }

    if (checkedPw) player.pwHash = passwordHash(userId, checkedPw);
    if (existing?.pw) player.pw  = null;
    await saveTrustedPlayer(userId, player);
    player = (await db.ref(`players/${userId}`).get()).val();

    return { player: publicPlayer(player), isNew, locked: Boolean(player.pwHash) };
  });

exports.savePlayer = functions
  .region(REGION)
  .runWith({ maxInstances: 1000, timeoutSeconds: 30, enforceAppCheck: true })
  .https.onCall(async (data) => {
    const rawPlayer = data?.player;
    if (!rawPlayer || typeof rawPlayer !== "object") fail("저장할 데이터가 없습니다.");

    const rawSchool = rawPlayer.school;
    const school    = normalizeSchool(rawSchool);
    const nickname  = cleanName(rawPlayer.nickname, 40);
    const userId    = userIdFor(school, nickname);
    const found     = await findExistingPlayer(rawSchool, nickname, userId);
    const existing  = found.player;
    const checkedPw = await checkPasswordGuarded(existing, found.userId, data?.password);
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
  .runWith({ maxInstances: 1000, timeoutSeconds: 30, enforceAppCheck: true })
  .https.onCall(async (data) => {
    assertNotMaintenanceHours();
    const { userId, player, unchanged } = await resolvePlayerSession(data);
    if (!unchanged) await saveTrustedPlayer(userId, player);   // 날짜가 바뀌는 등 달라졌을 때만 저장

    const lv       = player.lv || 1;
    const problemRef = activeProblemRef(userId);
    const existing = (await problemRef.get()).val();
    let monster;
    if (existing && existing.monsterHp > 0) {
      const fallback = defaultMonsterForLevel(lv);
      monster = {
        name:  existing.monsterName || fallback.name,
        hp:    existing.monsterHp,
        maxHp: existing.monsterMaxHp || fallback.maxHp,
      };
    } else {
      monster = defaultMonsterForLevel(lv);
    }
    if (!monster?.name) monster = defaultMonsterForLevel(lv);

    const problem = makeProblemForLevel(lv);
    await problemRef.set({
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
  .runWith({ maxInstances: 1000, timeoutSeconds: 30, enforceAppCheck: true })
  .https.onCall(async (data, context) => {                    // ✅ context 추가
    const { userId, player } = await resolvePlayerSession(data);

    const rawAnswer = String(data?.answer ?? "").trim();
    if (!/^-?\d*\.?\d+$/.test(rawAnswer)) fail("잘못된 답입니다.");
    const userAnswer = Number.parseFloat(rawAnswer);
    if (!Number.isFinite(userAnswer) || Math.abs(userAnswer) > 10000) {
      fail("잘못된 답입니다.");
    }

    const now = Date.now();

    const problemRef = activeProblemRef(userId);
    const problemSnapPromise = problemRef.get();
    const dailyCount = await checkRateLimit(userId);
    const problem = (await problemSnapPromise).val();
    // 한 문제에는 한 번만 답할 수 있다 (오답에서 받은 정답을 같은 문제에 다시 내는 것 방지)
    if (!problem || problem.answered) fail("문제를 먼저 받아 주세요.", "not-found");

    const elapsed   = (now - problem.createdAt) / 1000;
    if (elapsed < HARD_FLOOR_SEC) {
      // 사람이 읽고 입력할 수 없는 시간 → 답을 받지 않는다 (벌점 없음). 같은 문제를 다시 풀면 된다.
      await recordFastReject(userId, elapsed, Math.abs(userAnswer - problem.answer) < 0.001);
      fail("⚡ 너무 빨라요! 문제를 잘 읽고 다시 풀어 보세요.", "resource-exhausted");
    }

    const isCorrect = Math.abs(userAnswer - problem.answer) < 0.001;
    const result    = { correct: isCorrect, correctAnswer: problem.answer };
    problem.answered = true;           // 몬스터 체력은 남기고 문제만 닫는다 → 다음 getProblem 이 새 문제를 낸다
    let problemWritePromise;

    if (isCorrect) {
      player.curCombo  = (player.curCombo || 0) + 1;
      player.todayAns  = Math.min((player.todayAns || 0) + 1, dailyCount, DAILY_LIMIT);
      player.lastDate  = getToday();

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
        problemWritePromise    = problemRef.remove();
      } else {
        problemWritePromise = problemRef.set(problem);
        result.monsterHp = problem.monsterHp;
      }
    } else {
      player.curCombo = 0;
      player.hp       = (player.hp || 100) - 15;
      if (player.hp <= 0) player.hp = 30;
      problemWritePromise = problemRef.set(problem);
      result.monsterHp = problem.monsterHp;
    }

    await Promise.all([
      problemWritePromise,
      detectAnomalies(userId, isCorrect, elapsed, player.lv || 1), // ✅ 이상 탐지
      saveTrustedPlayer(userId, player, { skipSync: true }),
    ]);
    result.player = publicPlayer(player);
    return result;
  });

// ===== 리더보드 집계 + 10분 캐시 =====
const LEADERBOARD_TTL_MS = 10 * 60 * 1000;

async function buildAndSaveLeaderboard() {
  const today = getToday();
  const [lbSnap, rlSnap] = await Promise.all([
    db.ref("leaderboard").orderByChild("lv").limitToLast(1500).get(),
    db.ref("rateLimit").get(),
  ]);
  const rateMap = rlSnap.val() || {};
  const all = [];
  lbSnap.forEach((c) => {
    if (c.val()?.lv) all.push({ ...c.val(), uid: c.key });
  });

  const personal = [...all]
    .map(({ uid, ...p }) => p)
    .sort((a, b) => b.lv - a.lv)
    .slice(0, 50);

  const daily = [...all]
    .map((p) => {
      const rl = rateMap[p.uid];
      const maxOk =
        rl && rl.dailyDate === today
          ? Math.min(Math.max(0, Math.floor(rl.dailyCount || 0)), DAILY_LIMIT)
          : 0;
      const todayAns =
        p.lastDate === today ? Math.min(p.todayAns || 0, maxOk, DAILY_LIMIT) : 0;
      const { uid, ...rest } = p;
      return { ...rest, todayAns, lastDate: p.lastDate === today ? today : p.lastDate };
    })
    .filter((p) => p.lastDate === today && p.todayAns > 0 && p.todayAns <= DAILY_LIMIT)
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
  .pubsub.schedule("every 10 minutes")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    await buildAndSaveLeaderboard();
  });

exports.buyItem = functions
  .region(REGION)
  .runWith({ maxInstances: 1000, timeoutSeconds: 30, enforceAppCheck: true })
  .https.onCall(async (data) => {
    assertNotMaintenanceHours();
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

// ===== 히든 보상 코드 (2학기 「소수의 나눗셈 용사 Ⅱ」에서 쓰는 코드 발급) =====
// 조건: 1학기 LV 10 이상. 학생 한 명에 코드 하나 (다시 눌러도 같은 코드).
// 저장: rewardCodes/<1학기 userId> = { code, tier, lv, issuedAt, claimedAt? }, rewardCodeIndex/<code> = userId
// 등급은 아직 2학기에서 쓰지 않았다면 다시 눌렀을 때 현재 레벨로 올라갈 수 있다.
const REWARD_TIERS = [
  { tier: 4, minLv: 200, label: "🏆 전설 등급" },
  { tier: 3, minLv: 100, label: "🥇 금 등급" },
  { tier: 2, minLv: 30,  label: "🥈 은 등급" },
  { tier: 1, minLv: 10,  label: "🥉 동 등급" },
];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 헷갈리는 I, O, 0, 1 제외

function rewardTierForLevel(lv) {
  return REWARD_TIERS.find((t) => lv >= t.minLv) || null;
}

function makeRewardCode() {
  const bytes = crypto.randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `HERO-${s.slice(0, 4)}-${s.slice(4)}`;
}

exports.getHiddenReward = functions
  .region(REGION)
  .runWith({ maxInstances: 1000, timeoutSeconds: 30, enforceAppCheck: true })
  .https.onCall(async (data) => {
    assertNotMaintenanceHours();
    const { userId, player } = await resolvePlayerSession(data);
    const lv   = player.lv || 1;
    const tier = rewardTierForLevel(lv);
    if (!tier) {
      fail(`히든 보상은 LV 10부터 열려요! (지금 LV ${lv}) 조금만 더 힘내요 💪`, "failed-precondition");
    }

    const ref = db.ref(`rewardCodes/${userId}`);
    const existing = (await ref.get()).val();

    if (existing && existing.code) {
      // 이미 발급됨: 아직 안 썼고 등급이 올라갔으면 등급만 갱신
      if (!existing.claimedAt && tier.tier > (existing.tier || 0)) {
        await ref.update({ tier: tier.tier, lv, upgradedAt: Date.now() });
        return { code: existing.code, tier: tier.tier, label: tier.label, lv, upgraded: true, claimed: false };
      }
      const t = REWARD_TIERS.find((x) => x.tier === existing.tier) || tier;
      // 이미 쓴 코드면 발급 당시 레벨, 아직 안 썼으면 지금 레벨을 보여 준다
      return { code: existing.code, tier: t.tier, label: t.label, lv: existing.claimedAt ? existing.lv : lv, claimed: Boolean(existing.claimedAt) };
    }

    // 새 코드 발급 (중복이면 다시 뽑는다)
    let code;
    for (let i = 0; i < 10; i++) {
      code = makeRewardCode();
      if (!(await db.ref(`rewardCodeIndex/${code}`).get()).exists()) break;
      code = null;
    }
    if (!code) fail("코드를 만들지 못했어요. 잠시 후 다시 시도해 주세요.", "internal");

    // 버튼을 두 번 빨리 눌러도 코드가 하나만 생기도록 트랜잭션으로 "처음 쓴 쪽"만 남긴다
    const record = { code, tier: tier.tier, lv, issuedAt: Date.now(), school: player.school, nickname: player.nickname };
    const tx = await ref.transaction((cur) => (cur && cur.code ? undefined : record));
    if (!tx.committed) {
      const won = tx.snapshot.val();
      const t = REWARD_TIERS.find((x) => x.tier === won.tier) || tier;
      return { code: won.code, tier: t.tier, label: t.label, lv, claimed: Boolean(won.claimedAt) };
    }
    await db.ref(`rewardCodeIndex/${code}`).set(userId);
    return { code, tier: tier.tier, label: tier.label, lv, claimed: false, isNew: true };
  });
