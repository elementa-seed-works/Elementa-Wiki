// _Sidebar.md 생성
//
// 페이지 계층을 <details> 토글 형식으로 편다.

export function renderSidebar(root, { wikiTitle }) {
  const lines = [`### 📖 ${wikiTitle}`, "", `[🏠 Home](Home)`, ""];

  (function walk(nodes, depth) {
    for (const node of nodes) {
      if (node.children.length > 0) {
        lines.push(`<details${depth === 0 ? " open" : ""}>`);
        lines.push(`<summary><a href="${node.slug}">${escapeHtml(node.title)}</a></summary>`);
        lines.push("");
        walk(node.children, depth + 1);
        lines.push("");
        lines.push(`</details>`);
      } else {
        lines.push(`- <a href="${node.slug}">${escapeHtml(node.title)}</a>`);
      }
    }
  })(root.children, 0);

  lines.push("");
  return lines.join("\n");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
