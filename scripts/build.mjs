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

const sourceCode = match[1].trim();

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
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: "hexadecimal",
      numbersToExpressions: false,
      renameGlobals: false,
      selfDefending: false,
      simplify: true,
      splitStrings: true,
      splitStringsChunkLength: 8,
      stringArray: true,
      stringArrayCallsTransform: false,
      stringArrayEncoding: ["base64"],
      stringArrayThreshold: 0.55,
      transformObjectKeys: false,
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
let outHtml = html.replace(match[0], scriptBlock);

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
