import assert from "node:assert/strict";
import test from "node:test";

import {
  createClient,
  extractTitle,
  listAllChildren,
  normalizeId,
  plainText,
  relationIds,
  retryDelay,
} from "../lib/notion.mjs";

const rateLimited = (retryAfter) => ({
  code: "rate_limited",
  headers: retryAfter === undefined ? {} : { "retry-after": String(retryAfter) },
});

test("429 는 Retry-After 헤더가 말하는 만큼 기다린다", () => {
  assert.equal(retryDelay(rateLimited(30), 0), 30_000);
});

test("Retry-After 가 없어도 429 는 재시도한다", () => {
  const first = retryDelay(rateLimited(), 0);
  const second = retryDelay(rateLimited(), 2);

  assert.ok(first > 0);
  assert.ok(second > first); // 재시도할수록 더 기다린다
});

test("헤더가 Headers 객체로 와도 읽는다", () => {
  const error = { code: "rate_limited", headers: new Headers({ "retry-after": "12" }) };

  assert.equal(retryDelay(error, 0), 12_000);
});

test("일시적 서버 오류는 재시도하고, 그 밖의 오류는 그대로 던진다", () => {
  assert.ok(retryDelay({ code: "internal_server_error" }, 0) > 0);
  assert.ok(retryDelay({ code: "service_unavailable" }, 0) > 0);
  assert.equal(retryDelay({ code: "object_not_found" }, 0), null);
  assert.equal(retryDelay({ code: "unauthorized" }, 0), null);
  assert.equal(retryDelay(new Error("그냥 오류"), 0), null);
});

test("대기 시간에는 상한이 있다", () => {
  assert.ok(retryDelay(rateLimited(99999), 0) <= 60_000);
  assert.ok(retryDelay({ code: "internal_server_error" }, 20) <= 60_000);
});

test("ID 는 대시 유무와 대소문자에 관계없이 같은 값으로 정규화된다", () => {
  const dashed = "37335566-982b-8053-ace6-d928bdf49f47";

  assert.equal(normalizeId("37335566982b8053ace6d928bdf49f47"), dashed);
  assert.equal(normalizeId("37335566982B8053ACE6D928BDF49F47"), dashed);
  assert.equal(normalizeId(dashed), dashed);
  assert.equal(normalizeId(""), "");
});

/** SDK 가 쓸 HTTP 구현을 대신한다. 호출된 URL 을 기록하고 지정한 응답을 돌려준다. */
function stubFetch(responses) {
  const urls = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(String(url));
      const next = responses.shift() ?? { status: 200, body: { results: [], has_more: false } };
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json", ...(next.headers || {}) },
      });
    },
  };
}

test("같은 블록의 children 은 실행 중 한 번만 조회한다", async () => {
  const stub = stubFetch([{ status: 200, body: { object: "list", results: [], has_more: false } }]);
  const notion = createClient("t", { minIntervalMs: 0, fetch: stub.fetch });

  await listAllChildren(notion, "block-1");
  await listAllChildren(notion, "block-1");

  assert.equal(stub.urls.length, 1);
  assert.equal(notion.apiStats.cacheHits, 1);
  assert.equal(notion.apiStats.requests, 1);
});

test("조회에 실패한 블록은 캐시에 남기지 않는다", async () => {
  const stub = stubFetch([
    { status: 404, body: { object: "error", code: "object_not_found", message: "없음" } },
    { status: 200, body: { object: "list", results: [], has_more: false } },
  ]);
  const notion = createClient("t", { minIntervalMs: 0, maxRetries: 0, fetch: stub.fetch });

  await assert.rejects(() => listAllChildren(notion, "block-1"));
  await listAllChildren(notion, "block-1"); // 두 번째는 다시 시도해 성공해야 한다

  assert.equal(stub.urls.length, 2);
});

test("429 를 만나면 기다렸다가 다시 보낸다", async () => {
  const stub = stubFetch([
    { status: 429, body: { object: "error", code: "rate_limited", message: "느리게" }, headers: { "retry-after": "0" } },
    { status: 200, body: { object: "list", results: [], has_more: false } },
  ]);
  const notion = createClient("t", { minIntervalMs: 0, maxRetries: 3, fetch: stub.fetch });

  const started = Date.now();
  await listAllChildren(notion, "block-1");

  assert.equal(stub.urls.length, 2);
  assert.equal(notion.apiStats.rateLimited, 1);
  assert.ok(Date.now() - started >= 1000); // Retry-After 가 0이어도 최소 백오프는 지킨다
});

test("데이터베이스 스키마의 title 속성은 배열이 아니어도 넘어간다", () => {
  // search 가 돌려주는 데이터베이스는 properties 가 값이 아니라 스키마다.
  // 제목이 비어 있으면 최상위 title 로 이름을 못 찾고 속성 스캔으로 내려간다.
  const untitledDb = {
    object: "database",
    title: [],
    properties: { 이름: { id: "title", name: "이름", type: "title", title: {} } },
  };

  assert.equal(extractTitle(untitledDb), "Untitled");
});

test("스키마의 relation 속성에서는 대상 ID 를 꺼내지 않는다", () => {
  const schema = { properties: { "상위 항목": { type: "relation", relation: { database_id: "x" } } } };
  const value = {
    properties: { "상위 항목": { type: "relation", relation: [{ id: "37335566982b8053ace6d928bdf49f47" }] } },
  };

  assert.deepEqual(relationIds(schema, "상위 항목"), []);
  assert.deepEqual(relationIds(value, "상위 항목"), ["37335566-982b-8053-ace6-d928bdf49f47"]);
});

test("빈 rich_text 와 없는 값은 빈 문자열이 된다", () => {
  assert.equal(plainText([]), "");
  assert.equal(plainText(undefined), "");
  assert.equal(plainText({}), "");
  assert.equal(plainText([{ plain_text: "가" }, {}]), "가");
});
