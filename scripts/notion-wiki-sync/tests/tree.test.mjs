import assert from "node:assert/strict";
import test from "node:test";

import { toEntry, groupByParent } from "../lib/catalog.mjs";
import { assignSlugs, buildTree, createTreeContext, flatten } from "../lib/tree.mjs";
import {
  childPageBlock,
  dbParent,
  dbRaw,
  fakeNotion,
  id,
  norm,
  pageParent,
  pageRaw,
  testConfig,
  titles,
} from "./helpers.mjs";

const EDITED = "2026-01-01T00:00:00.000Z";
const EDITED_LATER = "2026-02-02T00:00:00.000Z";

function catalogOf(raws) {
  const entries = new Map();
  for (const raw of raws) {
    const entry = toEntry(raw);
    entries.set(entry.normId, entry);
  }
  return entries;
}

/** 트리에 있는 노드를 전부 "직전 실행에서 이 모습이었다" 로 기록한 상태를 만든다. */
function stateOf(pages) {
  return { pages, blockOwners: {} };
}

function pageState({ slug, lastEdited = EDITED, childOrder = [], kind = "page", title = "" }) {
  return { kind, slug, title, lastEdited, childOrder };
}

async function build({ catalog, state, notion, config = {} }) {
  const warnings = [];
  const ctx = createTreeContext({
    notion,
    config: testConfig(config),
    warn: (m) => warnings.push(m),
    state,
  });
  const tree = await buildTree(ctx, {
    catalog,
    byParent: groupByParent(catalog),
    rootId: id(1),
    rootTitle: "루트",
    homeId: ctx.config.homePageId,
  });
  return { ctx, tree, warnings };
}

test("변경이 없으면 블록을 한 번도 조회하지 않는다", async () => {
  // Given: 루트와 두 자식이 모두 직전 실행과 같은 수정 시각
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트" }),
    pageRaw(2, { parent: pageParent(1), title: "가" }),
    pageRaw(3, { parent: pageParent(1), title: "나" }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", childOrder: [norm(2), norm(3)] }),
    [norm(2)]: pageState({ slug: "가" }),
    [norm(3)]: pageState({ slug: "나" }),
  });
  const notion = fakeNotion();

  // When
  const { tree } = await build({ catalog, state, notion });

  // Then: 트리는 그대로 서고, 노션 블록 조회는 일어나지 않는다
  assert.deepEqual(titles(tree.children), ["가", "나"]);
  assert.deepEqual(notion.calls.blockLists, []);
});

test("자식 순서는 검색 결과 순서가 아니라 직전 실행에 기록한 순서를 따른다", async () => {
  // Given: 검색이 돌려주는 순서(나, 다, 가)와 기록된 순서(가, 나, 다)가 다르다
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트" }),
    pageRaw(3, { parent: pageParent(1), title: "나" }),
    pageRaw(4, { parent: pageParent(1), title: "다" }),
    pageRaw(2, { parent: pageParent(1), title: "가" }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", childOrder: [norm(2), norm(3), norm(4)] }),
    [norm(2)]: pageState({ slug: "가" }),
    [norm(3)]: pageState({ slug: "나" }),
    [norm(4)]: pageState({ slug: "다" }),
  });

  const { tree } = await build({ catalog, state, notion: fakeNotion() });

  assert.deepEqual(titles(tree.children), ["가", "나", "다"]);
});

test("수정된 페이지만 블록을 다시 훑는다", async () => {
  // Given: 자식 "나" 만 수정 시각이 달라졌다
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트" }),
    pageRaw(2, { parent: pageParent(1), title: "가" }),
    pageRaw(3, { parent: pageParent(1), title: "나", lastEdited: EDITED_LATER }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", childOrder: [norm(2), norm(3)] }),
    [norm(2)]: pageState({ slug: "가" }),
    [norm(3)]: pageState({ slug: "나" }),
  });
  const notion = fakeNotion({ blocks: { [id(3)]: [] } });

  const { tree, ctx } = await build({ catalog, state, notion });

  assert.deepEqual(notion.calls.blockLists, [id(3)]);
  assert.equal(ctx.orderRefreshes, 1);
  assert.equal(tree.children.find((n) => n.title === "나").changed, true);
  assert.equal(tree.children.find((n) => n.title === "가").changed, false);
});

test("검색 목록에 아직 없는 새 페이지는 상위 블록에서 찾아 개별 조회로 채운다", async () => {
  // Given: 루트가 수정됐고, 루트 블록에는 검색 인덱스에 아직 없는 새 페이지가 들어 있다
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트", lastEdited: EDITED_LATER }),
    pageRaw(2, { parent: pageParent(1), title: "가" }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", childOrder: [norm(2)] }),
    [norm(2)]: pageState({ slug: "가" }),
  });
  const notion = fakeNotion({
    blocks: { [id(1)]: [childPageBlock(2, "가"), childPageBlock(9, "새 문서")], [id(9)]: [] },
    entities: { [id(9)]: pageRaw(9, { parent: pageParent(1), title: "새 문서", lastEdited: EDITED_LATER }) },
  });

  const { tree, ctx } = await build({ catalog, state, notion });

  assert.deepEqual(titles(tree.children), ["가", "새 문서"]);
  assert.equal(ctx.adopted, 1);
  assert.deepEqual(notion.calls.retrieves, [norm(9)]);
});

