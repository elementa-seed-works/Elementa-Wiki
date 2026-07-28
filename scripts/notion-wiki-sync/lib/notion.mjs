// Notion API 접근 계층
//
// 페이지네이션 처리와 응답 객체에서 값을 꺼내는 일만 담당한다.
// 트리 구성·마크다운 변환 같은 판단은 상위 모듈이 한다.

import { Client } from "@notionhq/client";

export function createClient(token) {
  return new Client({ auth: token });
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
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

/** 데이터베이스 내 페이지 전체 수집 */
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

export function retrievePage(notion, pageId) {
  return notion.pages.retrieve({ page_id: pageId });
}

/** 페이지 객체에서 제목 추출 */
export function extractTitle(page) {
  const props = page?.properties || {};
  for (const prop of Object.values(props)) {
    if (prop?.type === "title") {
      const text = (prop.title || []).map((t) => t.plain_text).join("").trim();
      if (text) return text;
    }
  }
  return "Untitled";
}
