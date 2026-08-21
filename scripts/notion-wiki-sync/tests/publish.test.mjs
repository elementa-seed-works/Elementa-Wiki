import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { publishWiki } from "../lib/publish.mjs";
import { STATE_FILE } from "../lib/state.mjs";
import { createStats } from "../lib/summary.mjs";
import { testConfig } from "./helpers.mjs";

const BODY_START = "<!-- notion-sync:body -->";
const BODY_END = "<!-- /notion-sync:body -->";

/** 실제 렌더러와 같은 계약을 가진 가짜. 어떤 페이지를 새로 만들었는지 기록한다. */
function fakeRenderer(bodies = {}) {
  const rendered = [];
  return {
    rendered,
    async renderBody(node) {
      rendered.push(node.slug);
      return bodies[node.slug] ?? `${node.title} 본문`;
    },
    composePage(node, body) {
      return `# ${node.title}\n\n${BODY_START}\n${body}\n${BODY_END}\n`;
    },
  };
}

function node(slug, { title = slug, changed = false, normId = slug, children = [] } = {}) {
  return { kind: "page", slug, title, changed, normId, children, parent: null, icon: "", dateProp: "" };
}

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "notion-wiki-sync-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function setup(dir, { nodes, state = null, skipImages = true }) {
  const tree = { ...node("Home", { title: "홈" }), children: nodes.filter((n) => n.slug !== "Home") };
  const all = [tree, ...tree.children];
  return {
    config: testConfig({ outputDir: dir, skipImages }),
    tree,
    nodes: all,
    state,
    stats: createStats(),
  };
}

test("변경되지 않은 문서는 직전 산출물의 본문을 그대로 쓴다", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "가.md"), `# 가\n\n${BODY_START}\n예전 본문\n${BODY_END}\n`, "utf-8");
    const renderer = fakeRenderer();
    const base = setup(dir, {
      nodes: [node("가", { changed: false })],
      state: { pages: { 가: { slug: "가" } }, blockOwners: {} },
    });

    await publishWiki({ ...base, renderer });

    assert.deepEqual(renderer.rendered, ["Home"]); // Home 은 상태에 없으므로 새로 만든다
    assert.match(await readFile(path.join(dir, "가.md"), "utf-8"), /예전 본문/);
    assert.equal(base.stats.pagesReused, 1);
  });
});

test("수정된 문서는 본문을 다시 만든다", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "가.md"), `# 가\n\n${BODY_START}\n예전 본문\n${BODY_END}\n`, "utf-8");
    const renderer = fakeRenderer({ 가: "새 본문" });
    const base = setup(dir, {
      nodes: [node("가", { changed: true })],
      state: { pages: { 가: { slug: "가" } }, blockOwners: {} },
    });

    await publishWiki({ ...base, renderer });

    assert.ok(renderer.rendered.includes("가"));
    assert.match(await readFile(path.join(dir, "가.md"), "utf-8"), /새 본문/);
  });
});

test("파일명이 바뀌면 옛 파일의 본문을 물려받고 옛 파일은 지운다", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "옛-이름.md"), `# 옛 이름\n\n${BODY_START}\n지켜야 할 본문\n${BODY_END}\n`, "utf-8");
    const renderer = fakeRenderer();
    const base = setup(dir, {
      nodes: [node("새-이름", { normId: "n1", changed: false })],
      state: { pages: { n1: { slug: "옛-이름" } }, blockOwners: {} },
    });

    await publishWiki({ ...base, renderer });

    const files = await readdir(dir);
    assert.ok(files.includes("새-이름.md"));
    assert.ok(!files.includes("옛-이름.md"));
    assert.match(await readFile(path.join(dir, "새-이름.md"), "utf-8"), /지켜야 할 본문/);
    assert.deepEqual(renderer.rendered, ["Home"]);
  });
});

test("트리에 없는 문서는 지운다", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "사라진-문서.md"), "# 사라진 문서\n", "utf-8");
    const base = setup(dir, { nodes: [node("가", { changed: true })] });

    await publishWiki({ ...base, renderer: fakeRenderer() });

    const files = await readdir(dir);
    assert.ok(!files.includes("사라진-문서.md"));
    assert.equal(base.stats.filesDeleted, 1);
  });
});

test("상태 파일과 자산 폴더는 정리 대상에서 빼둔다", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "assets"), { recursive: true });
    await writeFile(path.join(dir, "assets", "keep.png"), "x", "utf-8");
    await writeFile(path.join(dir, STATE_FILE), "{}", "utf-8");
    const base = setup(dir, { nodes: [node("가", { changed: true })] });

    await publishWiki({ ...base, renderer: fakeRenderer() });

    const files = await readdir(dir);
    assert.ok(files.includes(STATE_FILE));
    assert.ok((await readdir(path.join(dir, "assets"))).includes("keep.png"));
  });
});

test("어느 문서도 참조하지 않는 이미지는 지운다", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "assets"), { recursive: true });
    await writeFile(path.join(dir, "assets", "used.png"), "x", "utf-8");
    await writeFile(path.join(dir, "assets", "orphan.png"), "x", "utf-8");
    const renderer = fakeRenderer({ 가: "![그림](assets/used.png)" });
    const base = setup(dir, { nodes: [node("가", { changed: true })], skipImages: false });

    await publishWiki({ ...base, renderer });

    assert.deepEqual(await readdir(path.join(dir, "assets")), ["used.png"]);
    assert.equal(base.stats.assetsRemoved, 1);
  });
});

test("바뀐 것이 없으면 파일을 하나도 건드리지 않는다", async () => {
  await withDir(async (dir) => {
    const base = setup(dir, { nodes: [node("가", { changed: true })] });
    await publishWiki({ ...base, renderer: fakeRenderer() });
    const before = await snapshot(dir);

    // 두 번째 실행: 모든 문서가 변경 없음
    const second = setup(dir, {
      nodes: [node("가", { changed: false })],
      state: { pages: { Home: { slug: "Home" }, 가: { slug: "가" } }, blockOwners: {} },
    });
    const result = await publishWiki({ ...second, renderer: fakeRenderer() });

    assert.equal(result.touched, 0);
    assert.deepEqual(await snapshot(dir), before); // 푸터의 동기화 시각도 그대로
    assert.equal(second.stats.filesWritten, 0);
  });
});

async function snapshot(dir) {
  const out = {};
  for (const file of await readdir(dir)) {
    out[file] = await readFile(path.join(dir, file), "utf-8").catch(() => "<dir>");
  }
  return out;
}
