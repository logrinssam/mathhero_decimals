/**
 * players/ 전체 → leaderboard/ 일괄 복구 (한 번만)
 *
 * 방법 A — 서비스 계정 (권장)
 *   Firebase 콘솔 → 서비스 계정 → 비공개 키 → scripts/serviceAccountKey.json
 *   npm install && npm run backfill-leaderboard
 *
 * 방법 B — 이미 받아 둔 players JSON
 *   npm run backfill-leaderboard -- --from-export scripts/players-export.json
 */
import { readFileSync, existsSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = "division-of-fractions";
const DATABASE_URL =
  "https://division-of-fractions-default-rtdb.asia-southeast1.firebasedatabase.app";

const args = process.argv.slice(2);
const fromExportIdx = args.indexOf("--from-export");
const fromExportPath =
  fromExportIdx >= 0 ? path.resolve(args[fromExportIdx + 1]) : null;
const dryRun = args.includes("--dry-run");

function maskNickname(nickname) {
  const n = String(nickname || "");
  if (n.length <= 2) return n.length ? n[0] + "★" : "★";
  return n[0] + "★".repeat(n.length - 2) + n[n.length - 1];
}

function toRankEntry(p) {
  const isSecret = p.isSecret !== false;
  return {
    lv: Math.min(9999, Math.max(1, Math.floor(p.lv || 1))),
    school: String(p.school || "").slice(0, 80),
    nickname: isSecret
      ? maskNickname(p.nickname)
      : String(p.nickname || "").slice(0, 40),
    todayAns: Math.max(0, Math.floor(p.todayAns || 0)),
    lastDate: String(p.lastDate || ""),
    isSecret,
  };
}

function buildLeaderboardFromPlayers(playersObj, existingBoard = {}) {
  const leaderboard = { ...existingBoard };
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const [id, p] of Object.entries(playersObj || {})) {
    if (!p?.school || !p?.nickname) {
      skipped++;
      continue;
    }
    const next = toRankEntry(p);
    const existing = leaderboard[id];
    if (existing?.lv) {
      next.lv = Math.max(existing.lv, next.lv);
      next.todayAns = Math.max(existing.todayAns || 0, next.todayAns);
    }
    if (!existing) created++;
    else updated++;
    leaderboard[id] = next;
  }

  return { leaderboard, created, updated, skipped };
}

async function loadPlayersAndBoard(db) {
  const [playersSnap, boardSnap] = await Promise.all([
    db.ref("players").get(),
    db.ref("leaderboard").get(),
  ]);
  const players = playersSnap.val() || {};
  const existingBoard = boardSnap.val() || {};
  return { players, existingBoard };
}

async function writeLeaderboard(db, leaderboard) {
  const ids = Object.keys(leaderboard);
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = {};
    ids.slice(i, i + CHUNK).forEach((id) => {
      batch[id] = leaderboard[id];
    });
    await db.ref("leaderboard").update(batch);
    console.log(`  … ${Math.min(i + CHUNK, ids.length)} / ${ids.length}`);
  }
}

// --- players JSON 파일만 있을 때
if (fromExportPath) {
  if (!existsSync(fromExportPath)) {
    console.error("❌ 파일 없음:", fromExportPath);
    process.exit(1);
  }
  const players = JSON.parse(readFileSync(fromExportPath, "utf8"));
  const { leaderboard, created, updated, skipped } =
    buildLeaderboardFromPlayers(players);

  const outPath = path.join(__dirname, "leaderboard-upload.json");
  writeFileSync(outPath, JSON.stringify({ leaderboard }, null, 2), "utf8");

  console.log(`players ${Object.keys(players).length}명 → leaderboard ${Object.keys(leaderboard).length}명`);
  console.log(`신규 ${created}, 갱신 ${updated}, 건너뜀 ${skipped}`);
  console.log("저장:", outPath);

  if (dryRun) {
    console.log("--dry-run: Firebase에는 쓰지 않았습니다.");
    process.exit(0);
  }

  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(__dirname, "serviceAccountKey.json");
  if (!existsSync(keyPath)) {
    console.log("\nFirebase에 올리려면 serviceAccountKey.json 넣고 다시 실행하거나:");
    console.log("  npm run backfill-leaderboard");
    process.exit(0);
  }

  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getDatabase } = await import("firebase-admin/database");
  const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: DATABASE_URL,
  });
  const db = getDatabase();
  console.log("\nFirebase leaderboard 업로드 중…");
  await writeLeaderboard(db, leaderboard);
  console.log("✅ 완료 — 게임 랭킹 새로고침");
  process.exit(0);
}

// --- Admin SDK로 players 직접 읽기
const keyPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, "serviceAccountKey.json");

if (!existsSync(keyPath)) {
  console.error("❌ scripts/serviceAccountKey.json 이 필요합니다.\n");
  console.error("1) https://console.firebase.google.com → division-of-fractions");
  console.error("2) ⚙ 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성");
  console.error("3) JSON을 scripts/serviceAccountKey.json 으로 저장");
  console.error("4) npm install");
  console.error("5) npm run backfill-leaderboard\n");
  console.error("또는 players 백업 JSON이 있으면:");
  console.error("  npm run backfill-leaderboard -- --from-export 경로/players.json");
  process.exit(1);
}

const { initializeApp, cert } = await import("firebase-admin/app");
const { getDatabase } = await import("firebase-admin/database");

const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: DATABASE_URL,
});

const db = getDatabase();
console.log("players 전체 읽는 중…");
const { players, existingBoard } = await loadPlayersAndBoard(db);
const playerCount = Object.keys(players).length;
console.log(`  players: ${playerCount}명`);

const { leaderboard, created, updated, skipped } = buildLeaderboardFromPlayers(
  players,
  existingBoard
);

if (Object.keys(leaderboard).length === 0) {
  console.log("옮길 데이터가 없습니다.");
  process.exit(0);
}

console.log(
  `leaderboard ${Object.keys(leaderboard).length}명 (신규 ${created}, 갱신 ${updated}, 건너뜀 ${skipped})`
);

if (dryRun) {
  console.log("--dry-run 종료");
  process.exit(0);
}

console.log("Firebase leaderboard 업로드 중…");
await writeLeaderboard(db, leaderboard);
console.log("✅ 기존 players 전원 반영 완료 — 게임에서 랭킹 탭 새로고침");
