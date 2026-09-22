/**
 * src/index.html → index.html (GitHub Pages 배포용, JS 난독화)
 * 사용: npm run build  |  가벼운 난독화: npm run build:light
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import JavaScriptObfuscator from "javascript-obfuscator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const light = process.argv.includes("--light");

const srcPath = path.join(root, "src", "index.html");
const outRoot = path.join(root, "index.html");
const outDist = path.join(root, "dist", "index.html");

if (!fs.existsSync(srcPath)) {
  console.error("소스 없음:", srcPath);
  process.exit(1);
}

const html = fs.readFileSync(srcPath, "utf8");
const match = html.match(/<script\s+type=["']module["']\s*>([\s\S]*?)<\/script>/i);
if (!match) {
  console.error("<script type=\"module\"> 블록을 찾을 수 없습니다.");
  process.exit(1);
}

// import 줄은 최상위에 남기고, 나머지 본문은 즉시실행함수 (() => { })() 로 감싼다.
// → 최상위 const/let/function 이 지역 선언이 되어 난독화 도구가 이름을 모두 바꾼다 (window.xxx = 는 그대로 동작).
const rawSource = match[1].trim();
const isImport = (l) => /^\s*import\s/.test(l);
const importLines = rawSource.split(/\r?\n/).filter(isImport);
const bodyLines = rawSource.split(/\r?\n/).filter((l) => !isImport(l));
const sourceCode = importLines.join("\n") + "\n(() => {\n" + bodyLines.join("\n") + "\n})();";

const obfuscatorOptions = light
  ? {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: "hexadecimal",
      renameGlobals: false,
      selfDefending: false,
      stringArray: false,
      simplify: true,
      target: "browser",
    }
  : {
      // 강한 난독화: 제어 흐름 평탄화 + 죽은 코드 삽입 + 문자열 암호화 + 자기 방어 + 디버거 방해 + 콘솔 무력화
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.6,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.25,
      debugProtection: true,
      debugProtectionInterval: 2000,
      disableConsoleOutput: true,
      identifierNamesGenerator: "hexadecimal",
      numbersToExpressions: true,
      renameGlobals: false,
      selfDefending: true,
      simplify: true,
      splitStrings: true,
      splitStringsChunkLength: 6,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayEncoding: ["rc4"],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayWrappersCount: 3,
      stringArrayWrappersType: "function",
      stringArrayThreshold: 0.9,
      transformObjectKeys: true,
      unicodeEscapeSequence: false,
      target: "browser",
    };

const obfuscated = JavaScriptObfuscator.obfuscate(
  sourceCode,
  obfuscatorOptions
).getObfuscatedCode();

const banner =
  "<!-- 배포용 자동 생성 (npm run build). 수정은 src/index.html -->";
const scriptBlock = `<script type="module">\n${obfuscated}\n</script>`;
let outHtml = html.replace(match[0], () => scriptBlock);   // 함수 치환: 코드 안의 $ 가 특수 패턴으로 해석되지 않게

if (/<!DOCTYPE\s+html/i.test(outHtml)) {
  outHtml = outHtml.replace(/<!DOCTYPE\s+html[^>]*>/i, (d) => `${d}\n${banner}`);
} else {
  outHtml = `${banner}\n${outHtml}`;
}

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(outRoot, outHtml, "utf8");
fs.writeFileSync(outDist, outHtml, "utf8");

console.log(light ? "✅ build:light 완료" : "✅ build 완료");
console.log("   →", outRoot);
console.log("   →", outDist);
console.log("   원본 편집:", srcPath);
