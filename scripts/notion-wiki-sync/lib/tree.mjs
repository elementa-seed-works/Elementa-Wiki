// 페이지 트리 구성
//
// 노션 구조 → 위키 계층으로 옮기는 규칙
//  - child_page 는 그대로 하위 페이지가 된다.
//  - 데이터베이스는 "그룹 노드" 가 되고, 행(row)들이 그 아래에 붙는다.
//    (예전에는 행이 루트 직속으로 쏟아져 Home 하위 목록이 평면 100줄이 됐다)
//  - 데이터베이스가 자기참조 관계(상위 항목/하위 항목)를 가지면 그 관계로 계층을 복원하고,
//    자식 순서는 "하위 항목" 관계 배열의 순서를 그대로 쓴다(노션에서 정렬한 순서).
//  - NOTION_HOME_PAGE_ID 로 지정한 페이지는 Home 으로 흡수되고 별도 문서를 만들지 않는다.

import {
  dateValue,
  extractEmojiIcon,
  extractTitle,
  listAllChildren,
  normalizeId,
  queryAllDbPages,
  relationIds,
  retrieveDatabase,
  retrievePage,
  splitLeadingEmoji,
} from "./notion.mjs";
import { createSlugRegistry } from "./slug.mjs";

const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

export function createTreeContext({ notion, config, warn }) {
  return {
    notion,
    config,
    warn,
    slugs: createSlugRegistry(),
    idToSlug: new Map(), // normalizedId -> slug (내부 링크 치환용)
    idToNode: new Map(), // normalizedId -> node (트리 완성 후 채운다)
    visited: new Set(),
    skipped: new Set((config.skipIds || []).map(normalizeId)),
  };
}

