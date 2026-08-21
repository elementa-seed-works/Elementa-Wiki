// 실행 설정 로딩
//
// 우선순위: 실제 환경변수 > .env 파일 > 기본값
// GitHub Actions 에서는 .env 가 없으므로 환경변수만으로 동작한다.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PKG_DIR = path.resolve(LIB_DIR, "..");
export const REPO_ROOT = path.resolve(PKG_DIR, "..", "..");

/**
 * .env 파일을 읽어 process.env 에 주입한다. 이미 정의된 키는 덮어쓰지 않는다.
 * @returns {number} 주입한 키 개수
 */
export function loadDotEnv(file = path.join(PKG_DIR, ".env")) {
  if (!existsSync(file)) return 0;
  let injected = 0;
  for (const raw of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) {
      process.env[key] = value;
      injected++;
    }
  }
  return injected;
}

function envFlag(name) {
  const v = (process.env[name] || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * CLI 인자와 환경변수를 합쳐 설정 객체를 만든다.
 *
 * CLI 플래그
 *  --preview        : OUTPUT_DIR 을 <repo>/wiki-preview 로 고정 (로컬 검수용)
 *  --out <dir>      : 출력 디렉터리 직접 지정
 *  --skip-images    : 이미지 다운로드 생략 (빠른 반복 확인용)
 *  --full           : 상태 파일을 무시하고 전부 다시 만든다 (증분 결과가 의심스러울 때)
 */
export function loadConfig(argv = process.argv.slice(2)) {
  const preview = argv.includes("--preview");
  const outIdx = argv.indexOf("--out");
  const outArg = outIdx >= 0 ? argv[outIdx + 1] : "";

  const outputDir =
    outArg ||
    (preview ? path.join(REPO_ROOT, "wiki-preview") : process.env.OUTPUT_DIR) ||
    path.join(REPO_ROOT, "wiki");

  return {
    notionToken: process.env.NOTION_TOKEN || "",
    rootPageId: process.env.NOTION_ROOT_PAGE_ID || "",
    // 지정하면 루트 대신 이 페이지 내용이 Home.md 가 된다.
    homePageId: process.env.NOTION_HOME_PAGE_ID || "",
    // 자기참조 관계로 계층을 만드는 속성 이름. 미지정 시 스키마에서 자동 추론.
    parentPropOverride: process.env.NOTION_DB_PARENT_PROP || "",
    // 트리에서 통째로 빼는 페이지/데이터베이스 ID 목록 (쉼표 구분)
    skipIds: (process.env.NOTION_SKIP_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    wikiTitle: process.env.WIKI_TITLE || "Elementa Wiki",
    outputDir: path.resolve(outputDir),
    assetsSubdir: "assets",
    skipImages: envFlag("SKIP_IMAGES") || argv.includes("--skip-images"),
    // 상태 파일을 무시하고 전체를 다시 만든다.
    forceFull: envFlag("FORCE_FULL") || argv.includes("--full"),
    // 요청 사이 최소 간격(ms). 노션 제한은 통합당 평균 초당 3회다.
    minIntervalMs: envNumber("NOTION_MIN_INTERVAL_MS", 350),
    maxRetries: envNumber("NOTION_MAX_RETRIES", 5),
    preview,
  };
}

/**
 * 필수값 검증. 부족하면 사람이 읽을 수 있는 오류 메시지 배열을 돌려준다.
 */
export function validateConfig(config) {
  const errors = [];
  if (!config.notionToken) {
    errors.push(
      "NOTION_TOKEN 이 필요합니다. GitHub 에서는 Secret 으로, 로컬에서는 scripts/notion-wiki-sync/.env 에 넣으세요.",
    );
  }
  if (!config.rootPageId) {
    errors.push("NOTION_ROOT_PAGE_ID 가 필요합니다. (저장소 Settings → Variables 또는 로컬 .env)");
  }
  return errors;
}
