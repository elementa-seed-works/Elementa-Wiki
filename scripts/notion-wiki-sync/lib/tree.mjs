// 페이지 트리 구성
//
// 트리 모양은 카탈로그(search 결과)의 부모 포인터로 만든다. 블록 조회는 다음 두 경우에만 한다.
//  - 페이지가 수정됐다(형제 순서가 바뀌었을 수 있다)
//  - 이전 실행에서 기록해 둔 자식 순서에 없는 자식이 있다(새로 생겼다)
// 그 외에는 이전 순서를 그대로 재사용한다. 이것이 rate limit 을 피하는 핵심이다.
//
// 노션 구조 → 위키 계층으로 옮기는 규칙
//  - child_page 는 그대로 하위 페이지가 된다.
//  - 데이터베이스는 "그룹 노드" 가 되고, 행(row)들이 그 아래에 붙는다.
//  - 데이터베이스가 자기참조 관계(상위 항목/하위 항목)를 가지면 그 관계로 계층을 복원하고,
//    자식 순서는 "하위 항목" 관계 배열의 순서를 그대로 쓴다(노션에서 정렬한 순서).
//    관계·날짜 속성은 검색 결과에 함께 오므로 데이터베이스는 블록을 훑지 않는다.
//  - NOTION_HOME_PAGE_ID 로 지정한 페이지는 Home 으로 흡수되고 별도 문서를 만들지 않는다.

import { dateValue, listAllChildren, normalizeId, relationIds } from "./notion.mjs";
import { adoptEntry } from "./catalog.mjs";
import { createSlugRegistry, slugify } from "./slug.mjs";

const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

export function createTreeContext({ notion, config, warn, state = null }) {
  return {
    notion,
    config,
    warn,
    state,
    forceFull: Boolean(config.forceFull) || !state,
    slugs: createSlugRegistry(),
    idToSlug: new Map(), // normalizedId -> slug (내부 링크 치환용)
    idToNode: new Map(), // normalizedId -> node (트리 완성 후 채운다)
    visited: new Set(),
    skipped: new Set((config.skipIds || []).map(normalizeId)),
    orderRefreshes: 0, // 블록을 다시 훑은 페이지 수 (요약용)
    adopted: 0, // 검색 목록에 없어 개별 조회한 항목 수
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
    changed: true,
    dateProp: "",
    children: [],
    parent: null,
    depth: 0,
    ...fields,
  };
}

/** 이전 실행 이후 이 페이지가 바뀌었는지 판정한다. */
function isChanged(ctx, normId, lastEdited) {
  if (ctx.forceFull) return true;
  const prev = ctx.state?.pages?.[normId];
  return !prev || prev.lastEdited !== lastEdited;
}

function cachedOrder(ctx, normId) {
  const order = ctx.state?.pages?.[normId]?.childOrder;
  return Array.isArray(order) ? order : null;
}

// ---------------------------------------------------------------------------
// 트리 진입점
// ---------------------------------------------------------------------------

/**
 * 카탈로그로부터 위키 트리를 만든다.
 *
 * @param {object} ctx createTreeContext 결과
 * @param {{catalog: Map<string, object>, byParent: Map<string, object[]>,
 *          rootId: string, rootTitle: string, rootIcon?: string, homeId?: string}} params
 * @returns {Promise<object>} 루트 노드
 */
