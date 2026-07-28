// _Sidebar.md / _Footer.md 생성
//
// 사이드바는 마크다운을 섞지 않고 순수 HTML 로만 만든다.
// GitHub 는 HTML 블록 안의 마크다운 목록(`- `)을 리스트로 파싱하지 않아서,
// <details> 안에 `- [제목](링크)` 를 넣으면 전부 한 문단으로 뭉개진다.
// 같은 이유로 HTML 블록 중간에 빈 줄을 넣으면 안 된다(거기서 블록이 끊긴다).
//
// 목록은 <ul type="none"> 을 쓴다.
//   불릿(◦)을 없애려면 list-style 을 꺼야 하는데 GitHub 은 style·class 속성을 제거한다.
//   반면 type 속성은 그대로 통과시키고, 브라우저는 type="none" 을 list-style-type: none 으로
//   적용한다. 중첩 <ul> 이 깊이만큼 들여쓰기를 맡으므로 접기 삼각형도 깊이를 따라 함께 밀린다.
//
// 하위가 없는 항목에는 LEAF_PAD 를 앞에 붙인다.
//   <summary> 의 접기 삼각형은 list-style-position: inside 라 summary 내용의 맨 앞,
//   즉 텍스트 안쪽에 그려진다. 그래서 하위가 있는 항목만 제목이 삼각형 폭만큼 오른쪽으로
//   밀려 형제와 왼쪽이 어긋난다. 그 자리를 공백으로 대신 채워 맞춘다.

import { countDescendants } from "./tree.mjs";
import { titleWithIcon } from "./markdown.mjs";

// 접기 삼각형이 텍스트를 미는 폭은 글꼴 크기의 약 1.06배다(Chrome 14px 기준 14.83px).
// U+2003 EM SPACE 가 정확히 1em 이라 오차가 1px 미만으로 가장 가깝다.
// (일반 공백과 달리 HTML 이 연속 공백을 합치지 않는다)
const LEAF_PAD = "&emsp;";

export function renderSidebar(root, { wikiTitle }) {
  const lines = [
    `<h3>📖 ${escapeHtml(wikiTitle)}</h3>`,
    `<p><a href="Home"><b>🏠 Home</b></a></p>`,
  ];
  for (const group of root.children) lines.push(renderTopLevel(group));
  return lines.join("\n") + "\n";
}

// 최상위만 펼친 상태로 둔다. 100개가 넘는 문서를 한 화면에 다 펼치면 스크롤 지옥이 된다.
function renderTopLevel(node) {
  const label = `<b>${linkTag(node)}</b>`;
  if (!node.children.length) return `<p>${LEAF_PAD}${label}</p>`;
  return [
    `<details open>`,
    `<summary>${label}${badge(node)}</summary>`,
    renderList(node.children),
    `</details>`,
  ].join("\n");
}

function renderList(nodes) {
  return [`<ul type="none">`, ...nodes.map(renderItem), `</ul>`].join("\n");
}

function renderItem(node) {
  if (!node.children.length) return `<li>${LEAF_PAD}${linkTag(node)}</li>`;
  return [
    `<li><details>`,
    `<summary>${linkTag(node)}${badge(node)}</summary>`,
    renderList(node.children),
    `</details></li>`,
  ].join("\n");
}

function badge(node) {
  const n = countDescendants(node);
  return n ? ` <sup>${n}</sup>` : "";
}

function linkTag(node) {
  return `<a href="${escapeHtml(node.slug)}">${escapeHtml(titleWithIcon(node))}</a>`;
}

export function renderFooter({ wikiTitle, syncedAt, sourceUrl }) {
  const source = sourceUrl
    ? ` · 원본은 <a href="${escapeHtml(sourceUrl)}">Notion</a> 에서 편집`
    : "";
  return (
    `<sub>📖 <b>${escapeHtml(wikiTitle)}</b> · Notion 에서 자동 동기화 (${escapeHtml(syncedAt)})` +
    `${source} · 위키에서 직접 고친 내용은 다음 동기화 때 사라집니다.</sub>\n`
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