function makeNode(fields) {
  return {
    kind: "page",
    id: "",
    normId: "",
    title: "Untitled",
    icon: "",
    slug: "",
    url: "",
    date: "",
    lastEdited: "",
    dateProp: "",
    children: [],
    parent: null,
    depth: 0,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// 트리 진입점
// ---------------------------------------------------------------------------

export async function buildTree(ctx, { rootId, rootTitle, rootIcon = "", homeId = "" }) {
  const root = makeNode({
    id: rootId,
    normId: normalizeId(rootId),
    title: rootTitle,
    icon: rootIcon,
    slug: "Home",
  });
  ctx.visited.add(root.normId);
  ctx.idToSlug.set(root.normId, "Home");
  if (homeId) {
    ctx.visited.add(normalizeId(homeId));
    ctx.idToSlug.set(normalizeId(homeId), "Home");
  }

  root.children = await collectChildren(ctx, rootId, homeId);
  linkParents(root, null, 0);
  return root;
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

export function countDescendants(node) {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

function linkParents(node, parent, depth) {
  node.parent = parent;
  node.depth = depth;
  for (const child of node.children) linkParents(child, node, depth + 1);
}

// ---------------------------------------------------------------------------
// 직속 하위 수집
// ---------------------------------------------------------------------------

// child_page/child_database 는 컬럼·토글·콜아웃·synced_block 안에 중첩돼 있을 수 있으므로
// 컨테이너 블록 내부까지 재귀로 훑는다. (child_page 경계는 넘지 않는다)
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

async function collectChildren(ctx, blockId, homeId) {
  const refs = await findChildRefs(ctx, blockId);
  const nodes = [];
  for (const ref of refs) {
    if (ctx.skipped.has(normalizeId(ref.id))) continue;
    if (ref.kind === "db") {
      const dbNode = await buildDatabaseNode(ctx, ref.id);
      if (dbNode) nodes.push(dbNode);
      continue;
    }
    const norm = normalizeId(ref.id);
    if (homeId && norm === normalizeId(homeId)) {
      // Home 으로 쓰이는 페이지는 문서를 따로 만들지 않고, 그 하위만 Home 아래로 끌어올린다.
      nodes.push(...(await collectChildren(ctx, ref.id, "")));
      continue;
    }
    if (ctx.visited.has(norm)) continue;
    nodes.push(await buildPageNode(ctx, { id: ref.id, title: ref.title }));
  }
  return nodes;
}

async function buildPageNode(ctx, { id, title, page = null }) {
  const norm = normalizeId(id);
  ctx.visited.add(norm);

  let meta = page;
  if (!meta) {
    try {
      meta = await retrievePage(ctx.notion, id);
    } catch (e) {
      ctx.warn(`페이지 메타 조회 실패(${title || id}): ${e.message}`);
    }
  }

  const node = makeNode({
    id,
    normId: norm,
    title: title || (meta ? extractTitle(meta) : "Untitled"),
    icon: meta ? extractEmojiIcon(meta) : "",
    url: meta?.url || "",
    lastEdited: meta?.last_edited_time || "",
  });
  node.slug = ctx.slugs.take(node.title);
  ctx.idToSlug.set(norm, node.slug);

  node.children = await collectChildren(ctx, id, "");
  return node;
}

// ---------------------------------------------------------------------------
// 데이터베이스 → 그룹 노드
// ---------------------------------------------------------------------------

async function buildDatabaseNode(ctx, dbId) {
  let db;
  try {
    db = await retrieveDatabase(ctx.notion, dbId);
  } catch (e) {
    ctx.warn(`데이터베이스 조회 실패(${dbId}): ${e.message}`);
    return null;
  }

  const { icon: titleIcon, text } = splitLeadingEmoji(extractTitle(db));
  const node = makeNode({
    kind: "db",
    id: dbId,
    normId: normalizeId(dbId),
    title: text,
    icon: extractEmojiIcon(db) || titleIcon,
    url: db.url || "",
  });
  node.slug = ctx.slugs.take(node.title);
  ctx.idToSlug.set(node.normId, node.slug);

  let pages = [];
  try {
    pages = await queryAllDbPages(ctx.notion, dbId);
  } catch (e) {
    ctx.warn(`데이터베이스 행 조회 실패(${node.title}): ${e.message}`);
    return node;
  }

  const { parentProp, childProp } = pickHierarchyProps(db, ctx.config.parentPropOverride);
  node.dateProp = pickDateProp(db);

  // 행끼리 child_page 로 서로를 다시 물지 않도록 먼저 전부 방문 표시한다.
  for (const page of pages) ctx.visited.add(normalizeId(page.id));

  const rowNodes = new Map();
  for (const page of pages) {
    const rowNode = await buildPageNode(ctx, { id: page.id, title: extractTitle(page), page });
    rowNode.date = node.dateProp ? dateValue(page, node.dateProp) : "";
    rowNodes.set(normalizeId(page.id), rowNode);
  }

  node.children = arrangeRows({ pages, rowNodes, parentProp, childProp, dateProp: node.dateProp });
  return node;
}

/** 자기참조 관계 속성 중 부모 쪽/자식 쪽을 고른다. 못 고르면 계층 없이 평면으로 둔다. */
function pickHierarchyProps(db, override) {
  const dbNorm = normalizeId(db.id);
  const relations = Object.entries(db.properties || {}).filter(([, p]) => p.type === "relation");
  const selfMatched = relations.filter(
    ([, p]) => normalizeId(p.relation?.database_id || p.relation?.data_source_id || "") === dbNorm,
  );
  const names = (selfMatched.length ? selfMatched : relations).map(([name]) => name);
  if (!names.length) return { parentProp: "", childProp: "" };

  const parentProp =
    (override && names.includes(override) && override) ||
    names.find((n) => /상위|부모|parent/i.test(n)) ||
    "";
  const childProp = names.find((n) => n !== parentProp && /하위|자식|child|sub/i.test(n)) || "";
  return { parentProp, childProp };
}

function pickDateProp(db) {
  const entry = Object.entries(db.properties || {}).find(([, p]) => p.type === "date");
  return entry ? entry[0] : "";
}

/** 관계로 부모-자식을 이어 붙이고, 부모가 없는 행만 돌려준다. */
function arrangeRows({ pages, rowNodes, parentProp, childProp, dateProp }) {
  const pageById = new Map(pages.map((p) => [normalizeId(p.id), p]));
  const attached = new Map(); // parentNormId -> [childNode]
  const tops = [];

  for (const [id, node] of rowNodes) {
    const parentId = parentProp ? relationIds(pageById.get(id), parentProp)[0] : null;
    if (!parentId || parentId === id || !rowNodes.has(parentId)) {
      tops.push(node);
      continue;
    }
    node.parentRowId = parentId;
    if (!attached.has(parentId)) attached.set(parentId, []);
    attached.get(parentId).push(node);
  }

  // 관계가 순환(A→B→A)하면 트리를 만들 수 없으므로 해당 행을 최상위로 되돌린다.
  for (const [id, node] of rowNodes) {
    if (!node.parentRowId || !isCyclic(id, rowNodes)) continue;
    const siblings = attached.get(node.parentRowId) || [];
    const at = siblings.indexOf(node);
    if (at >= 0) siblings.splice(at, 1);
    node.parentRowId = null;
    tops.push(node);
  }

  for (const [parentId, kids] of attached) {
    const order = childProp ? relationIds(pageById.get(parentId), childProp) : [];
    rowNodes.get(parentId).children.push(...orderRows(kids, order, dateProp));
  }

  return sortRows(tops, dateProp);
}

function isCyclic(startId, rowNodes) {
  const seen = new Set();
  let cur = startId;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = rowNodes.get(cur)?.parentRowId || null;
  }
  return false;
}

/** 노션의 "하위 항목" 관계 배열 순서를 우선 따르고, 거기 없는 행은 뒤로 보낸다. */
function orderRows(nodes, order, dateProp) {
  if (!order.length) return sortRows(nodes, dateProp);
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...nodes].sort((a, b) => {
    const ra = rank.has(a.normId) ? rank.get(a.normId) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.normId) ? rank.get(b.normId) : Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : collator.compare(a.title, b.title);
  });
}

/** 날짜 속성이 있으면 최신순, 없으면 제목 자연순(1-2 가 1-10 보다 앞). */
function sortRows(nodes, dateProp) {
  const sorted = [...nodes];
  if (dateProp) {
    sorted.sort((a, b) => (b.date || "").localeCompare(a.date || "") || collator.compare(a.title, b.title));
  } else {
    sorted.sort((a, b) => collator.compare(a.title, b.title));
  }
  return sorted;
}
