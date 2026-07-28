// 페이지 트리 구성
//
// node = { id, normId, title, slug, children: [node...] }

import { extractTitle, listAllChildren, normalizeId, queryAllDbPages } from "./notion.mjs";
import { createSlugRegistry } from "./slug.mjs";

export function createTreeContext({ notion, config, warn }) {
  return {
    notion,
    config,
    warn,
    slugs: createSlugRegistry(),
    idToSlug: new Map(), // normalizedId -> slug (내부 링크 치환용)
  };
}

// 한 페이지의 "직속 하위 페이지/DB" 를 찾는다.
// child_page/child_database 는 컬럼·토글·콜아웃·synced_block 등 컨테이너 안에
// 중첩돼 있을 수 있으므로, 컨테이너 블록 내부까지 재귀로 훑어서 수집한다.
// (child_page 경계는 넘지 않는다 — 그 내부는 buildTree 가 별도로 처리)
async function findChildRefs(ctx, blockId) {
  const refs = [];
  let blocks = [];
  try {
    blocks = await listAllChildren(ctx.notion, blockId);
  } catch (e) {
    ctx.warn(`children 조회 실패(${blockId}): ${e.message}`);
    return refs;
  }
  for (const block of blocks) {
    if (block.type === "child_page") {
      refs.push({ kind: "page", id: block.id, title: block.child_page?.title || "Untitled" });
    } else if (block.type === "child_database") {
      refs.push({ kind: "db", id: block.id });
    } else if (block.has_children) {
      refs.push(...(await findChildRefs(ctx, block.id)));
    }
  }
  return refs;
}

export async function buildTree(ctx, { pageId, title, isRoot = false }) {
  const normId = normalizeId(pageId);
  const slug = isRoot ? "Home" : ctx.slugs.take(title);
  ctx.idToSlug.set(normId, slug);

  const node = { id: pageId, normId, title, slug, children: [] };

  for (const ref of await findChildRefs(ctx, pageId)) {
    if (ref.kind === "page") {
      node.children.push(await buildTree(ctx, { pageId: ref.id, title: ref.title }));
      continue;
    }
    // 데이터베이스: 각 행(페이지)을 하위 페이지로 취급 (그 페이지도 재귀 파싱)
    try {
      for (const dbPage of await queryAllDbPages(ctx.notion, ref.id)) {
        node.children.push(await buildTree(ctx, { pageId: dbPage.id, title: extractTitle(dbPage) }));
      }
    } catch (e) {
      ctx.warn(`데이터베이스 조회 실패(${ref.id}): ${e.message}`);
    }
  }
  return node;
}

/** 트리를 깊이 우선 배열로 편다. */
export function flatten(root) {
  const all = [];
  (function walk(node) {
    all.push(node);
    node.children.forEach(walk);
  })(root);
  return all;
}
