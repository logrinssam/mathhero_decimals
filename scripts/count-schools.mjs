/**
 * 사용 중인 초등학교 개수 (비슷한 이름 묶기)
 * npm.cmd run count-schools
 */
import { readFileSync, existsSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  [path.join(__dirname, "serviceAccountKey.json"), path.join(__dirname, "serviceAccountkey.json")].find(
    (p) => existsSync(p)
  );

if (!keyPath) {
  console.error("❌ scripts/serviceAccountKey.json 필요");
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
initializeApp({
  credential: cert(serviceAccount),
  databaseURL:
    "https://division-of-fractions-default-rtdb.asia-southeast1.firebasedatabase.app",
});

const REGION_PREFIXES = [
  "전주교육대학교",
  "필리핀한국국제학교",
  "인천광역시",
  "영등포고등학교",
  "정천중학교",
  "상록중",
  "서울",
  "부산",
  "대구",
  "인천",
  "광주",
  "대전",
  "울산",
  "세종",
  "경기",
  "강원",
  "충북",
  "충남",
  "전북",
  "전남",
  "경북",
  "경남",
  "제주",
  "성남",
  "수원",
  "용인",
  "고양",
  "부천",
  "김포",
  "안산",
  "안양",
  "시흥",
  "남양주",
  "의정부",
  "하남",
  "평택",
  "화성",
  "광명",
  "군포",
  "이천",
  "구미",
  "김해",
  "창원",
  "포항",
  "청주",
  "천안",
  "전주",
  "목포",
  "여수",
  "통영",
  "거제",
  "익산",
  "군산",
  "나주",
  "당진",
  "오산",
  "양주",
  "충주",
  "원주",
  "익산",
  "무안",
  "김포",
  "광양",
  "시흥",
  "하남시",
].sort((a, b) => b.length - a.length);

const SUFFIX_PATTERNS = [
  /초등학교에초등학교$/,
  /초등학생초등학교$/,
  /초등초등학교$/,
  /초등하교초등학교$/,
  /초등핚교초등학교$/,
  /초등헉교초등학교$/,
  /초등초등$/,
  /초등학초등학교$/,
  /드학교초등학교$/,
  /학교초등학교$/,
  /초동학교초등학교$/,
  /초들학교초등학교$/,
  /초드학교초등학교$/,
  /등학교초등학교$/,
  /초등학교$/,
  /초등하교$/,
  /초등핚교$/,
  /초등헉교$/,
  /등학교$/,
  /초등$/,
  /초$/,
];

function compactSchool(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, "");
}

function stripSuffixes(s) {
  let t = s;
  let prev;
  do {
    prev = t;
    for (const re of SUFFIX_PATTERNS) {
      t = t.replace(re, "");
    }
  } while (t !== prev && t.length > 0);
  return t;
}

function stripRegionPrefix(s) {
  for (const p of REGION_PREFIXES) {
    if (s.startsWith(p) && s.length > p.length + 1) {
      return s.slice(p.length);
    }
  }
  return s;
}

function schoolBase(name) {
  const c = compactSchool(name);
  const core = stripSuffixes(c);
  return core.length >= 2 ? core : c;
}

function isJunkSchool(name) {
  const c = compactSchool(name);
  if (!c || c.length < 2) return true;
  if (/[<>"'`\\]/.test(c)) return true;
  if (/^[-?;.,!@#$%^&*()[\]{}|\\/]+$/.test(c)) return true;
  if (/^[ㄱ-ㅎㅏ-ㅣ]+$/.test(c)) return true;
  if (/^(test_school|테스트|크롤링|halfcircle|universityofcambridge)/i.test(c)) return true;
  if (/똥|시발|니엄마|사탄들|소수의나눗셈용사초딩|오징어게임|찢재명/i.test(c)) return true;
  if (c.length > 60) return true;
  const b = schoolBase(c);
  if (b.length < 2) return true;
  if (!/[가-힣]/.test(b) && b.length < 4) return true;
  return false;
}

class UnionFind {
  constructor(items) {
    this.parent = new Map(items.map((x) => [x, x]));
  }
  find(x) {
    let p = this.parent.get(x);
    while (p !== this.parent.get(p)) {
      this.parent.set(x, this.parent.get(p));
      p = this.parent.get(x);
    }
    return p;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function pickRepresentative(aliases, accountByRaw) {
  const score = (name) => {
    let s = 0;
    if (name.includes("초등학교")) s += 50;
    else if (name.endsWith("초")) s += 20;
    s += accountByRaw.get(name) || 0;
    s += Math.min(name.length, 40);
    if (/초등하교|초등핚|드학교|꼴통|똥|시발/i.test(name)) s -= 100;
    return s;
  };
  return [...aliases].sort((a, b) => score(b) - score(a))[0];
}

const db = getDatabase();
const [plSnap, lbSnap] = await Promise.all([
  db.ref("players").get(),
  db.ref("leaderboard").get(),
]);

const accountByRaw = new Map();
function addAccounts(snap) {
  snap.forEach((child) => {
    const s = String(child.val()?.school || "").trim();
    if (!s) return;
    accountByRaw.set(s, (accountByRaw.get(s) || 0) + 1);
  });
}
addAccounts(plSnap);
addAccounts(lbSnap);

const allRaw = new Set(accountByRaw.keys());
const junk = [];
const real = [];

for (const name of allRaw) {
  if (isJunkSchool(name)) junk.push(name);
  else real.push(name);
}

const uf = new UnionFind(real);
const baseToRaw = new Map();

for (const raw of real) {
  const bases = new Set([schoolBase(raw), stripRegionPrefix(schoolBase(raw))].filter(Boolean));
  for (const b of bases) {
    if (!baseToRaw.has(b)) baseToRaw.set(b, []);
    baseToRaw.get(b).push(raw);
  }
}

for (const raws of baseToRaw.values()) {
  for (let i = 1; i < raws.length; i++) uf.union(raws[0], raws[i]);
}

const groupsMap = new Map();
for (const raw of real) {
  const root = uf.find(raw);
  if (!groupsMap.has(root)) groupsMap.set(root, new Set());
  groupsMap.get(root).add(raw);
}

const groups = [...groupsMap.values()]
  .map((aliasSet) => {
    const aliases = [...aliasSet].sort((a, b) => a.localeCompare(b, "ko"));
    const accounts = aliases.reduce((sum, a) => sum + (accountByRaw.get(a) || 0), 0);
    return {
      representative: pickRepresentative(aliases, accountByRaw),
      aliases,
      accounts,
    };
  })
  .sort((a, b) => b.accounts - a.accounts || a.representative.localeCompare(b.representative, "ko"));

const playersCount = plSnap.numChildren();
const leaderboardCount = lbSnap.numChildren();

const report = {
  generatedAt: new Date().toISOString(),
  playersAccounts: playersCount,
  leaderboardAccounts: leaderboardCount,
  rawSchoolNames: allRaw.size,
  groupedSchools: groups.length,
  junkSchoolNames: junk.length,
  groups,
  junk: junk.sort((a, b) => a.localeCompare(b, "ko")),
};

const outPath = path.join(__dirname, "..", "backup", "schools-grouped.json");
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

console.log("\n📊 초등학교 사용 현황 (비슷한 이름 묶음)\n");
console.log(`  players 계정      : ${report.playersAccounts}개`);
console.log(`  leaderboard 계정  : ${report.leaderboardAccounts}개`);
console.log(`  DB에 있는 학교 이름(원본) : ${report.rawSchoolNames}개`);
console.log(`  묶은 뒤 학교 수           : ${report.groupedSchools}개  ← 실사용 추정`);
console.log(`  장난·오류·테스트(제외)    : ${report.junkSchoolNames}개`);
console.log(`\n  상세 목록 저장: backup/schools-grouped.json\n`);

console.log("── 계정 많은 학교 TOP 25 ──");
groups.slice(0, 25).forEach((g, i) => {
  const extra = g.aliases.length > 1 ? ` (${g.aliases.length}가지 표기)` : "";
  console.log(`  ${String(i + 1).padStart(2)}. ${g.representative} — 계정 ${g.accounts}개${extra}`);
});
