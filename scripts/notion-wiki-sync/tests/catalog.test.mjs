import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalog, groupByParent, recoverMissing } from "../lib/catalog.mjs";
import { blockParent, dbRaw, fakeNotion, norm, notionError, pageParent, pageRaw } from "./helpers.mjs";

const COLUMN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COLUMN_LIST = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function columnBlock(blockId, parent) {
  return { object: "block", id: blockId, type: "column", parent };
}

test("컬럼 안에 든 페이지는 블록을 거슬러 올라가 소유 페이지 밑에 붙는다", async () => {
  // Given: 페이지 2가 컬럼(→컬럼 목록→페이지 1) 안에 들어 있다
  const notion = fakeNotion({
    search: [pageRaw(1, { parent: { type: "workspace", workspace: true } }), pageRaw(2, { parent: blockParent(COLUMN) })],
    entities: {
      [COLUMN]: columnBlock(COLUMN, blockParent(COLUMN_LIST)),
      [COLUMN_LIST]: columnBlock(COLUMN_LIST, pageParent(1)),
    },
  });

  const { entries, blockOwners } = await buildCatalog(notion);

  const byParent = groupByParent(entries);
  assert.deepEqual(
    (byParent.get(norm(1)) || []).map((e) => e.normId),
    [norm(2)],
  );
  // 다음 실행이 같은 길을 다시 걷지 않도록 블록 두 개 모두 소유 페이지로 기록된다
  assert.equal(blockOwners[COLUMN], norm(1));
  assert.equal(blockOwners[COLUMN_LIST], norm(1));
});

test("이미 아는 블록은 다시 조회하지 않는다", async () => {
  const notion = fakeNotion({
    search: [pageRaw(2, { parent: blockParent(COLUMN) })],
    entities: {},
  });

  const { entries } = await buildCatalog(notion, { blockOwners: { [COLUMN]: norm(1) } });

  assert.equal(entries.get(norm(2)).parent.id, norm(1));
  assert.deepEqual(notion.calls.blockRetrieves, []);
});

test("휴지통에 있는 항목은 목록에서 빠진다", async () => {
  const trashed = { ...pageRaw(3, { parent: pageParent(1) }), in_trash: true };
  const archived = { ...pageRaw(4, { parent: pageParent(1) }), archived: true };
  const notion = fakeNotion({ search: [pageRaw(2, { parent: pageParent(1) }), trashed, archived] });

  const { entries } = await buildCatalog(notion);

  assert.deepEqual([...entries.keys()], [norm(2)]);
});

test("블록 부모를 끝내 찾지 못하면 경고만 남기고 트리에서 뺀다", async () => {
  const orphanBlock = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const notion = fakeNotion({ search: [pageRaw(2, { parent: blockParent(orphanBlock) })], entities: {} });
  const warnings = [];

  const { entries } = await buildCatalog(notion, { warn: (m) => warnings.push(m) });

  assert.equal(entries.get(norm(2)).parent.id, "");
  assert.equal(warnings.length, 1);
});

test("목록에서 빠졌지만 살아 있는 문서는 되살린다", async () => {
  // Given: 직전 실행에는 있던 데이터베이스가 이번 검색 결과에 없다(인라인 DB 가 색인에서 빠지는 경우)
  const notion = fakeNotion({
    search: [pageRaw(1, { parent: { type: "workspace", workspace: true } })],
    entities: { [norm(4)]: dbRaw(4, { parent: pageParent(1), title: "목록" }) },
  });
  const entries = (await buildCatalog(notion)).entries;

  const recovered = await recoverMissing(notion, {
    entries,
    statePages: { [norm(4)]: { kind: "db", slug: "목록" } },
  });

  assert.equal(recovered.length, 1);
  assert.equal(entries.get(norm(4)).title, "목록");
  assert.equal(entries.get(norm(4)).parent.id, norm(1));
});

test("정말 지워진 문서는 되살리지 않는다", async () => {
  const notion = fakeNotion({
    search: [pageRaw(1, { parent: { type: "workspace", workspace: true } })],
    entities: { [norm(5)]: notionError("object_not_found", "삭제됨") },
  });
  const entries = (await buildCatalog(notion)).entries;
  const warnings = [];

  const recovered = await recoverMissing(notion, {
    entries,
    statePages: { [norm(5)]: { kind: "page", slug: "지운-문서" } },
    warn: (m) => warnings.push(m),
  });

  assert.deepEqual(recovered, []);
  assert.equal(entries.has(norm(5)), false);
  assert.deepEqual(warnings, []); // 정상 삭제는 경고가 아니다
});

test("휴지통에 들어간 문서도 되살리지 않는다", async () => {
  const notion = fakeNotion({
    search: [],
    entities: { [norm(6)]: { ...pageRaw(6, { parent: pageParent(1) }), in_trash: true } },
  });
  const entries = (await buildCatalog(notion)).entries;

  const recovered = await recoverMissing(notion, { entries, statePages: { [norm(6)]: { kind: "page" } } });

  assert.deepEqual(recovered, []);
});

test("확인 도중 알 수 없는 오류가 나면 지우지 않고 실행을 멈춘다", async () => {
  const notion = fakeNotion({
    search: [],
    entities: { [norm(7)]: notionError("rate_limited", "너무 잦음") },
  });
  const entries = (await buildCatalog(notion)).entries;

  await assert.rejects(
    () => recoverMissing(notion, { entries, statePages: { [norm(7)]: { kind: "page" } } }),
    /너무 잦음/,
  );
});
