// _Sidebar.md / _Footer.md 생성
//
// 사이드바는 마크다운을 섞지 않고 순수 HTML 로만 만든다.
// GitHub 는 HTML 블록 안의 마크다운 목록(`- `)을 리스트로 파싱하지 않아서,
// <details> 안에 `- [제목](링크)` 를 넣으면 전부 한 문단으로 뭉개진다.
// 같은 이유로 HTML 블록 중간에 빈 줄을 넣으면 안 된다(거기서 블록이 끊긴다).
//
// 들여쓰기를 <ul> 대신 공백 문자로 하는 이유
//   <summary> 의 펼침 삼각형은 list-style-position: inside 라서 summary 내용의
//   맨 앞, 즉 텍스트 안쪽에 그려진다. 그래서 하위가 있는 항목만 제목이 삼각형
//   폭만큼 오른쪽으로 밀리고, 하위가 없는 항목과 왼쪽이 어긋난다.
//   여기에 <ul> 을 쓰면 불릿(◦)까지 얹혀 더 어수선해진다.
//   그래서 목록 태그를 쓰지 않고, 하위가 없는 항목 앞에 삼각형 폭만큼 공백을 넣어 맞춘다.
//   CSS 는 GitHub 이 제거하므로 공백 문자 말고는 방법이 없다.

import { countDescendants } from "./tree.mjs";
import { titleWithIcon } from "./markdown.mjs";

// U+2003 EM SPACE. 폰트 크기와 같은 폭이라 접기 삼각형 폭과 가장 가깝다.
// (일반 공백과 달리 HTML 이 연속 공백을 합치지 않는다)
const INDENT = "&emsp;"; // 깊이 한 단계
const LEAF_PAD = "&emsp;"; // 하위 없는 항목이 삼각형 자리를 대신 차지하는 폭

export function renderSidebar(root, { wikiTitle }) {
  const lines = [
    `<h3>📖 ${escapeHtml(wikiTitle)}</h3>`,
    `<p><a href="Home"><b>🏠 Home</b></a></p>`,
  ];
  for (const group of root.children) lines.push(renderNode(group, 0, true));
  return lines.join("\n") + "\n";
}

/**
 * 한 항목을 그린다.
 * 하위가 있으면 <details>, 없으면 공백을 앞에 붙인 한 줄.
 * @param {number} depth 0 = 최상위
 * @param {boolean} isTop 최상위는 펼친 상태로 굵게 둔다
 */
function renderNode(node, depth, isTop = false) {
  const label = isTop ? `<b>${linkTag(node)}</b>` : linkTag(node);

  if (!node.children.length) {
    return `${INDENT.repeat(depth)}${LEAF_PAD}${label}`;
  }

  // 최상위만 펼쳐 둔다. 100개가 넘는 문서를 다 펼치면 사이드바가 스크롤 지옥이 된다.
  return [
    `<details${isTop ? " open" : ""}>`,
    `<summary>${INDENT.repeat(depth)}${label}${badge(node)}</summary>`,
    renderChildren(node.children, depth + 1),
    `</details>`,
  ].join("\n");
}

/**
 * 형제들을 이어 붙인다.
 * <details> 는 블록이라 앞뒤로 알아서 줄이 나뉘므로, 줄바꿈이 필요한 곳은
 * 한 줄짜리 항목이 연달아 나올 때뿐이다. 그 사이에만 <br> 을 넣는다.
 */
function renderChildren(nodes, depth) {
  return nodes
    .map((node, i) => {
      const rendered = renderNode(node, depth);
      const isLeaf = !node.children.length;
      const nextIsLeaf = i + 1 < nodes.length && !nodes[i + 1].children.length;
      return isLeaf && nextIsLeaf ? `${rendered}<br>` : rendered;
    })
    .join("\n");
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
