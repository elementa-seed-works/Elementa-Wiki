// 두 번째 실행이 노션을 얼마나 부르는지 확인하는 통합 테스트.
// 목록 수집 → 트리 → 렌더 → 기록까지 실제 모듈을 그대로 엮고, 노션 클라이언트만 가짜로 바꾼다.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCatalog, groupByParent } from "../lib/catalog.mjs";
import { createRenderer } from "../lib/markdown.mjs";
import { publishWiki } from "../lib/publish.mjs";
import { collectPageState, loadState, saveState } from "../lib/state.mjs";
import { createStats } from "../lib/summary.mjs";
import { assignSlugs, buildTree, createTreeContext, flatten } from "../lib/tree.mjs";
import { childPageBlock, fakeNotion, id, pageParent, pageRaw, paragraphBlock, testConfig } from "./helpers.mjs";

/** sync.mjs 의 한 번 실행과 같은 순서로 돈다. */
async function runSync({ dir, notion, forceFull = false }) {
  const config = testConfig({ outputDir: dir, rootPageId: id(1), skipImages: true, forceFull });
  const stats = createStats();
  const warnings = [];
  const warn = (m) => warnings.push(m);

  const state = forceFull ? null : await loadState(dir, warn);
  const { entries: catalog, blockOwners } = await buildCatalog(notion, { blockOwners: state?.blockOwners, warn });
  const ctx = createTreeContext({ notion, config, warn, state });
  const tree = await buildTree(ctx, {
    catalog,
    byParent: groupByParent(catalog),
    rootId: config.rootPageId,
    rootTitle: "루트",
  });

  const nodes = flatten(tree);
  assignSlugs(ctx, tree);
  ctx.idToNode = new Map(nodes.map((n) => [n.normId, n]));
  ctx.slugRenames = new Map();

  const renderer = createRenderer({ notion, ctx, config, stats, warn });
  const { touched } = await publishWiki({ config, tree, nodes, state, renderer, stats });
  await saveState(dir, { pages: collectPageState(nodes), blockOwners });

  return { stats, touched, warnings, nodes };
}

function fixtures({ pageTwoEdited = "2026-01-01T00:00:00.000Z", pageTwoText = "가 본문" } = {}) {
  return {
    search: [
      pageRaw(1, { parent: { type: "workspace", workspace: true }, title: "루트" }),
      pageRaw(2, { parent: pageParent(1), title: "가", lastEdited: pageTwoEdited }),
      pageRaw(3, { parent: pageParent(1), title: "나" }),
    ],
    blocks: {
      [id(1)]: [childPageBlock(2, "가"), childPageBlock(3, "나")],
      [id(2)]: [paragraphBlock("block-2", { text: pageTwoText })],
      [id(3)]: [paragraphBlock("block-3", { text: "나 본문" })],
    },
  };
}

async function snapshot(dir) {
  const out = {};
  for (const file of (await readdir(dir)).sort()) {
    out[file] = await readFile(path.join(dir, file), "utf-8").catch(() => "<dir>");
  }
  return out;
}

test("두 번째 실행은 블록을 한 번도 부르지 않고 파일도 건드리지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "notion-wiki-inc-"));
  try {
    // 첫 실행: 상태 파일이 없으므로 전부 만든다
    const first = await runSync({ dir, notion: fakeNotion(fixtures()) });
    assert.equal(first.stats.pagesRendered, 3);
    assert.match(await readFile(path.join(dir, "가.md"), "utf-8"), /가 본문/);
    const after = await snapshot(dir);

    // 두 번째 실행: 노션에 바뀐 것이 없다
    const notion = fakeNotion(fixtures());
    const second = await runSync({ dir, notion });

    assert.deepEqual(notion.calls.blockLists, []);
    assert.equal(notion.calls.searches, 1); // 목록 열거만 한다
    assert.equal(second.stats.pagesRendered, 0);
    assert.equal(second.stats.pagesReused, 3);
    assert.equal(second.touched, 0);
    assert.deepEqual(await snapshot(dir), after);
    assert.deepEqual(second.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("한 페이지만 고치면 그 페이지의 블록만 다시 부른다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "notion-wiki-inc-"));
  try {
    await runSync({ dir, notion: fakeNotion(fixtures()) });
    const before = await snapshot(dir);

    const notion = fakeNotion(fixtures({ pageTwoEdited: "2026-03-03T00:00:00.000Z", pageTwoText: "고친 본문" }));
    const result = await runSync({ dir, notion });

    // 블록 조회는 "가" 에만 간다. 상위 페이지는 수정되지 않았으므로 순서를 다시 읽지 않는다.
    // (가짜 클라이언트에는 메모가 없어 순서 확인·본문 변환이 각각 호출된다. 실제로는 한 번이다)
    assert.deepEqual(new Set(notion.calls.blockLists), new Set([id(2)]));
    assert.equal(result.stats.pagesRendered, 1);
    assert.equal(result.stats.pagesReused, 2);

    const after = await snapshot(dir);
    assert.match(after["가.md"], /고친 본문/);
    assert.equal(after["나.md"], before["나.md"]);
    assert.notEqual(after["_Footer.md"], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("노션에서 지운 페이지는 위키에서도 사라진다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "notion-wiki-inc-"));
  try {
    await runSync({ dir, notion: fakeNotion(fixtures()) });

    const trimmed = fixtures();
    trimmed.search = trimmed.search.filter((raw) => raw.id !== id(3));
    trimmed.blocks[id(1)] = [childPageBlock(2, "가")];
    // 루트가 수정된 것으로 보이게 해 자식 순서를 다시 읽게 한다
    trimmed.search[0].last_edited_time = "2026-03-03T00:00:00.000Z";

    const result = await runSync({ dir, notion: fakeNotion(trimmed) });

    const files = await readdir(dir);
    assert.ok(!files.includes("나.md"));
    assert.ok(files.includes("가.md"));
    assert.equal(result.stats.filesDeleted, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
