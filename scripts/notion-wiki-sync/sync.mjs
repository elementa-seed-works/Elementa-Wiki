// Notion → GitHub Wiki 동기화 스크립트
//
// 동작 개요
//  1. NOTION_ROOT_PAGE_ID 로부터 하위 페이지 트리를 재귀적으로 수집
//  2. 각 페이지를 마크다운으로 변환 (notion-to-md)
//  3. 이미지(만료되는 Notion URL)를 다운로드해 위키에 함께 커밋하고 링크를 로컬 경로로 치환
//  4. 노션 내부 페이지 링크를 위키 페이지 링크로 치환
//  5. 최상위 페이지 → Home.md, 나머지 → <슬러그>.md 로 저장
//  6. 페이지 계층을 <details> 토글 형식의 _Sidebar.md 로 자동 생성
//
// 필요한 환경변수
//  - NOTION_TOKEN         : Notion 내부 통합(integration) 토큰
//  - NOTION_ROOT_PAGE_ID  : 동기화 기준이 되는 최상위 페이지 ID
//  - OUTPUT_DIR           : 결과를 쓸 디렉터리 (워크플로에서 clone 한 wiki 경로)

import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
// 동기화 기준(트리 루트) 페이지 ID. 반드시 저장소 Variable(NOTION_ROOT_PAGE_ID)로 주입한다.
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID;
// Home(위키 첫 페이지)에 표시할 페이지 ID. 지정 시 루트 대신 이 페이지 내용을 Home 으로 쓴다.
const HOME_PAGE_ID = process.env.NOTION_HOME_PAGE_ID || "";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "./wiki";
const ASSETS_SUBDIR = "assets";

if (!NOTION_TOKEN) fail("환경변수 NOTION_TOKEN 이 필요합니다.");
if (!ROOT_PAGE_ID) fail("환경변수 NOTION_ROOT_PAGE_ID 가 필요합니다. (저장소 Settings → Variables 에 등록)");

// 실행 통계
const stats = {
  startMs: Date.now(),
  pagesFound: 0,
  filesWritten: 0,
  pageErrors: [], // { title, message }
  imagesDownloaded: 0,
  imageErrors: 0,
};