export async function buildTree(ctx, { catalog, byParent, rootId, rootTitle, rootIcon = "", homeId = "" }) {
  const index = { catalog, byParent };
  const rootNorm = normalizeId(rootId);
  const homeNorm = homeId ? normalizeId(homeId) : "";

  // Home 본문은 홈 페이지에서 오므로, 둘 중 하나만 바뀌어도 Home 을 다시 만들어야 한다.
  const rootEdited = [catalog.get(rootNorm)?.lastEdited || "", homeNorm ? catalog.get(homeNorm)?.lastEdited || "" : ""]
    .filter(Boolean)
    .join("|");

  const root = makeNode({
    id: rootId,
    normId: rootNorm,
    title: rootTitle,
    icon: rootIcon,
    slug: "Home",
    lastEdited: rootEdited,
    changed: isChanged(ctx, rootNorm, rootEdited),
  });
  ctx.visited.add(rootNorm);
  if (homeNorm) ctx.visited.add(homeNorm);

  root.children = await buildChildren(ctx, root, index, homeNorm);
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

/**
 * 파일명을 정한다. 제목이 그대로인 문서는 이전 슬러그를 그대로 쓴다.
 * (새 페이지가 끼어들어 기존 문서 파일명이 밀리면 위키 링크가 통째로 깨진다)
 */
export function assignSlugs(ctx, root) {
  const nodes = flatten(root).filter((n) => n !== root);
  root.slug = "Home";
  ctx.idToSlug.set(root.normId, "Home");
  if (ctx.config.homePageId) ctx.idToSlug.set(normalizeId(ctx.config.homePageId), "Home");

  for (const node of nodes) {
    const prev = ctx.state?.pages?.[node.normId]?.slug;
    if (prev && keepsSlug(prev, node.title) && ctx.slugs.claim(prev)) node.slug = prev;
  }
  for (const node of nodes) {
    if (!node.slug) node.slug = ctx.slugs.take(node.title);
  }
  for (const node of nodes) ctx.idToSlug.set(node.normId, node.slug);
}

/** 이전 슬러그가 지금 제목에서도 나올 수 있는 이름인지 (충돌 접미사 -2 는 허용). */
function keepsSlug(prevSlug, title) {
  const base = slugify(title);
  if (prevSlug === base) return true;
  return prevSlug.startsWith(`${base}-`) && /^\d+$/.test(prevSlug.slice(base.length + 1));
}

// ---------------------------------------------------------------------------
// 하위 수집
// ---------------------------------------------------------------------------

async function buildChildren(ctx, node, index, homeNorm = "") {
  let entries = childEntries(ctx, index, node.normId);
  if (homeNorm) {
    // Home 으로 흡수되는 페이지는 문서를 따로 만들지 않고, 그 하위만 Home 아래로 끌어올린다.
    entries = entries.filter((e) => e.normId !== homeNorm).concat(childEntries(ctx, index, homeNorm));
  }

  let order = cachedOrder(ctx, node.normId);
  const known = new Set(entries.map((e) => e.normId));
  if (needsOrderRefresh(ctx, node, order, known)) {
    order = await refreshOrder(ctx, node, index, homeNorm, entries);
  }

  const nodes = [];
  for (const entry of sortByOrder(entries, order)) {
    const child = await buildNode(ctx, entry, index);
    if (child) nodes.push(child);
  }
  return nodes;
}

function childEntries(ctx, index, parentId) {
  return (index.byParent.get(parentId) || []).filter((e) => !ctx.skipped.has(e.normId));
}

/** 캐시된 순서를 믿을 수 없는 조건. 여기서만 블록을 다시 훑는다. */
function needsOrderRefresh(ctx, node, order, known) {
  if (ctx.forceFull || node.changed || !order) return true;
  for (const id of known) {
    if (!order.includes(id)) return true;
  }
  return false;
}

/**
 * 블록을 훑어 자식 순서를 다시 읽는다. 검색 목록에 없던 항목은 이 자리에서 개별 조회해 채운다.
 * @returns {Promise<string[]>} 정규화된 자식 ID 배열(노션에 보이는 순서)
 */
async function refreshOrder(ctx, node, index, homeNorm, entries) {
  ctx.orderRefreshes++;
  const refs = await scanRefs(ctx, node.id, homeNorm);
  for (const ref of refs) {
    const norm = normalizeId(ref.id);
    if (ctx.skipped.has(norm) || index.catalog.has(norm)) continue;
    const entry = await adoptEntry(ctx.notion, { ...ref, id: norm }, node.normId, ctx.warn);
    if (!entry) continue;
    ctx.adopted++;
    index.catalog.set(entry.normId, entry);
    entries.push(entry);
  }
  return refs.map((ref) => normalizeId(ref.id));
}

/** 루트에서는 Home 으로 흡수되는 페이지 자리에 그 하위를 펼쳐 넣는다. */
async function scanRefs(ctx, blockId, homeNorm) {
  const refs = await findChildRefs(ctx, blockId);
  if (!homeNorm) return refs;
  const out = [];
  for (const ref of refs) {
    if (normalizeId(ref.id) === homeNorm) out.push(...(await findChildRefs(ctx, ref.id)));
    else out.push(ref);
  }
  return out;
}

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
      refs.push({ kind: "db", id: block.id, title: block.child_database?.title || "" });
    } else if (block.has_children) {
      refs.push(...(await findChildRefs(ctx, block.id)));
    }
  }
  return refs;
}

/** 순서 배열을 기준으로 정렬한다. 배열에 없는 항목은 뒤로 보내고 제목 자연순으로 맞춘다. */
function sortByOrder(entries, order) {
  const rank = new Map((order || []).map((id, i) => [id, i]));
  return [...entries].sort((a, b) => {
    const ra = rank.has(a.normId) ? rank.get(a.normId) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.normId) ? rank.get(b.normId) : Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : collator.compare(a.title, b.title);
  });
}

async function buildNode(ctx, entry, index) {
  if (ctx.visited.has(entry.normId)) return null;
  ctx.visited.add(entry.normId);

  const node = makeNode({
    kind: entry.kind,
    id: entry.id,
    normId: entry.normId,
    title: entry.title,
    icon: entry.icon,
    url: entry.url,
    lastEdited: entry.lastEdited,
    changed: isChanged(ctx, entry.normId, entry.lastEdited),
  });

  node.children =
    entry.kind === "db" ? await buildDatabaseChildren(ctx, node, entry, index) : await buildChildren(ctx, node, index);
  return node;
}

// ---------------------------------------------------------------------------
// 데이터베이스 → 그룹 노드
// ---------------------------------------------------------------------------

async function buildDatabaseChildren(ctx, node, entry, index) {
  const rows = childEntries(ctx, index, node.normId);
  if (!rows.length) return [];

  const { parentProp, childProp } = pickHierarchyProps(entry, ctx.config.parentPropOverride);
  node.dateProp = pickDateProp(entry);

  const rowNodes = new Map();
  for (const row of rows) {
    const rowNode = await buildNode(ctx, row, index);
    if (!rowNode) continue;
    rowNode.date = node.dateProp ? dateValue(row, node.dateProp) : "";
    rowNodes.set(row.normId, rowNode);
  }

  return arrangeRows({ rows, rowNodes, parentProp, childProp, dateProp: node.dateProp });
}

/** 자기참조 관계 속성 중 부모 쪽/자식 쪽을 고른다. 못 고르면 계층 없이 평면으로 둔다. */
export function pickHierarchyProps(db, override) {
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
export function arrangeRows({ rows, rowNodes, parentProp, childProp, dateProp }) {
  const rowById = new Map(rows.map((r) => [r.normId, r]));
  const attached = new Map(); // parentNormId -> [childNode]
  const tops = [];

  for (const [id, node] of rowNodes) {
    const parentId = parentProp ? relationIds(rowById.get(id), parentProp)[0] : null;
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
    const order = childProp ? relationIds(rowById.get(parentId), childProp) : [];
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
