import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectPageState,
  detectMassLoss,
  loadState,
  saveState,
  statePath,
  STATE_VERSION,
} from "../lib/state.mjs";

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "notion-wiki-state-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("저장한 상태를 그대로 다시 읽는다", async () => {
  await withDir(async (dir) => {
    const pages = { n1: { kind: "page", slug: "가", title: "가", lastEdited: "t1", childOrder: ["n2"] } };

    await saveState(dir, { pages, blockOwners: { b1: "n1" } });
    const loaded = await loadState(dir);

    assert.deepEqual(loaded.pages, pages);
    assert.deepEqual(loaded.blockOwners, { b1: "n1" });
  });
});

test("같은 내용을 다시 저장하면 파일을 건드리지 않는다", async () => {
  await withDir(async (dir) => {
    const state = { pages: { n1: { slug: "가" } }, blockOwners: {} };
    await saveState(dir, state);

    assert.equal(await saveState(dir, state), false);
    assert.equal(await saveState(dir, { pages: { n1: { slug: "나" } }, blockOwners: {} }), true);
  });
});

test("스키마 버전이 다른 상태 파일은 쓰지 않는다(전체 동기화로 떨어진다)", async () => {
  await withDir(async (dir) => {
    await writeFile(
      statePath(dir),
      JSON.stringify({ version: STATE_VERSION + 1, renderer: 1, pages: { n1: {} } }),
      "utf-8",
    );

    assert.equal(await loadState(dir), null);
  });
});

test("깨진 상태 파일은 경고를 남기고 전체 동기화로 떨어진다", async () => {
  await withDir(async (dir) => {
    await writeFile(statePath(dir), "{ 깨진 JSON", "utf-8");
    const warnings = [];

    assert.equal(await loadState(dir, (m) => warnings.push(m)), null);
    assert.equal(warnings.length, 1);
  });
});

test("상태 파일이 없으면 null 이다", async () => {
  await withDir(async (dir) => {
    assert.equal(await loadState(dir), null);
  });
});

test("다음 실행이 볼 수 있게 자식 순서를 기록한다", () => {
  const child = { normId: "n2", kind: "page", slug: "나", title: "나", lastEdited: "t2", children: [] };
  const parent = { normId: "n1", kind: "page", slug: "가", title: "가", lastEdited: "t1", children: [child] };

  const pages = collectPageState([parent, child]);

  assert.deepEqual(pages.n1.childOrder, ["n2"]);
  assert.deepEqual(pages.n2.childOrder, []);
  assert.equal(pages.n1.lastEdited, "t1");
});

test("상태 파일에는 매번 달라지는 값이 들어가지 않는다", async () => {
  await withDir(async (dir) => {
    await saveState(dir, { pages: {}, blockOwners: {} });
    const raw = JSON.parse(await readFile(statePath(dir), "utf-8"));

    assert.deepEqual(Object.keys(raw).sort(), ["blockOwners", "pages", "renderer", "version"]);
  });
});

test("문서가 절반 넘게 사라지면 사고로 본다", () => {
  const state = { pages: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, {}])) };

  assert.equal(detectMassLoss(state, new Array(9)).suspicious, true);
  assert.equal(detectMassLoss(state, new Array(11)).suspicious, false);
});

test("문서 수가 적은 위키에서는 줄어도 막지 않는다", () => {
  const state = { pages: { n1: {}, n2: {}, n3: {} } };

  assert.equal(detectMassLoss(state, new Array(1)).suspicious, false);
});

test("직전 상태가 없으면 판단하지 않는다", () => {
  assert.equal(detectMassLoss(null, []).suspicious, false);
});
