// Notion → GitHub Wiki 동기화 스크립트 (진입점)
//
// 동작 개요
//  1. NOTION_ROOT_PAGE_ID 로부터 하위 트리 수집 (데이터베이스는 그룹으로, 자기참조 관계는 계층으로)
//  2. 각 페이지를 마크다운으로 변환 (notion-to-md)
//  3. 만료되는 노션 이미지 URL 을 내려받아 assets/ 에 두고 링크를 로컬 경로로 치환
//  4. 노션 내부 페이지 링크를 위키 슬러그로 치환
//  5. Home.md / <슬러그>.md / _Sidebar.md / _Footer.md 생성
//
// 실행
//  node sync.mjs                 # OUTPUT_DIR(기본 ../../wiki)에 생성
//  node sync.mjs --preview       # <repo>/wiki-preview 에 생성 (로컬 검수용)
//  node sync.mjs --skip-images   # 이미지 다운로드 생략

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { loadConfig, loadDotEnv, validateConfig } from "./lib/config.mjs";
import { createClient, extractEmojiIcon, extractTitle, normalizeId, retrievePage } from "./lib/notion.mjs";
import { buildTree, createTreeContext, flatten } from "./lib/tree.mjs";
import { createRenderer } from "./lib/markdown.mjs";
import { renderFooter, renderSidebar } from "./lib/sidebar.mjs";
import { createStats, writeSummary } from "./lib/summary.mjs";

const stats = createStats();

function fail(msg) {
  console.error(`[notion-wiki-sync] ${msg}`);
  process.exit(1);
}

function warn(msg) {
  stats.warnings++;
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

async function resolveRootPage(notion, config) {
  // Home 표시 제목: NOTION_HOME_PAGE_ID 가 있으면 그 페이지 제목을, 없으면 루트 제목을 쓴다.
  const titleSourceId = config.homePageId || config.rootPageId;
  try {
    const page = await retrievePage(notion, titleSourceId);
    return { title: extractTitle(page), icon: extractEmojiIcon(page), url: page.url || "" };
  } catch (e) {
    fail(
      `페이지 조회 실패: ${e.message}\n` +
        `통합(integration)이 해당 페이지에 연결(Connections)되어 있는지 확인하세요.`,
    );
  }
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length) fail(errors.join("\n"));

  const notion = createClient(config.notionToken);
  const root = await resolveRootPage(notion, config);

  console.log(`[notion-wiki-sync] 페이지 트리 수집 중... (출력: ${config.outputDir})`);
  const ctx = createTreeContext({ notion, config, warn });
  const tree = await buildTree(ctx, {
    rootId: config.rootPageId,
    rootTitle: root.title,
    rootIcon: root.icon,
    homeId: config.homePageId,
  });

  const allNodes = flatten(tree);
  ctx.idToNode = new Map(allNodes.map((n) => [normalizeId(n.id), n]));
  stats.pagesFound = allNodes.length;
  console.log(`[notion-wiki-sync] 총 ${allNodes.length}개 문서 발견`);

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
    renderSidebar(tree, { wikiTitle: config.wikiTitle }),
    "utf-8",
  );
  await writeFile(
    path.join(config.outputDir, "_Footer.md"),
    renderFooter({
      wikiTitle: config.wikiTitle,
      syncedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
      sourceUrl: root.url,
    }),
    "utf-8",
  );
  console.log("  ✓ _Sidebar.md\n  ✓ _Footer.md");

  await writeSummary(stats, {
    rootTitle: root.title,
    outputDir: config.outputDir,
    preview: config.preview,
  });
  console.log("[notion-wiki-sync] 완료");
}

main().catch((e) => fail(e.stack || e.message));