test("데이터베이스 행은 블록 조회 없이 관계 속성만으로 계층이 선다", async () => {
  // Given: 자기참조 관계를 가진 데이터베이스와, 행 6이 행 5를 상위로 가리키는 상태
  const relationSchema = {
    "상위 항목": { type: "relation", relation: { database_id: id(4) } },
    "하위 항목": { type: "relation", relation: { database_id: id(4) } },
  };
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트" }),
    dbRaw(4, { parent: pageParent(1), title: "목록", properties: relationSchema }),
    pageRaw(5, { parent: dbParent(4), title: "상위 행" }),
    pageRaw(6, {
      parent: dbParent(4),
      title: "하위 행",
      properties: { "상위 항목": { type: "relation", relation: [{ id: id(5) }] } },
    }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", childOrder: [norm(4)] }),
    [norm(4)]: pageState({ slug: "목록", kind: "db", childOrder: [norm(5)] }),
    [norm(5)]: pageState({ slug: "상위-행", childOrder: [] }),
    [norm(6)]: pageState({ slug: "하위-행", childOrder: [] }),
  });
  const notion = fakeNotion();

  const { tree } = await build({ catalog, state, notion });

  const db = tree.children[0];
  assert.equal(db.kind, "db");
  assert.deepEqual(titles(db.children), ["상위 행"]);
  assert.deepEqual(titles(db.children[0].children), ["하위 행"]);
  assert.deepEqual(notion.calls.blockLists, []);
});

test("제목이 그대로면 이전 파일명을 유지하고, 같은 제목의 새 문서가 뒤로 밀린다", async () => {
  // Given: 기존 문서 3이 "회의록" 파일명을 쓰고 있는데, 같은 제목의 새 문서 2가 노션에서 그 앞에 놓였다
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트", lastEdited: EDITED_LATER }),
    pageRaw(2, { parent: pageParent(1), title: "회의록" }),
    pageRaw(3, { parent: pageParent(1), title: "회의록" }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", childOrder: [norm(3)] }),
    [norm(3)]: pageState({ slug: "회의록" }),
  });
  const notion = fakeNotion({
    blocks: { [id(1)]: [childPageBlock(2, "회의록"), childPageBlock(3, "회의록")], [id(2)]: [] },
  });

  const { ctx, tree } = await build({ catalog, state, notion });
  assignSlugs(ctx, tree);

  // Then: 앞에 오더라도 새 문서가 기존 파일명을 뺏지 않는다(위키 링크가 통째로 깨진다)
  const bySlug = new Map(flatten(tree).map((n) => [n.normId, n.slug]));
  assert.equal(bySlug.get(norm(3)), "회의록");
  assert.equal(bySlug.get(norm(2)), "회의록-2");
});

test("건너뛰기로 지정한 ID 는 트리에서 빠진다", async () => {
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트" }),
    pageRaw(2, { parent: pageParent(1), title: "가" }),
    pageRaw(3, { parent: pageParent(1), title: "숨김" }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", childOrder: [norm(2), norm(3)] }),
    [norm(2)]: pageState({ slug: "가" }),
    [norm(3)]: pageState({ slug: "숨김" }),
  });

  const { tree } = await build({
    catalog,
    state,
    notion: fakeNotion(),
    config: { skipIds: [id(3)] },
  });

  assert.deepEqual(titles(tree.children), ["가"]);
});

test("Home 으로 지정한 페이지는 문서를 만들지 않고 그 하위만 Home 아래로 올린다", async () => {
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트" }),
    pageRaw(2, { parent: pageParent(1), title: "메인" }),
    pageRaw(3, { parent: pageParent(2), title: "다" }),
    pageRaw(4, { parent: pageParent(2), title: "라" }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", lastEdited: `${EDITED}|${EDITED}`, childOrder: [norm(3), norm(4)] }),
    [norm(3)]: pageState({ slug: "다" }),
    [norm(4)]: pageState({ slug: "라" }),
  });

  const { ctx, tree } = await build({ catalog, state, notion: fakeNotion(), config: { homePageId: id(2) } });
  assignSlugs(ctx, tree);

  assert.deepEqual(titles(tree.children), ["다", "라"]);
  assert.equal(flatten(tree).some((n) => n.title === "메인"), false);
  assert.equal(ctx.idToSlug.get(norm(2)), "Home");
});

test("Home 페이지가 수정되면 루트 자식 순서를 다시 읽는다", async () => {
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트" }),
    pageRaw(2, { parent: pageParent(1), title: "메인", lastEdited: EDITED_LATER }),
    pageRaw(3, { parent: pageParent(2), title: "다" }),
    pageRaw(4, { parent: pageParent(2), title: "라" }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", lastEdited: `${EDITED}|${EDITED}`, childOrder: [norm(3), norm(4)] }),
    [norm(3)]: pageState({ slug: "다" }),
    [norm(4)]: pageState({ slug: "라" }),
  });
  const notion = fakeNotion({
    blocks: { [id(1)]: [childPageBlock(2, "메인")], [id(2)]: [childPageBlock(4, "라"), childPageBlock(3, "다")] },
  });

  const { tree } = await build({ catalog, state, notion, config: { homePageId: id(2) } });

  assert.deepEqual(titles(tree.children), ["라", "다"]);
});

test("노션에서 제목을 바꾸면 위키 파일명도 따라 바뀐다", async () => {
  const catalog = catalogOf([
    pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트" }),
    pageRaw(2, { parent: pageParent(1), title: "새 제목" }),
  ]);
  const state = stateOf({
    [norm(1)]: pageState({ slug: "Home", childOrder: [norm(2)] }),
    [norm(2)]: pageState({ slug: "옛-제목" }),
  });

  const { ctx, tree } = await build({ catalog, state, notion: fakeNotion() });
  assignSlugs(ctx, tree);

  assert.equal(tree.children[0].slug, "새-제목");
});
