// Notion → GitHub Wiki 동기화 스크립트 (진입점)
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
//  - NOTION_HOME_PAGE_ID  : (선택) Home 에 표시할 페이지 ID
//  - OUTPUT_DIR           : 결과를 쓸 디렉터리 (워크플로에서 clone 한 wiki 경로)

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { loadConfig, validateConfig } from "./lib/config.mjs";
import { createClient, extractTitle, normalizeId, retrievePage } from "./lib/notion.mjs";
import { buildTree, createTreeContext, flatten } from "./lib/tree.mjs";
import { createRenderer } from "./lib/markdown.mjs";
import { renderSidebar } from "./lib/sidebar.mjs";
import { createStats, writeSummary } from "./lib/summary.mjs";

const stats = createStats();

function fail(msg) {
  console.error(`[notion-wiki-sync] ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`[warn] ${msg}`);
}

/** .git 을 제외한 기존 산출물을 지운다 (노션에서 삭제된 페이지 반영). */
async function cleanOutput(dir) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    return;
  }
  for (const entry of await readdir(dir)) {
    if (entry === ".git") continue;
    await rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

async function resolveRootTitle(notion, config) {
  // Home 표시 제목: NOTION_HOME_PAGE_ID 가 있으면 그 제목을, 없으면 루트 제목을 쓴다.
  try {
    const page = await retrievePage(notion, config.homePageId || config.rootPageId);
    return extractTitle(page);
  } catch (e) {
    fail(
      `페이지 조회 실패: ${e.message}\n` +
        `통합(integration)이 해당 페이지에 연결(Connections)되어 있는지 확인하세요.`,
    );
  }
}

async function main() {
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length) fail(errors.join("\n"));

  const notion = createClient(config.notionToken);
  const rootTitle = await resolveRootTitle(notion, config);

  console.log("[notion-wiki-sync] 페이지 트리 수집 중...");
  const ctx = createTreeContext({ notion, config, warn });
  // 트리 루트는 항상 NOTION_ROOT_PAGE_ID. 하위 페이지 탐색 기준.
  const tree = await buildTree(ctx, { pageId: config.rootPageId, title: rootTitle, isRoot: true });
  // Home 으로 쓰는 페이지로의 내부 링크도 Home 으로 해석되도록 매핑
  if (config.homePageId) ctx.idToSlug.set(normalizeId(config.homePageId), "Home");

  const allNodes = flatten(tree);
  stats.pagesFound = allNodes.length;
  console.log(`[notion-wiki-sync] 총 ${allNodes.length}개 페이지 발견`);

  await cleanOutput(config.outputDir);

  const renderer = createRenderer({ notion, ctx, config, stats, warn });
  for (const node of allNodes) {
    const content = await renderer.renderPage(node);
    await writeFile(path.join(config.outputDir, `${node.slug}.md`), content, "utf-8");
    stats.filesWritten++;
    console.log(`  ✓ ${node.slug}.md  (${node.title})`);
  }

  await writeFile(
    path.join(config.outputDir, "_Sidebar.md"),
    renderSidebar(tree, { wikiTitle: "Elementa Wiki" }),
    "utf-8",
  );
  console.log("  ✓ _Sidebar.md");

  await writeSummary(stats, { rootTitle });
  console.log("[notion-wiki-sync] 완료");
}

main().catch((e) => fail(e.stack || e.message));
