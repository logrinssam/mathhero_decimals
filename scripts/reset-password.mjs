/**
 * 특정 학생 계정의 비밀번호 잠금 해제
 *
 * 사용:
 *   npm.cmd run reset-password -- "고운초" "안연서"
 *   npm.cmd run reset-password -- "고운초" "안연서" "abcd1234"
 *
 * 세 번째 값을 넣으면 새 비밀번호로 초기화하고, 안 넣으면 비밀번호를 제거합니다.
 */
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const [, , rawSchool, rawNickname, newPassword = ""] = process.argv;

if (!rawSchool || !rawNickname) {
  console.error('사용: npm.cmd run reset-password -- "학교" "닉네임" ["새비번"]');
  process.exit(1);
}

const keyPath = existsSync("scripts/serviceAccountKey.json")
  ? "scripts/serviceAccountKey.json"
  : "scripts/serviceAccountkey.json";

if (!existsSync(keyPath)) {
  console.error("scripts/serviceAccountKey.json 필요");
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
initializeApp({
  credential: cert(serviceAccount),
  databaseURL:
    "https://division-of-fractions-default-rtdb.asia-southeast1.firebasedatabase.app",
});

const db = getDatabase();

function normalizeSchool(raw) {
  let school = String(raw || "").trim().replace(/\s+/g, "");
  if (!school) return "";
  if (school.endsWith("초")) school += "등학교";
  else if (!school.endsWith("초등학교")) school += "초등학교";
  return school;
}

function schoolCore(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/초등학교$/, "")
    .replace(/초$/, "");
}

function passwordHash(userId, password) {
  return crypto
    .createHash("sha256")
    .update(`${userId}:${String(password || "")}`, "utf8")
    .digest("hex");
}

if (newPassword && !/^[A-Za-z0-9]{4,12}$/.test(newPassword)) {
  console.error("새 비밀번호는 영문/숫자 4~12자만 가능합니다.");
  process.exit(1);
}

const normalizedSchool = normalizeSchool(rawSchool);
const nickname = String(rawNickname || "").trim();
const targetCore = schoolCore(normalizedSchool);
const snap = await db.ref("players").get();
const matches = [];

snap.forEach((child) => {
  const key = child.key || "";
  const p = child.val() || {};
  const school = String(p.school || "");
  const nick = String(p.nickname || "");
  const keyMatches = key.includes(nickname) && key.includes(targetCore);
  const fieldMatches = nick === nickname && schoolCore(school).includes(targetCore);
  if (keyMatches || fieldMatches) {
    matches.push({ key, player: p });
  }
});

if (!matches.length) {
  console.error(`계정을 찾지 못했습니다: ${normalizedSchool}-${nickname}`);
  process.exit(1);
}

matches.sort((a, b) => (b.player.lv || 0) - (a.player.lv || 0));
const target = matches[0];
const updates = {};

if (newPassword) {
  updates[`players/${target.key}/pwHash`] = passwordHash(target.key, newPassword);
  updates[`players/${target.key}/pw`] = null;
} else {
  updates[`players/${target.key}/pwHash`] = null;
  updates[`players/${target.key}/pw`] = null;
}

await db.ref().update(updates);

console.log(
  JSON.stringify(
    {
      action: newPassword ? "password-reset" : "password-removed",
      key: target.key,
      school: target.player.school,
      nickname: target.player.nickname,
      lv: target.player.lv || 0,
      matchedCount: matches.length,
    },
    null,
    2
  )
);
