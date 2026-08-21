// Notion → GitHub Wiki 동기화 스크립트 (진입점)
//
// 동작 개요
//  1. search 로 접근 가능한 페이지·데이터베이스를 100건 단위로 열거 (부모 관계 + 수정 시각)
//  2. 상태 파일(.notion-sync-state.json)의 수정 시각과 비교해 변경된 페이지만 추린다
//  3. 변경된 페이지만 블록을 조회해 마크다운으로 변환 (notion-to-md)
//     — 변경되지 않은 페이지는 직전 실행이 만든 .md 에서 본문을 그대로 떼어 쓴다
//  4. 만료되는 노션 이미지 URL 을 내려받아 assets/ 에 두고 링크를 로컬 경로로 치환
//  5. 노션 내부 페이지 링크를 위키 슬러그로 치환
//  6. Home.md / <슬러그>.md / _Sidebar.md / _Footer.md 기록, 트리에 없는 문서는 삭제
//
// 실행
//  node sync.mjs                 # OUTPUT_DIR(기본 ../../wiki)에 생성
//  node sync.mjs --preview       # <repo>/wiki-preview 에 생성 (로컬 검수용)
//  node sync.mjs --skip-images   # 이미지 다운로드 생략
//  node sync.mjs --full          # 상태 파일을 무시하고 전부 다시 생성

import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { loadConfig, loadDotEnv, validateConfig } from "./lib/config.mjs";
import { createClient, extractEmojiIcon, extractTitle, retrievePage } from "./lib/notion.mjs";
import { buildCatalog, groupByParent, recoverMissing } from "./lib/catalog.mjs";
import { assignSlugs, buildTree, createTreeContext, flatten } from "./lib/tree.mjs";
import { createRenderer } from "./lib/markdown.mjs";
import { publishWiki } from "./lib/publish.mjs";
import { collectPageState, detectMassLoss, loadState, saveState } from "./lib/state.mjs";
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

/** --full 실행에서 .git 을 제외한 기존 산출물을 지운다. */
async function clearOutput(dir) {
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

/** 파일명이 바뀐 문서 목록. 캐시된 본문에 남아 있는 옛 링크를 고치는 데 쓴다. */
function collectSlugRenames(state, nodes) {
  const renames = new Map();
  for (const node of nodes) {
    const prev = state?.pages?.[node.normId]?.slug;
    if (prev && prev !== node.slug) renames.set(prev, node.slug);
  }
  return renames;
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length) fail(errors.join("\n"));

  const notion = createClient(config.notionToken, {
    minIntervalMs: config.minIntervalMs,
    maxRetries: config.maxRetries,
    warn,
  });

  await mkdir(config.outputDir, { recursive: true });
  if (config.forceFull) await clearOutput(config.outputDir);
  const state = config.forceFull ? null : await loadState(config.outputDir, warn);
  stats.incremental = Boolean(state);

  const root = await resolveRootPage(notion, config);

  console.log(
    `[notion-wiki-sync] 페이지 목록 수집 중... (${state ? "증분" : "전체"} 동기화, 출력: ${config.outputDir})`,
  );
  const { entries: catalog, blockOwners } = await buildCatalog(notion, { blockOwners: state?.blockOwners, warn });
  // 목록에서 빠진 것이 정말 지워진 것인지 확인한다(검색 응답 결손으로 문서가 사라지는 것을 막는다).
  const recovered = await recoverMissing(notion, {
    entries: catalog,
    statePages: state?.pages,
    blockOwners,
    warn,
  });
  stats.recovered = recovered.length;
  console.log(
    `[notion-wiki-sync] 노션에서 ${catalog.size}건 열거` +
      `${recovered.length ? ` (목록에 없어 개별 확인 ${recovered.length}건)` : ""}` +
      ` · 요청 ${notion.apiStats.requests}회`,
  );

  const ctx = createTreeContext({ notion, config, warn, state });
  const tree = await buildTree(ctx, {
    catalog,
    byParent: groupByParent(catalog),
    rootId: config.rootPageId,
    rootTitle: root.title,
    rootIcon: root.icon,
    homeId: config.homePageId,
  });

  const nodes = flatten(tree);
  assignSlugs(ctx, tree);
  ctx.idToNode = new Map(nodes.map((n) => [n.normId, n]));
  ctx.slugRenames = collectSlugRenames(state, nodes);
  stats.pagesFound = nodes.length;
  stats.orderRefreshes = ctx.orderRefreshes;
  stats.adopted = ctx.adopted;
  console.log(`[notion-wiki-sync] 총 ${nodes.length}개 문서 · 순서 재확인 ${ctx.orderRefreshes}건`);

  const loss = detectMassLoss(state, nodes);
  if (loss.suspicious) {
    fail(
      `문서가 ${loss.known}개에서 ${loss.current}개로 줄어 중단합니다.\n` +
        `노션 목록 응답이 일부만 왔거나 통합 연결이 끊겼을 수 있습니다. 위키는 건드리지 않았습니다.\n` +
        `정말 그만큼 지운 것이라면 전체 재생성(--full 또는 워크플로의 full_sync)으로 한 번 돌리세요.`,
    );
  }

  const renderer = createRenderer({ notion, ctx, config, stats, warn });
  await publishWiki({
    config,
    tree,
    nodes,
    state,
    renderer,
    stats,
    sourceUrl: root.url,
    log: (msg) => console.log(msg),
  });

  await saveState(config.outputDir, { pages: collectPageState(nodes), blockOwners });

  await writeSummary(stats, {
    rootTitle: root.title,
    outputDir: config.outputDir,
    preview: config.preview,
    api: notion.apiStats,
  });
  console.log("[notion-wiki-sync] 완료");
}

main().catch((e) => fail(e.stack || e.message));
