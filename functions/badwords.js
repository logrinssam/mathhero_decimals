// 닉네임·학교명 욕설/패드립 필터 (서버 전용)
//
// 검사 순서
//  1) normalize: 소문자 + 공백·기호·숫자 제거  →  "씨 1 발", "씨.발", "SsIbal" 같은 변형을 한 형태로 모음
//  2) BANNED_WORDS 부분 일치 (정규화된 문자열 기준)
//  3) BANNED_JAMO: 자음만 쓴 욕 (ㅅㅂ, ㅂㅅ …) — 원문에 낱자모가 실제로 있을 때만 검사 (수박→ㅅㅂ 같은 오탐 방지)
//  4) BANNED_PATTERNS: 숫자가 필요한 은어 (18놈, 십8 …)는 숫자 제거 전 원문으로 검사
//
// 단어를 더 막고 싶으면 BANNED_WORDS에 추가하거나, 배포 없이 Firebase DB의 config/bannedWords 배열에 넣으면 된다.

const BANNED_WORDS = [
  // 욕설
  "씨발", "시발", "씨빨", "시빨", "씨바", "시바", "쓰발", "쓰바", "슈발", "쉬발", "씨팔", "시팔", "씹", "쌍놈", "쌍년",
  "새끼", "색끼", "색기", "새키", "섀끼", "쉐끼", "개새", "개색", "개섹",
  "병신", "븅신", "빙신", "병쉰", "빙시", "등신",
  "지랄", "지럴", "즤랄", "미친", "미췬", "또라이", "돌아이", "정신병", "찐따", "장애인", "장애",
  "존나", "존내", "존니", "졸라", "좆", "좃", "좇", "꼬추", "자지", "보지", "잦이",
  "닥쳐", "꺼져", "죽어", "뒤져", "뒈져", "디져", "죽여", "죽일",
  "호로", "걸레", "창녀", "창년", "개년", "개놈", "개같", "개돼지", "개소리", "빡대가리", "대가리", "대갈",
  "엿먹", "니기미", "니미", "쓰레기",
  // 패드립
  "니애미", "니에미", "네애미", "니애비", "니에비", "네애비", "애미", "애비", "에미", "에비",
  "느금", "느그애", "느그엄", "느그아", "니엄마", "니아빠", "네엄마", "네아빠", "느검", "엄창", "엠창", "앰창", "엄마없", "아빠없",
  "노무", "일베", "홍어", "틀딱", "급식충", "한남충", "김치녀",
  // 성적인 말
  "섹스", "색스", "쎅스", "섹시", "야동", "야사", "포르노", "딸딸이", "자위", "강간", "성기", "음경", "질내", "발기", "고자",
  // 영어
  "fuck", "fuk", "fck", "fxck", "shit", "bitch", "bich", "asshole", "dick", "pussy", "sex", "porn", "nigger", "nigga",
  "cunt", "wtf", "motherfucker", "bastard", "slut", "whore", "penis", "vagina", "boobs", "hentai",
  // 로마자 표기 / 한글을 영문 자판으로 친 것
  "ssibal", "sibal", "shibal", "ssiba", "shiba", "byungsin", "byeongsin", "jonna", "jiral", "saekki",
  "tlqkf", "tlqkd", "tlqk", "qudtls", "wlfkf", "alcls", "tprtm", "tlqid", "dhlfqp", "wlfkfek", "tocrl",
];

// 자음만으로 쓴 욕 (원문에 낱자모가 있을 때만 검사)
const BANNED_JAMO = ["ㅅㅂ", "ㅆㅂ", "ㅅㅃ", "ㅂㅅ", "ㅄ", "ㅂㅆ", "ㅈㄴ", "ㅈㄹ", "ㅁㅊ", "ㄱㅅㄲ", "ㅅㄲ", "ㅆㄲ", "ㄲㅈ", "ㄴㄱㅁ", "ㄴㅇㅁ", "ㅈㄲ", "ㅗ"];

// 숫자가 들어간 은어 (숫자를 지우기 전 원문으로 검사)
const BANNED_PATTERNS = [
  /18\s*(놈|년|새끼|세끼|색|아|ㅅ|ㄴ)/,
  /(씹|십|시|씨)\s*8/,
  /(시|씨)\s*[1l]\s*(발|빨|바|팔)/,
  /ㅅ\s*[1l]\s*ㅂ/,
];

function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, "")   // 공백·기호·이모지 제거
    .replace(/[0-9]/g, "");                     // 숫자 제거 (씨1발 → 씨발)
}

// 걸린 단어를 돌려준다. 문제가 없으면 null.
function findBannedWord(raw) {
  const original = String(raw || "").toLowerCase();
  const text = normalize(raw);
  if (!text) return null;

  for (const w of BANNED_WORDS) if (text.includes(w)) return w;

  if (/[ㄱ-ㅎㅏ-ㅣ]/.test(text)) {
    for (const j of BANNED_JAMO) if (text.includes(j)) return j;
  }

  for (const re of BANNED_PATTERNS) if (re.test(original)) return original.match(re)[0];
  return null;
}

module.exports = { findBannedWord, normalize, BANNED_WORDS };
