/**
 * 치트/이상 계정 경로 찾기 (콘솔에서 안 보일 때)
 * npm.cmd run find-suspicious
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, "serviceAccountKey.json");

if (!existsSync(keyPath)) {
  console.error("❌ scripts/serviceAccountKey.json 필요");
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
initializeApp({
  credential: cert(serviceAccount),
  databaseURL:
    "https://division-of-fractions-default-rtdb.asia-southeast1.firebasedatabase.app",
});

const BANNED = /운영자|관리자|관리자환영|운영자환영|^gm$|^admin$|치트|hack/i;
const TODAY_WARN = 500;
const TODAY_DANGER = 1000;

const db = getDatabase();
const [lbSnap, plSnap, anomalySnap, suspiciousSnap, rateLimitSnap] = await Promise.all([
  db.ref("leaderboard").get(),
  db.ref("players").get(),
  db.ref("anomaly").get(),
  db.ref("suspiciousUsers").get(),
  db.ref("rateLimit").get(),
]);

function getToday() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function childValue(snap, id) {
  return snap.child(id).val() || {};
}

function isBlocked(rateLimit) {
  return Number(rateLimit.blockedUntil || 0) > Date.now();
}

function blockLabel(rateLimit) {
  if (!isBlocked(rateLimit)) return "";
  const leftMin = Math.ceil((rateLimit.blockedUntil - Date.now()) / 60000);
  return `${leftMin}분 남음 / 위반 ${rateLimit.violationCount || 0}회`;
}

function check(id, p, where) {
  if (!p || typeof p !== "object") return;
  const lv = p.lv || 0;
  const todayAns = p.lastDate === today ? p.todayAns || 0 : 0;
  const nick = String(p.nickname || "");
  const school = String(p.school || "");
  const anomaly = childValue(anomalySnap, id);
  const suspicious = childValue(suspiciousSnap, id);
  const rateLimit = childValue(rateLimitSnap, id);
  const cheatLv = lv > 2000; // 2000 초과만 의심 (987 등 정상)
  const cheatNick = BANNED.test(nick) || BANNED.test(school) || BANNED.test(id);
  const cheatBrackets = /\[.*운영자|운영자.*\]/.test(nick + id);
  const manyToday = todayAns >= TODAY_WARN;
  const dangerToday = todayAns >= TODAY_DANGER;
  const anomalyScore = Number(anomaly.suspicionScore || suspicious.score || 0);
  const anomalyHit = anomalyScore >= 10 || Number(anomaly.correctStreak || 0) > 500;
  const blocked = isBlocked(rateLimit);

  if (cheatLv || cheatNick || cheatBrackets || manyToday || anomalyHit || blocked) {
    const reasons = [];
    if (dangerToday) reasons.push(`오늘 ${todayAns}개 이상`);
    else if (manyToday) reasons.push(`오늘 ${todayAns}개`);
    if (anomalyHit) reasons.push(`의심점수 ${anomalyScore}, 연속정답 ${anomaly.correctStreak || 0}`);
    if (blocked) reasons.push(`차단중(${blockLabel(rateLimit)})`);
    if (cheatLv) reasons.push(`레벨 ${lv}`);
    if (cheatNick || cheatBrackets) reasons.push("금지어/사칭 닉네임");

    console.log(`\n[${where}] 키: ${id}`);
    console.log(`  school: ${school}`);
    console.log(`  nickname: ${nick}`);
    console.log(`  lv: ${lv}`);
    console.log(`  todayAns: ${todayAns} (${p.lastDate || "날짜없음"})`);
    console.log(`  suspicionScore: ${anomalyScore}`);
    console.log(`  correctStreak: ${anomaly.correctStreak || 0}`);
    console.log(`  blocked: ${blocked ? blockLabel(rateLimit) : "아님"}`);
    console.log(`  reason: ${reasons.join(", ")}`);
    console.log(`  → 확인 후, 진짜 치트만 삭제`);
  }
}

const today = getToday();
console.log(`=== leaderboard / players / anomaly / rateLimit 검색 (${today} KST) ===\n`);
lbSnap.forEach((c) => check(c.key, c.val(), "leaderboard"));
plSnap.forEach((c) => check(c.key, c.val(), "players"));

const topToday = [];
lbSnap.forEach((c) => {
  const p = c.val();
  if (p?.lastDate === today && (p.todayAns || 0) > 0) {
    topToday.push({ id: c.key, ...p });
  }
});

topToday
  .sort((a, b) => (b.todayAns || 0) - (a.todayAns || 0))
  .slice(0, 20)
  .forEach((p, idx) => {
    if (idx === 0) console.log("\n=== 오늘 문제 수 TOP 20 ===");
    const anomaly = childValue(anomalySnap, p.id);
    const rateLimit = childValue(rateLimitSnap, p.id);
    console.log(
      `${String(idx + 1).padStart(2, "0")}. ${p.school || ""} / ${p.nickname || ""} / ${p.todayAns || 0}개` +
        ` / 의심점수 ${anomaly.suspicionScore || 0}` +
        ` / 연속정답 ${anomaly.correctStreak || 0}` +
        ` / 차단 ${isBlocked(rateLimit) ? "예" : "아니오"}`
    );
  });

console.log("\n끝. 위 목록이 정상 학생이면 삭제하지 마세요.");
console.log(`오늘 ${TODAY_WARN}개 이상은 확인 대상, ${TODAY_DANGER}개 이상은 강한 확인 대상으로 표시됩니다.`);
process.exit(0);
