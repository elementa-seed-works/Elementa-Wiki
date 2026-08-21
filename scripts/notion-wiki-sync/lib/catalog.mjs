// 노션 페이지 목록(카탈로그) 수집
//
// search 한 번으로 통합이 접근할 수 있는 페이지·데이터베이스를 100건 단위로 받아온다.
// 응답에 parent 와 last_edited_time 이 들어 있어, 블록을 훑지 않고도
//  - 트리 모양(부모 → 자식)
//  - 무엇이 바뀌었는지(수정 시각 비교)
// 를 알 수 있다. 블록 조회는 변경된 페이지에만 건다.
//
// 검색 인덱스는 몇 초에서 몇 분 늦을 수 있다. 방금 만든 페이지가 목록에 없으면
// 상위 페이지의 블록에서 참조를 발견한 쪽에서 adoptEntry 로 개별 조회해 채운다.

import {
  extractEmojiIcon,
  extractTitle,
  normalizeId,
  retrieveBlock,
  retrieveDatabase,
  retrievePage,
  searchAll,
  splitLeadingEmoji,
} from "./notion.mjs";

// 블록 부모를 거슬러 올라갈 때의 상한. 정상 문서는 몇 단계면 페이지에 닿는다.
const MAX_PARENT_HOPS = 8;

/** 노션 parent 객체를 {type, id} 로 정규화한다. */
function parentRef(parent) {
  switch (parent?.type) {
    case "page_id":
      return { type: "page", id: normalizeId(parent.page_id) };
    case "database_id":
      return { type: "db", id: normalizeId(parent.database_id) };
    case "data_source_id":
      return { type: "db", id: normalizeId(parent.data_source_id) };
    case "block_id":
      return { type: "block", id: normalizeId(parent.block_id) };
    default:
      return { type: "workspace", id: "" };
  }
}

/** 검색 결과/개별 조회 결과를 카탈로그 항목으로 만든다. */
export function toEntry(raw) {
  const isDb = raw.object === "database";
  const rawTitle = extractTitle(raw);
  // 데이터베이스는 제목 앞에 이모지를 직접 넣는 경우가 많아 아이콘으로 분리한다.
  const { icon: titleIcon, text } = isDb ? splitLeadingEmoji(rawTitle) : { icon: "", text: rawTitle };
  return {
    id: raw.id,
    normId: normalizeId(raw.id),
    kind: isDb ? "db" : "page",
    title: text || "Untitled",
    icon: extractEmojiIcon(raw) || titleIcon,
    url: raw.url || "",
    lastEdited: raw.last_edited_time || "",
    parent: parentRef(raw.parent),
    properties: raw.properties || {},
  };
}

function isDropped(raw) {
  return raw?.archived === true || raw?.in_trash === true;
}

/**
 * 카탈로그를 만든다.
 *
 * @param {object} notion Notion 클라이언트
 * @param {{blockOwners?: Record<string, string>, warn?: (msg: string) => void}} options
 *        blockOwners 는 이전 실행에서 해석해 둔 "블록 → 소유 페이지" 맵이다(재조회 생략용).
 * @returns {Promise<{entries: Map<string, object>, blockOwners: Record<string, string>}>}
 */
export async function buildCatalog(notion, { blockOwners = {}, warn = () => {} } = {}) {
  const results = await searchAll(notion);
  const entries = new Map();
  for (const raw of results) {
    if (isDropped(raw)) continue;
    const entry = toEntry(raw);
    entries.set(entry.normId, entry);
  }

  // 컬럼·토글 안에 든 페이지는 부모가 블록으로 잡힌다. 소유 페이지까지 거슬러 올라가 트리에 붙인다.
  const owners = { ...blockOwners };
  for (const entry of entries.values()) {
    if (entry.parent.type !== "block") continue;
    entry.parent = await resolveBlockOwner(notion, entry.parent.id, owners, warn);
  }

  return { entries, blockOwners: owners };
}

