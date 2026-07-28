// _Sidebar.md / _Footer.md 생성
//
// 사이드바는 마크다운을 섞지 않고 순수 HTML 트리로만 만든다.
// GitHub 는 HTML 블록 안의 마크다운 목록(`- `)을 리스트로 파싱하지 않아서,
// 예전처럼 <details> 안에 `- [제목](링크)` 를 넣으면 전부 한 문단으로 뭉개진다.
// 같은 이유로 HTML 블록 중간에 빈 줄을 넣으면 안 된다(거기서 블록이 끊긴다).

import { countDescendants } from "./tree.mjs";
import { titleWithIcon } from "./markdown.mjs";

export function renderSidebar(root, { wikiTitle }) {
  const lines = [
    `<h3>📖 ${escapeHtml(wikiTitle)}</h3>`,
    `<p><a href="Home"><b>🏠 Home</b></a></p>`,
  ];
  for (const group of root.children) lines.push(renderTopLevel(group));
  return lines.join("\n") + "\n";
}

// 최상위 항목은 펼친 상태로, 그 아래는 접힌 상태로 둔다.
// 100개가 넘는 문서를 한 화면에 다 펼치면 사이드바가 스크롤 지옥이 된다.
function renderTopLevel(node) {
  const label = linkTag(node);
  if (!node.children.length) return `<p>${label}</p>`;
  return [
    `<details open>`,
    `<summary><b>${label}</b>${badge(node)}</summary>`,
    renderList(node.children),
    `</details>`,
  ].join("\n");
}

function renderList(nodes) {
  return [`<ul>`, ...nodes.map(renderItem), `</ul>`].join("\n");
}

function renderItem(node) {
  const label = linkTag(node);
  if (!node.children.length) return `<li>${label}</li>`;
  return [
    `<li><details>`,
    `<summary>${label}${badge(node)}</summary>`,
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
