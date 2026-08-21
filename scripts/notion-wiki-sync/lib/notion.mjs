// Notion API 접근 계층
//
// 페이지네이션과 값 추출에 더해, 호출 자체를 감싸는 세 가지를 여기서 처리한다.
//  - 스로틀: 통합당 평균 초당 3회 제한에 맞춰 호출 사이에 최소 간격을 둔다.
//  - 재시도: 429(rate_limited)는 Retry-After 를, 일시적 5xx·타임아웃은 지수 백오프를 따른다.
//  - 블록 메모: 같은 실행에서 같은 블록의 children 을 두 번 조회하지 않는다.
//    (트리 순서 파악과 마크다운 변환이 같은 블록을 훑는다)
//
// 트리 구성·마크다운 변환 같은 판단은 상위 모듈이 한다.

import { Client, APIErrorCode, ClientErrorCode } from "@notionhq/client";

const RETRYABLE = new Set([
  APIErrorCode.RateLimited,
  APIErrorCode.ConflictError,
  APIErrorCode.InternalServerError,
  APIErrorCode.ServiceUnavailable,
  ClientErrorCode.RequestTimeout,
  ClientErrorCode.ResponseError,
]);

const MAX_BACKOFF_MS = 60_000;
// 블록 응답 메모 상한. 변경된 페이지 묶음을 담기에 충분하고, 전체 동기화에서도 메모리가 튀지 않는다.
const BLOCK_CACHE_LIMIT = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 호출을 직렬화하고 최소 간격을 강제하는 실행기를 만든다.
 *
 * @param {number} minIntervalMs 직전 호출 시작 시점 대비 최소 간격
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
function createLimiter(minIntervalMs) {
  let chain = Promise.resolve();
  let lastStart = 0;
  return function schedule(task) {
    const run = async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      return task();
    };
    const result = chain.then(run, run);
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

function errorCode(error) {
  return error?.code || "";
}

/** 429 의 Retry-After 헤더를 밀리초로 읽는다. 헤더가 Headers 객체든 평범한 객체든 처리한다. */
function retryAfterMs(error) {
  const headers = error?.headers;
  const raw = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/** 재시도할 오류면 대기 시간(ms)을, 아니면 null 을 돌려준다. */
export function retryDelay(error, attempt) {
  const code = errorCode(error);
  if (!RETRYABLE.has(code)) return null;
  const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  if (code === APIErrorCode.RateLimited) {
    return Math.min(MAX_BACKOFF_MS, Math.max(retryAfterMs(error), backoff));
  }
  return backoff;
}

function createApiStats() {
  return { requests: 0, retries: 0, rateLimited: 0, waitedMs: 0, cacheHits: 0 };
}

/**
 * Notion 클라이언트를 만든다. 모든 요청에 스로틀과 재시도가 걸린 상태로 돌려준다.
 * 호출 통계는 `client.apiStats` 에 누적된다.
 *
 * @param {string} token 통합 토큰
 * @param {{minIntervalMs?: number, maxRetries?: number, warn?: (msg: string) => void, fetch?: Function}} options
 *        fetch 는 SDK 가 쓸 HTTP 구현이다. 테스트에서 응답을 지정할 때만 넘긴다.
 */
export function createClient(token, { minIntervalMs = 350, maxRetries = 5, warn = () => {}, fetch } = {}) {
  const client = new Client(fetch ? { auth: token, fetch } : { auth: token });
  const stats = createApiStats();
  const schedule = createLimiter(minIntervalMs);

  async function call(label, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        stats.requests++;
        return await schedule(fn);
      } catch (e) {
        const delay = retryDelay(e, attempt);
        if (delay === null || attempt >= maxRetries) throw e;
        stats.retries++;
        if (errorCode(e) === APIErrorCode.RateLimited) stats.rateLimited++;
        stats.waitedMs += delay;
        warn(`${label} 재시도 ${attempt + 1}/${maxRetries} (${errorCode(e)}) — ${Math.round(delay / 1000)}s 대기`);
        await sleep(delay);
      }
    }
  }

  // blocks.children.list 는 트리 순서 파악과 마크다운 변환이 각각 호출한다. 응답을 메모해 한 번만 받는다.
  const blockCache = new Map();
  const listBlocks = client.blocks.children.list;
  client.blocks.children.list = (args) => {
    const key = `${args.block_id}:${args.start_cursor || ""}`;
    if (blockCache.has(key)) {
      stats.cacheHits++;
      return blockCache.get(key);
    }
    const promise = call(`blocks.children.list(${args.block_id})`, () => listBlocks(args));
    blockCache.set(key, promise);
    if (blockCache.size > BLOCK_CACHE_LIMIT) blockCache.delete(blockCache.keys().next().value);
    // 실패한 응답을 캐시에 남겨두면 다음 호출이 같은 실패를 그대로 돌려받는다.
    promise.catch(() => blockCache.delete(key));
    return promise;
  };

  for (const [group, name] of [
    ["blocks", "retrieve"],
    ["pages", "retrieve"],
    ["databases", "retrieve"],
    ["databases", "query"],
  ]) {
    const original = client[group][name];
    client[group][name] = (args) => call(`${group}.${name}`, () => original(args));
  }
  const search = client.search;
  client.search = (args) => call("search", () => search(args));

  client.apiStats = stats;
  return client;
}