/** 블록의 부모를 페이지/데이터베이스에 닿을 때까지 거슬러 올라간다. */
async function resolveBlockOwner(notion, blockId, owners, warn) {
  const chain = [];
  let cursor = blockId;
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
    const cached = owners[cursor];
    if (cached) {
      for (const id of chain) owners[id] = cached;
      return { type: "page", id: cached };
    }
    let block;
    try {
      block = await retrieveBlock(notion, cursor);
    } catch (e) {
      warn(`블록 부모 조회 실패(${cursor}): ${e.message}`);
      return { type: "workspace", id: "" };
    }
    const parent = parentRef(block.parent);
    if (parent.type !== "block") {
      for (const id of [...chain, cursor]) owners[id] = parent.id;
      return parent;
    }
    chain.push(cursor);
    cursor = parent.id;
  }
  warn(`블록 부모를 ${MAX_PARENT_HOPS}단계 안에 찾지 못함(${blockId})`);
  return { type: "workspace", id: "" };
}

/**
 * 검색 목록에 아직 없는 페이지/데이터베이스를 개별 조회해 카탈로그 항목으로 만든다.
 * (검색 인덱스 지연으로 새 페이지가 빠졌을 때 쓴다)
 *
 * @param {object} notion
 * @param {{kind: "page"|"db", id: string}} ref 상위 페이지 블록에서 발견한 참조
 * @param {string} parentId 이 항목을 매달 상위 페이지 ID(정규화됨)
 * @returns {Promise<object|null>}
 */
export async function adoptEntry(notion, ref, parentId, warn = () => {}) {
  try {
    const raw = ref.kind === "db" ? await retrieveDatabase(notion, ref.id) : await retrievePage(notion, ref.id);
    if (isDropped(raw)) return null;
    const entry = toEntry(raw);
    entry.parent = { type: "page", id: parentId };
    return entry;
  } catch (e) {
    warn(`검색에 없는 항목 조회 실패(${ref.title || ref.id}): ${e.message}`);
    return null;
  }
}

/**
 * 직전 실행에는 있었는데 이번 목록에 없는 항목을 개별 조회해 확인한다.
 *
 * 목록에서 빠졌다는 것만으로 지우면, 검색 응답이 일부만 왔을 때 멀쩡한 문서가 위키에서 사라진다.
 * 되돌리기 어려운 쪽이므로 지우기 전에 한 번 물어본다. 요청은 없어진 항목 수만큼만 나간다.
 *
 * 접근할 수 없는 페이지에도 노션은 object_not_found 를 준다. 통합 연결이 끊긴 경우도
 * 삭제와 같게 다루는 것이 맞다(어차피 본문을 가져올 수 없다).
 *
 * @returns {Promise<object[]>} 되살린 항목
 */
export async function recoverMissing(notion, { entries, statePages = {}, blockOwners = {}, warn = () => {} }) {
  const recovered = [];
  for (const [normId, prev] of Object.entries(statePages)) {
    if (entries.has(normId)) continue;
    const raw = await retrieveOrNull(notion, prev.kind, normId, warn);
    if (!raw || isDropped(raw)) continue;
    const entry = toEntry(raw);
    if (entry.parent.type === "block") {
      entry.parent = await resolveBlockOwner(notion, entry.parent.id, blockOwners, warn);
    }
    entries.set(entry.normId, entry);
    recovered.push(entry);
  }
  return recovered;
}

/** 없어진 항목이면 null, 그 밖의 오류는 그대로 던진다(잘못 지우느니 실행을 멈춘다). */
async function retrieveOrNull(notion, kind, normId, warn) {
  try {
    return kind === "db" ? await retrieveDatabase(notion, normId) : await retrievePage(notion, normId);
  } catch (e) {
    if (e?.code === "object_not_found") return null;
    if (e?.code === "validation_error") {
      warn(`상태 파일의 ID 를 조회할 수 없습니다(${normId}): ${e.message}`);
      return null;
    }
    throw e;
  }
}

/** 카탈로그를 부모 기준으로 묶는다. */
export function groupByParent(entries) {
  const byParent = new Map();
  for (const entry of entries.values()) {
    const parentId = entry.parent.id;
    if (!parentId) continue;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(entry);
  }
  return byParent;
}
