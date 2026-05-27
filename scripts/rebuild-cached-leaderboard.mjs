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
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

const snap = await db.ref("leaderboard").orderByChild("lv").limitToLast(1500).get();
const all = [];
snap.forEach((c) => {
  if (c.val()?.lv) all.push(c.val());
});

const personal = [...all].sort((a, b) => b.lv - a.lv).slice(0, 50);

const daily = [...all]
  .map((p) => ({
    ...p,
    todayAns:
      p.lastDate === today
        ? Math.min(Math.max(0, p.todayAns || 0), DAILY_LIMIT)
        : 0,
  }))
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
