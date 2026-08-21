// 테스트용 노션 응답 조립기와 가짜 클라이언트
//
// 가짜 클라이언트는 등록되지 않은 조회를 만나면 예외를 던진다.
// "증분 실행이 블록을 부르지 않는다" 같은 성질을 호출 기록으로 확인하려는 것이다.

import { normalizeId } from "../lib/notion.mjs";

/** 32자리 hex ID 를 만든다(1 → 111...1). */
export function id(n) {
  return String(n).repeat(32).slice(0, 32);
}

export function norm(n) {
  return normalizeId(id(n));
}

export function pageRaw(n, { parent, title = `page-${n}`, lastEdited = "2026-01-01T00:00:00.000Z", properties = {} } = {}) {
  return {
    object: "page",
    id: id(n),
    last_edited_time: lastEdited,
    url: `https://www.notion.so/${id(n)}`,
    parent,
    properties: { 이름: { type: "title", title: [{ plain_text: title }] }, ...properties },
  };
}

export function dbRaw(n, { parent, title = `db-${n}`, lastEdited = "2026-01-01T00:00:00.000Z", properties = {} } = {}) {
  return {
    object: "database",
    id: id(n),
    last_edited_time: lastEdited,
    url: `https://www.notion.so/${id(n)}`,
    parent,
    title: [{ plain_text: title }],
    properties,
  };
}

export const pageParent = (n) => ({ type: "page_id", page_id: id(n) });
export const dbParent = (n) => ({ type: "database_id", database_id: id(n) });
export const blockParent = (blockId) => ({ type: "block_id", block_id: blockId });

export function childPageBlock(n, title = `page-${n}`) {
  return { object: "block", id: id(n), type: "child_page", has_children: true, child_page: { title } };
}

export function childDbBlock(n, title = `db-${n}`) {
  return { object: "block", id: id(n), type: "child_database", has_children: false, child_database: { title } };
}

export function paragraphBlock(blockId, { text = "본문" } = {}) {
  return {
    object: "block",
    id: blockId,
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: text, link: null },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
          plain_text: text,
          href: null,
        },
      ],
      color: "default",
    },
  };
}

/**
 * 가짜 노션 클라이언트.
 *
 * @param {{blocks?: Record<string, object[]>, entities?: Record<string, object>, search?: object[]}} fixtures
 *        blocks 는 blockId → children 배열, entities 는 id → 페이지/DB 원본 객체.
 */
export function fakeNotion({ blocks = {}, entities = {}, search = [] } = {}) {
  const calls = { blockLists: [], retrieves: [], blockRetrieves: [], searches: 0 };
  // 실제 API 는 대시 유무를 가리지 않는다. 픽스처도 정규화해 두고 찾는다.
  const normalizeKeys = (map) => new Map(Object.entries(map).map(([k, v]) => [normalizeId(k), v]));
  const blockFixtures = normalizeKeys(blocks);
  const entityFixtures = normalizeKeys(entities);
  const lookup = (map, key, label) => {
    const found = map.get(normalizeId(key));
    if (found === undefined) throw new Error(`${label} 픽스처 없음: ${key}`);
    if (found instanceof Error) throw found; // 오류 응답을 흉내 낼 때
    return found;
  };

  return {
    calls,
    apiStats: { requests: 0, retries: 0, rateLimited: 0, waitedMs: 0, cacheHits: 0 },
    blocks: {
      children: {
        list: async ({ block_id }) => {
          calls.blockLists.push(block_id);
          return { results: lookup(blockFixtures, block_id, "블록"), has_more: false, next_cursor: null };
        },
      },
      retrieve: async ({ block_id }) => {
        calls.blockRetrieves.push(block_id);
        return lookup(entityFixtures, block_id, "블록");
      },
    },
    pages: {
      retrieve: async ({ page_id }) => {
        calls.retrieves.push(page_id);
        return lookup(entityFixtures, page_id, "페이지");
      },
    },
    databases: {
      retrieve: async ({ database_id }) => {
        calls.retrieves.push(database_id);
        return lookup(entityFixtures, database_id, "데이터베이스");
      },
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    search: async () => {
      calls.searches++;
      return { results: search, has_more: false, next_cursor: null };
    },
  };
}

/** 노션이 돌려주는 오류를 흉내 낸다. */
export function notionError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/** 테스트용 설정 (config.mjs 의 기본값과 같은 모양) */
export function testConfig(overrides = {}) {
  return {
    notionToken: "test",
    rootPageId: id(1),
    homePageId: "",
    parentPropOverride: "",
    skipIds: [],
    wikiTitle: "테스트 위키",
    outputDir: "/tmp/wiki-test",
    assetsSubdir: "assets",
    skipImages: true,
    forceFull: false,
    minIntervalMs: 0,
    maxRetries: 0,
    preview: false,
    ...overrides,
  };
}

/** 노드 배열에서 제목만 뽑는다. */
export function titles(nodes) {
  return nodes.map((n) => n.title);
}
