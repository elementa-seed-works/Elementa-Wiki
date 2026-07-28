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