/** 32자리 hex(대시 유무 무관)를 대시 포함 UUID 로 정규화 */
export function normalizeId(id) {
  const hex = String(id || "").replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return String(id || "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 블록 children 전체를 페이지네이션 처리해 수집 */
export async function listAllChildren(notion, blockId) {
  const results = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

/**
 * 통합이 접근할 수 있는 페이지·데이터베이스를 전부 열거한다.
 *
 * 100건당 요청 1회로 끝나고 결과에 last_edited_time 과 parent 가 들어 있어,
 * 블록을 훑지 않고도 무엇이 바뀌었는지와 트리 모양을 알 수 있다.
 * 오름차순으로 정렬하는 이유: 열거 도중 편집된 항목은 뒤로 밀리므로 누락 대신 중복이 난다(중복은 id 로 걸러진다).
 */
export async function searchAll(notion) {
  const results = [];
  let cursor;
  do {
    const res = await notion.search({
      sort: { direction: "ascending", timestamp: "last_edited_time" },
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

/** 데이터베이스 내 페이지 전체 수집 (템플릿 행은 API 가 제외해서 돌려준다) */
export async function queryAllDbPages(notion, databaseId) {
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

export function retrieveDatabase(notion, databaseId) {
  return notion.databases.retrieve({ database_id: databaseId });
}

export function retrievePage(notion, pageId) {
  return notion.pages.retrieve({ page_id: pageId });
}

export function retrieveBlock(notion, blockId) {
  return notion.blocks.retrieve({ block_id: blockId });
}

/** rich_text 배열 → 평문 */
export function plainText(richText) {
  return (richText || []).map((t) => t.plain_text).join("").trim();
}

/** 페이지/데이터베이스 객체에서 제목 추출 */
export function extractTitle(entity) {
  if (Array.isArray(entity?.title)) {
    const text = plainText(entity.title);
    if (text) return text;
  }
  const props = entity?.properties || {};
  for (const prop of Object.values(props)) {
    if (prop?.type === "title") {
      const text = plainText(prop.title);
      if (text) return text;
    }
  }
  return "Untitled";
}

/** 이모지 아이콘만 사용한다. 업로드/외부 아이콘은 위키에서 표현할 방법이 마땅치 않아 생략. */
export function extractEmojiIcon(entity) {
  const icon = entity?.icon;
  if (icon?.type === "emoji" && icon.emoji) return icon.emoji;
  return "";
}

/** 데이터베이스 제목에 이모지가 접두로 붙어 있으면 아이콘으로 분리한다. */
export function splitLeadingEmoji(title) {
  const m = String(title || "").match(/^(\p{Extended_Pictographic}️?)\s*(.*)$/u);
  if (!m) return { icon: "", text: title };
  return { icon: m[1], text: m[2].trim() || title };
}

/** 관계(relation) 속성값에서 대상 페이지 ID 배열을 꺼낸다. */
export function relationIds(page, propName) {
  const prop = page?.properties?.[propName];
  if (prop?.type !== "relation") return [];
  return (prop.relation || []).map((r) => normalizeId(r.id));
}

/** date 속성값을 ISO 문자열(YYYY-MM-DD)로 꺼낸다. 없으면 빈 문자열. */
export function dateValue(page, propName) {
  const prop = page?.properties?.[propName];
  if (prop?.type !== "date") return "";
  return prop.date?.start || "";
}
