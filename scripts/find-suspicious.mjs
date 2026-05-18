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

const db = getDatabase();
const [lbSnap, plSnap] = await Promise.all([
  db.ref("leaderboard").get(),
  db.ref("players").get(),
]);

function check(id, p, where) {
  if (!p || typeof p !== "object") return;
  const lv = p.lv || 0;
  const nick = String(p.nickname || "");
  const school = String(p.school || "");
 const cheatLv = lv > 2000; // 2000 초과만 의심 (987 등 정상)
  const cheatNick = BANNED.test(nick) || BANNED.test(school) || BANNED.test(id);
  const cheatBrackets = /\[.*운영자|운영자.*\]/.test(nick + id);
  if (cheatLv || cheatNick || cheatBrackets) {
    console.log(`\n[${where}] 키: ${id}`);
    console.log(`  school: ${school}`);
    console.log(`  nickname: ${nick}`);
    console.log(`  lv: ${lv}`);
    console.log(`  → 확인 후, 진짜 치트만 삭제`);
  }
}

console.log("=== leaderboard / players 검색 ===\n");
lbSnap.forEach((c) => check(c.key, c.val(), "leaderboard"));
plSnap.forEach((c) => check(c.key, c.val(), "players"));
console.log("\n끝. 위 목록이 정상 학생이면 삭제하지 마세요.");
console.log("게임에 '[운영자환영] LV.9999' 만 보이면 그 키만 지우면 됩니다.");
