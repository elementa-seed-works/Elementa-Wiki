// 산출물 기록
//
// 트리와 렌더러를 받아 위키 디렉터리를 지금 트리 모양과 같게 만든다.
//  - 변경된 페이지: 노션을 다시 불러 본문을 만든다
//  - 변경되지 않은 페이지: 직전 실행이 만든 .md 에서 본문을 떼어 쓴다(노션 호출 없음)
//  - 트리에 없는 최상위 파일: 지운다(노션에서 지웠거나 파일명이 바뀐 문서)
//
// 내용이 같으면 파일을 건드리지 않는다. 변경이 없는 실행이 위키 커밋을 만들지 않게 하려는 것이다.

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { extractBody } from "./markdown.mjs";
import { renderFooter, renderSidebar } from "./sidebar.mjs";
import { STATE_FILE } from "./state.mjs";

const SIDEBAR_FILE = "_Sidebar.md";
const FOOTER_FILE = "_Footer.md";

async function readIfExists(file) {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/** 내용이 달라졌을 때만 쓴다. */
async function writeIfChanged(file, content, existing) {
  if (existing === content) return false;
  await writeFile(file, content, "utf-8");
  return true;
}

/** 문서에서 참조하는 assets/ 파일 이름을 모은다. */
function collectAssetRefs(markdown, subdir, into) {
  for (const m of markdown.matchAll(new RegExp(`${subdir}/([A-Za-z0-9._-]+)`, "g"))) into.add(m[1]);
}

/** 어느 문서도 참조하지 않는 자산을 지운다. */
async function pruneAssets(dir, referenced) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const file of files) {
    if (referenced.has(file)) continue;
    await rm(path.join(dir, file), { force: true });
    removed++;
  }
  return removed;
}

/**
 * 위키 디렉터리를 트리와 같게 만든다.
 *
 * @param {object} params
 * @param {object} params.config 설정
 * @param {object} params.tree 루트 노드 (사이드바 생성용)
 * @param {object[]} params.nodes flatten 한 노드 배열
 * @param {object|null} params.state 직전 실행 상태 (파일명이 바뀐 문서를 찾는 데 쓴다)
 * @param {{renderBody: Function, composePage: Function}} params.renderer
 * @param {object} params.stats 통계 누적 대상
 * @param {string} [params.sourceUrl] 푸터에 넣을 노션 원본 링크
 * @param {(msg: string) => void} [params.log]
 * @returns {Promise<{touched: number}>} 실제로 쓰거나 지운 파일 수
 */
export async function publishWiki({ config, tree, nodes, state, renderer, stats, sourceUrl = "", log = () => {} }) {
  const keep = new Set([STATE_FILE, SIDEBAR_FILE, FOOTER_FILE]);
  const assetRefs = new Set();
  let touched = 0;

  for (const node of nodes) {
    const target = path.join(config.outputDir, `${node.slug}.md`);
    const existing = await readIfExists(target);
    const prevSlug = state?.pages?.[node.normId]?.slug;
    // 파일명이 바뀌었으면 본문은 옛 파일에 들어 있다.
    const cacheSource =
      prevSlug && prevSlug !== node.slug ? await readIfExists(path.join(config.outputDir, `${prevSlug}.md`)) : existing;

    const cachedBody = node.changed || cacheSource === null ? null : extractBody(cacheSource);
    let body;
    if (cachedBody === null) {
      body = await renderer.renderBody(node);
      stats.pagesRendered++;
    } else {
      body = cachedBody;
      stats.pagesReused++;
    }

    const content = renderer.composePage(node, body);
    collectAssetRefs(content, config.assetsSubdir, assetRefs);
    keep.add(`${node.slug}.md`);
    if (await writeIfChanged(target, content, existing)) {
      stats.filesWritten++;
      touched++;
      log(`  ✓ ${node.slug}.md  (${node.title})`);
    }
  }

  // 산출물은 전부 이 스크립트가 만든 것이므로, 이번 트리에 없는 최상위 파일은 남길 이유가 없다.
  for (const entry of await readdir(config.outputDir)) {
    if (entry === ".git" || entry === config.assetsSubdir || keep.has(entry)) continue;
    await rm(path.join(config.outputDir, entry), { recursive: true, force: true });
    stats.filesDeleted++;
    touched++;
    log(`  ✗ ${entry} (삭제)`);
  }

  const sidebarPath = path.join(config.outputDir, SIDEBAR_FILE);
  const sidebar = renderSidebar(tree, { wikiTitle: config.wikiTitle });
  if (await writeIfChanged(sidebarPath, sidebar, await readIfExists(sidebarPath))) {
    touched++;
    log(`  ✓ ${SIDEBAR_FILE}`);
  }

  // 푸터의 동기화 시각은 실제로 바뀐 것이 있을 때만 갱신한다.
  const footerPath = path.join(config.outputDir, FOOTER_FILE);
  const existingFooter = await readIfExists(footerPath);
  if (touched > 0 || existingFooter === null) {
    const footer = renderFooter({
      wikiTitle: config.wikiTitle,
      syncedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
      sourceUrl,
    });
    if (await writeIfChanged(footerPath, footer, existingFooter)) log(`  ✓ ${FOOTER_FILE}`);
  }

  // 이미지를 건너뛴 실행에서는 본문에 로컬 경로가 없어 정리 대상을 판단할 수 없다.
  if (!config.skipImages) {
    stats.assetsRemoved = await pruneAssets(path.join(config.outputDir, config.assetsSubdir), assetRefs);
  }

  return { touched };
}