function fail(msg) {
  console.error(`[notion-wiki-sync] ${msg}`);
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 하위 페이지/DB 링크는 본문에 인라인으로 렌더링하지 않는다.
// (탐색은 별도 "## 하위 페이지" 섹션과 사이드바가 담당 → 중복/깨진 텍스트 방지)
n2m.setCustomTransformer("child_page", async () => "");
n2m.setCustomTransformer("child_database", async () => "");

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------

// 32자리 hex(대시 유무 무관)를 대시 포함 UUID 로 정규화
function normalizeId(id) {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 위키 파일명/링크에 쓸 슬러그. 공백은 "-", 파일명에 못 쓰는 문자는 제거.
// GitHub 위키는 파일명의 "-" 를 표시상 공백으로 되돌려 보여준다.
function slugify(title) {
  const cleaned = (title || "Untitled")
    .replace(/[\/\\:\*\?"<>\|#\[\]]/g, " ") // 파일명/위키 금칙 문자
    .replace(/\s+/g, " ")
    .trim();
  const slug = cleaned.replace(/ /g, "-");
  return slug || "Untitled";
}

// 슬러그 충돌 방지용 레지스트리
const usedSlugs = new Set();
function uniqueSlug(base) {
  let slug = base;
  let i = 2;
  while (usedSlugs.has(slug.toLowerCase())) {
    slug = `${base}-${i++}`;
  }
  usedSlugs.add(slug.toLowerCase());
  return slug;
}

// 블록 children 전체를 페이지네이션 처리하여 수집
async function listAllChildren(blockId) {
  const results = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

// 데이터베이스 내 페이지 전체 수집
async function queryAllDbPages(databaseId) {
  const results = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

// 페이지 객체에서 제목 추출
function extractPageTitle(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === "title") {
      const text = (prop.title || []).map((t) => t.plain_text).join("").trim();
      if (text) return text;
    }
  }
  return "Untitled";
}

// ---------------------------------------------------------------------------
// 1) 페이지 트리 수집
// ---------------------------------------------------------------------------
// node = { id, title, slug, children: [node...] }

const idToSlug = new Map(); // normalizedId -> slug (내부 링크 치환용)

// 한 페이지의 "직속 하위 페이지/DB" 를 찾는다.
// child_page/child_database 는 컬럼·토글·콜아웃·synced_block 등 컨테이너 안에
// 중첩돼 있을 수 있으므로, 컨테이너 블록 내부까지 재귀로 훑어서 수집한다.
// (child_page 경계는 넘지 않는다 — 그 내부는 buildTree 가 별도로 처리)
async function findChildRefs(blockId) {
  const refs = [];
  let blocks = [];
  try {
    blocks = await listAllChildren(blockId);
  } catch (e) {
    console.warn(`[warn] children 조회 실패(${blockId}): ${e.message}`);
    return refs;
  }
  for (const block of blocks) {
    if (block.type === "child_page") {
      refs.push({ kind: "page", id: block.id, title: block.child_page?.title || "Untitled" });
    } else if (block.type === "child_database") {
      refs.push({ kind: "db", id: block.id });
    } else if (block.has_children) {
      const nested = await findChildRefs(block.id);
      refs.push(...nested);
    }
  }
  return refs;
}

async function buildTree(pageId, title, isRoot) {
  const normId = normalizeId(pageId);
  const slug = isRoot ? "Home" : uniqueSlug(slugify(title));
  idToSlug.set(normId, slug);

  const node = { id: pageId, normId, title, slug, children: [] };

  const refs = await findChildRefs(pageId);
  for (const ref of refs) {
    if (ref.kind === "page") {
      node.children.push(await buildTree(ref.id, ref.title, false));
    } else if (ref.kind === "db") {
      // 데이터베이스: 각 행(페이지)을 하위 페이지로 취급 (그 페이지도 재귀 파싱)
      try {
        const dbPages = await queryAllDbPages(ref.id);
        for (const dbPage of dbPages) {
          node.children.push(await buildTree(dbPage.id, extractPageTitle(dbPage), false));
        }
      } catch (e) {
        console.warn(`[warn] 데이터베이스 조회 실패(${ref.id}): ${e.message}`);
      }
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// 2) 이미지 다운로드 + 링크 치환
// ---------------------------------------------------------------------------

async function downloadImage(url, assetsDir) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = createHash("sha1").update(url.split("?")[0] + buf.length).digest("hex").slice(0, 16);
    // 확장자 추정
    const contentType = res.headers.get("content-type") || "";
    let ext = ".png";
    if (contentType.includes("jpeg")) ext = ".jpg";
    else if (contentType.includes("png")) ext = ".png";
    else if (contentType.includes("gif")) ext = ".gif";
    else if (contentType.includes("webp")) ext = ".webp";
    else if (contentType.includes("svg")) ext = ".svg";
    else {
      const m = url.split("?")[0].match(/\.(png|jpe?g|gif|webp|svg)$/i);
      if (m) ext = "." + m[1].toLowerCase();
    }
    const filename = `${hash}${ext}`;
    await mkdir(assetsDir, { recursive: true });
    await writeFile(path.join(assetsDir, filename), buf);
    stats.imagesDownloaded++;
    return `${ASSETS_SUBDIR}/${filename}`;
  } catch (e) {
    stats.imageErrors++;
    console.warn(`[warn] 이미지 다운로드 실패: ${e.message}`);
    return null;
  }
}

// 마크다운 내 이미지 URL 을 로컬 경로로 치환
async function processImages(markdown, assetsDir) {
  const imgRegex = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const matches = [...markdown.matchAll(imgRegex)];
  let out = markdown;
  for (const m of matches) {
    const [full, alt, url] = m;
    // Notion S3 / 첨부 이미지만 다운로드 (외부 정적 이미지는 그대로 둠)
    if (!/(amazonaws\.com|notion\.so|notion-static\.com)/.test(url)) continue;
    const local = await downloadImage(url, assetsDir);
    if (local) out = out.replace(full, `![${alt}](${local})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3) 내부 링크 치환 (노션 페이지 링크 → 위키 링크)
// ---------------------------------------------------------------------------

function rewriteInternalLinks(markdown) {
  // https://www.notion.so/....<32hex> 형태에서 id 추출 후 위키 슬러그로 치환
  return markdown.replace(/https?:\/\/(?:www\.)?notion\.so\/[^\s)]*/g, (url) => {
    const hexMatch = url.match(/([0-9a-fA-F]{32})/) || url.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
    if (!hexMatch) return url;
    const norm = normalizeId(hexMatch[1]);
    const slug = idToSlug.get(norm);
    return slug ? slug : url; // 위키에 없는 페이지면 원본 유지
  });
}

// ---------------------------------------------------------------------------
// 4) 페이지별 마크다운 생성
// ---------------------------------------------------------------------------

async function renderPage(node, assetsDir) {
  let md = "";
  // Home 은 HOME_PAGE_ID(Main)가 지정되면 그 페이지 내용을 사용
  const sourceId = node.slug === "Home" && HOME_PAGE_ID ? HOME_PAGE_ID : node.id;
  try {
    const blocks = await n2m.pageToMarkdown(sourceId);
    md = n2m.toMarkdownString(blocks).parent || "";
  } catch (e) {
    console.warn(`[warn] "${node.title}" 변환 실패: ${e.message}`);
    stats.pageErrors.push({ title: node.title, message: e.message });
    md = `> ⚠ 이 페이지 변환에 실패했습니다: ${e.message}\n`;
  }

  md = await processImages(md, assetsDir);
  md = rewriteInternalLinks(md);

  // 제목 헤더를 맨 위에 부여 (위키 가독성)
  const header = `# ${node.title}\n\n`;

  // 하위 페이지가 있으면 본문 아래에 하이퍼링크 목록을 자동 삽입
  let childSection = "";
  if (node.children.length > 0) {
    const links = node.children
      .map((c) => `- [${c.title}](${c.slug})`)
      .join("\n");
    childSection = `\n\n## 하위 페이지\n\n${links}\n`;
  }

  const footer = `\n\n---\n_이 문서는 Notion 에서 자동 동기화되었습니다. 직접 편집하지 마세요._\n`;
  return header + md + childSection + footer;
}

// ---------------------------------------------------------------------------
// 5) 토글형 사이드바 생성
// ---------------------------------------------------------------------------

function renderSidebar(root) {
  const lines = [];
  lines.push(`### 📖 Elementa Wiki`);
  lines.push("");
  lines.push(`[🏠 Home](Home)`);
  lines.push("");

  function walk(nodes, depth) {
    for (const node of nodes) {
      if (node.children.length > 0) {
        // 하위가 있으면 <details> 토글
        lines.push(`<details${depth === 0 ? " open" : ""}>`);
        lines.push(`<summary><a href="${node.slug}">${escapeHtml(node.title)}</a></summary>`);
        lines.push("");
        walk(node.children, depth + 1);
        lines.push("");
        lines.push(`</details>`);
      } else {
        lines.push(`- <a href="${node.slug}">${escapeHtml(node.title)}</a>`);
      }
    }
  }

  walk(root.children, 0);
  lines.push("");
  return lines.join("\n");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// 6) 실행
// ---------------------------------------------------------------------------

async function cleanOutput(dir) {
  // .git 을 제외한 기존 산출물 제거 (삭제된 노션 페이지 반영)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    return;
  }
  for (const entry of await readdir(dir)) {
    if (entry === ".git") continue;
    await rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

async function collectAllNodes(root) {
  const all = [];
  (function walk(n) {
    all.push(n);
    n.children.forEach(walk);
  })(root);
  return all;
}

async function main() {
  console.log("[notion-wiki-sync] 페이지 트리 수집 중...");
  let rootTitle = "Home";
  try {
    // Home 표시 제목: HOME_PAGE_ID(Main)가 있으면 그 제목을, 없으면 루트 제목을 사용
    const titleSourceId = HOME_PAGE_ID || ROOT_PAGE_ID;
    const titlePage = await notion.pages.retrieve({ page_id: titleSourceId });
    rootTitle = extractPageTitle(titlePage);
  } catch (e) {
    fail(`페이지 조회 실패: ${e.message}\n통합(integration)이 해당 페이지에 연결(Connections)되어 있는지 확인하세요.`);
  }

  // 트리 루트는 항상 ROOT_PAGE_ID(SeedWork). 하위 페이지 탐색 기준.
  const tree = await buildTree(ROOT_PAGE_ID, rootTitle, true);
  // Main 페이지로의 내부 링크도 Home 으로 해석되도록 매핑
  if (HOME_PAGE_ID) idToSlug.set(normalizeId(HOME_PAGE_ID), "Home");
  const allNodes = await collectAllNodes(tree);
  stats.pagesFound = allNodes.length;
  console.log(`[notion-wiki-sync] 총 ${allNodes.length}개 페이지 발견`);

  await cleanOutput(OUTPUT_DIR);
  const assetsDir = path.join(OUTPUT_DIR, ASSETS_SUBDIR);

  for (const node of allNodes) {
    const content = await renderPage(node, assetsDir);
    const filename = `${node.slug}.md`;
    await writeFile(path.join(OUTPUT_DIR, filename), content, "utf-8");
    stats.filesWritten++;
    console.log(`  ✓ ${filename}  (${node.title})`);
  }

  // 사이드바
  const sidebar = renderSidebar(tree);
  await writeFile(path.join(OUTPUT_DIR, "_Sidebar.md"), sidebar, "utf-8");
  console.log("  ✓ _Sidebar.md");

  await writeSummary(rootTitle);
  console.log("[notion-wiki-sync] 완료");
}

// ---------------------------------------------------------------------------
// 실행 요약 출력 (콘솔 + GitHub Actions Step Summary)
// ---------------------------------------------------------------------------
async function writeSummary(rootTitle) {
  const elapsedSec = ((Date.now() - stats.startMs) / 1000).toFixed(1);
  const ok = stats.pageErrors.length === 0;

  const lines = [];
  lines.push(`## 🔄 Notion → Wiki 동기화 결과`);
  lines.push("");
  lines.push(`- 상태: ${ok ? "✅ 성공" : "⚠️ 일부 실패"}`);
  lines.push(`- 기준 페이지: ${rootTitle}`);
  lines.push(`- 동기화된 페이지: ${stats.filesWritten} / ${stats.pagesFound}`);
  lines.push(`- 변환 실패: ${stats.pageErrors.length}건`);
  lines.push(`- 이미지: 다운로드 ${stats.imagesDownloaded}개 · 실패 ${stats.imageErrors}개`);
  lines.push(`- 소요 시간: ${elapsedSec}s`);
  lines.push("");

  if (stats.pageErrors.length > 0) {
    lines.push(`### ❌ 실패한 페이지`);
    lines.push("");
    lines.push(`| 페이지 | 오류 |`);
    lines.push(`| --- | --- |`);
    for (const e of stats.pageErrors) {
      const msg = (e.message || "").replace(/\|/g, "\\|").slice(0, 160);
      lines.push(`| ${e.title.replace(/\|/g, "\\|")} | ${msg} |`);
    }
    lines.push("");
  }

  const summary = lines.join("\n");

  // 콘솔 출력
  console.log("\n" + summary);

  // GitHub Actions 요약 패널
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await writeFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n", { flag: "a" });
    } catch (e) {
      console.warn(`[warn] step summary 기록 실패: ${e.message}`);
    }
  }
}

main().catch((e) => fail(e.stack || e.message));
