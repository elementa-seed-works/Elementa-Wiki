import assert from "node:assert/strict";
import test from "node:test";

import { createRenderer, extractBody } from "../lib/markdown.mjs";
import { createStats } from "../lib/summary.mjs";
import { fakeNotion, testConfig } from "./helpers.mjs";

function node(fields) {
  return {
    kind: "page",
    normId: "n1",
    title: "문서",
    icon: "",
    slug: "문서",
    children: [],
    parent: null,
    dateProp: "",
    ...fields,
  };
}

function renderer({ idToSlug = new Map(), slugRenames = new Map() } = {}) {
  const ctx = { idToSlug, idToNode: new Map(), slugRenames };
  return createRenderer({
    notion: fakeNotion(),
    ctx,
    config: testConfig(),
    stats: createStats(),
    warn: () => {},
  });
}

test("만든 문서에서 본문만 다시 떼어낼 수 있다", () => {
  const r = renderer();
  const body = "첫 문단\n\n## 소제목\n\n- 항목";

  const page = r.composePage(node({}), body);

  assert.equal(extractBody(page), body);
});

test("본문에 마커와 같은 문자열이 들어 있어도 잘리지 않는다", () => {
  const r = renderer();
  const body = "```\n<!-- /notion-sync:body -->\n```\n\n뒷부분";

  assert.equal(extractBody(r.composePage(node({}), body)), body);
});

test("마커가 없는 파일에서는 본문을 꺼내지 않는다", () => {
  assert.equal(extractBody("# 문서\n\n본문"), null);
  assert.equal(extractBody(""), null);
});

test("파일명이 바뀐 문서를 가리키는 캐시 본문의 링크가 새 파일명으로 바뀐다", () => {
  const r = renderer({ slugRenames: new Map([["옛-이름", "새-이름"]]) });

  const page = r.composePage(node({}), "[가리키는 글](옛-이름) 과 [남의 글](다른-글)");

  assert.match(page, /\[가리키는 글\]\(새-이름\)/);
  assert.match(page, /\[남의 글\]\(다른-글\)/);
});

test("캐시 본문에 남아 있던 노션 URL 은 이제 위키에 있는 문서면 슬러그로 바뀐다", () => {
  const target = "37335566982b8053ace6d928bdf49f47";
  const r = renderer({ idToSlug: new Map([["37335566-982b-8053-ace6-d928bdf49f47", "대상-문서"]]) });

  const page = r.composePage(node({}), `[링크](https://www.notion.so/${target})`);

  assert.match(page, /\[링크\]\(대상-문서\)/);
});

test("하위 문서 목록과 위치 표시는 트리에서 매번 다시 만든다", () => {
  const r = renderer();
  const parent = node({ title: "부모", slug: "부모" });
  const child = node({ title: "자식", slug: "자식", parent });
  parent.children = [child];

  const parentPage = r.composePage(parent, "");
  const childPage = r.composePage(child, "");

  assert.match(parentPage, /## 📂 하위 문서 1건/);
  assert.match(parentPage, /- \[자식\]\(자식\)/);
  assert.match(childPage, /^\[🏠 Home\]\(Home\) › \*\*자식\*\*/);
});

test("두 문서가 파일명을 맞바꿔도 링크가 한쪽으로 흘러가지 않는다", () => {
  const r = renderer({ slugRenames: new Map([["가", "나"], ["나", "가"]]) });

  const page = r.composePage(node({}), "[첫째](가) [둘째](나)");

  assert.match(page, /\[첫째\]\(나\)/);
  assert.match(page, /\[둘째\]\(가\)/);
});

test("이미지 경로는 파일명 변경에 휩쓸리지 않는다", () => {
  const r = renderer({ slugRenames: new Map([["가", "나"]]) });

  const page = r.composePage(node({}), "![그림](assets/abc123.png)");

  assert.match(page, /\(assets\/abc123\.png\)/);
});
