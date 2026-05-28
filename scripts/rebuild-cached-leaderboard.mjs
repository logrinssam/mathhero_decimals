/**
 * cachedLeaderboard 즉시 재집계 (정답왕 TOP10 반영)
 *   node scripts/rebuild-cached-leaderboard.mjs
 */
import { readFileSync, existsSync } from "fs";
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

await db.ref("cachedLeaderboard").set({
  personal,
  daily,
  school,
  updatedAt: Date.now(),
});

console.log("✅ cachedLeaderboard 재집계 완료");
console.log("   오늘:", today);
console.log("   정답왕 TOP:", daily.map((p, i) => `${i + 1}. ${p.nickname} ${p.todayAns}`).join(", ") || "(없음)");
