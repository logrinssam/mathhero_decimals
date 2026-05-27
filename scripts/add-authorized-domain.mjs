/**
 * Firebase 허용 도메인(Authorized domains)에 커스텀 도메인 추가
 *
 *   scripts/serviceAccountKey.json 필요 (Firebase 콘솔 → 서비스 계정 → 비공개 키)
 *   node scripts/add-authorized-domain.mjs
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { createSign } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = "division-of-fractions";
const DOMAINS_TO_ADD = [
  "mathhero-decimals.xn--9d0blmm1xg2knrf.com",
  "mathhero-decimals.로그인교실.com",
];

const keyPaths = [
  path.join(__dirname, "serviceAccountKey.json"),
  path.join(__dirname, "serviceAccountkey.json"),
];
const keyPath = keyPaths.find((p) => existsSync(p));
if (!keyPath) {
  console.error("serviceAccountKey.json 이 없습니다:", keyPaths[0]);
  process.exit(1);
}

const sa = JSON.parse(readFileSync(keyPath, "utf8"));

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      scope: "https://www.googleapis.com/auth/cloud-platform",
    })
  );
  const unsigned = `${header}.${claim}`;
  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  const sig = b64url(sign.sign(sa.private_key));
  const jwt = `${unsigned}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.error_description || "토큰 발급 실패");
  return data.access_token;
}

async function main() {
  const token = await getAccessToken();
  const configUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config`;

  const getRes = await fetch(configUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) {
    throw new Error(`config GET ${getRes.status}: ${await getRes.text()}`);
  }
  const config = await getRes.json();
  const current = new Set(config.authorizedDomains || []);
  const before = [...current];
  for (const d of DOMAINS_TO_ADD) current.add(d);

  if (before.length === current.size) {
    console.log("이미 등록된 도메인입니다:", DOMAINS_TO_ADD.join(", "));
    return;
  }

  config.authorizedDomains = [...current];
  const patchRes = await fetch(`${configUrl}?updateMask=authorizedDomains`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config),
  });
  if (!patchRes.ok) {
    throw new Error(`config PATCH ${patchRes.status}: ${await patchRes.text()}`);
  }

  console.log("✅ 허용 도메인 추가 완료:");
  for (const d of DOMAINS_TO_ADD) console.log("  -", d);
  console.log("\n전체 목록:", (await patchRes.json()).authorizedDomains?.join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
