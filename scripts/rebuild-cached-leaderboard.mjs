/**
 * cachedLeaderboard + cachedSchoolRank(교내 순위) 즉시 재집계 (정답왕 TOP10 반영)
 *   node scripts/rebuild-cached-leaderboard.mjs
 */
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL =
  "https://division-of-fractions-default-rtdb.asia-southeast1.firebasedatabase.app";
const DAILY_LIMIT = 2000;

function getToday() {
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

const keyPath = [
  path.join(__dirname, "serviceAccountKey.json"),
  path.join(__dirname, "serviceAccountkey.json"),
].find((p) => existsSync(p));

if (!keyPath) {
  console.error("scripts/serviceAccountKey.json 이 필요합니다.");
  process.exit(1);
}

const { initializeApp, cert } = await import("firebase-admin/app");
const { getDatabase } = await import("firebase-admin/database");

initializeApp({
  credential: cert(JSON.parse(readFileSync(keyPath, "utf8"))),
  databaseURL: DATABASE_URL,
});

// ===== 교내 순위 (학교별 용사 목록) =====
// 내 줄을 찾기 위한 짧은 식별 태그: 닉네임을 드러내지 않도록 uid(학교-닉네임)의 해시 앞 8자리만 쓴다
function schoolRankTag(uid) {
  return crypto.createHash("sha256").update(String(uid)).digest("hex").slice(0, 8);
}

// 학교별로 묶어 레벨순 정렬. 같은 레벨은 공동 순위(1, 2, 2, 4). 입력은 leaderboard 항목(uid 포함).
// 결과는 cachedSchoolRank/{학교명} 아래에 저장되고, 클라이언트는 자기 학교 것만 읽는다.
function buildSchoolRank(all) {
  const bySchool = {};
  for (const p of all) {
    const name = String(p.school || "");
    if (!name || /[.#$\[\]/\\]/.test(name)) continue; // DB 키로 쓸 수 없는 이름은 건너뛴다
    if (!bySchool[name]) bySchool[name] = [];
    bySchool[name].push({ tag: schoolRankTag(p.uid), nickname: p.nickname || "", lv: p.lv || 1 });
  }
  const out = {};
  const now = Date.now();
  for (const [name, list] of Object.entries(bySchool)) {
    list.sort((a, b) => b.lv - a.lv || a.nickname.localeCompare(b.nickname, "ko"));
    let rank = 0;
    const members = list.map((m, i) => {
      if (i === 0 || m.lv !== list[i - 1].lv) rank = i + 1;
      return { ...m, rank };
    });
    out[name] = { members, count: members.length, updatedAt: now };
  }
  return out;
}

const db = getDatabase();
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
    return { ...rest, todayAns };
  })
  .filter(
    (p) => p.lastDate === today && p.todayAns > 0 && p.todayAns <= DAILY_LIMIT
  )
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

const schoolRank = buildSchoolRank(all);

await Promise.all([
  db.ref("cachedLeaderboard").set({
    personal,
    daily,
    school,
    updatedAt: Date.now(),
  }),
  db.ref("cachedSchoolRank").set(schoolRank),
]);

console.log("✅ cachedLeaderboard / cachedSchoolRank 재집계 완료");
console.log("   교내 순위 학교 수:", Object.keys(schoolRank).length);
console.log("   오늘:", today);
console.log("   정답왕 TOP:", daily.map((p, i) => `${i + 1}. ${p.nickname} ${p.todayAns}`).join(", ") || "(없음)");
