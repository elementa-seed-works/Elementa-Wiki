// 페이지 → 마크다운 변환
//
// 산출 문서 구조
//   [🏠 Home](Home) › [📑 Wiki](Wiki) › **현재 문서**   ← 위치 표시
//   # 아이콘 제목
//   <노션 본문>
//   ## 하위 문서 / 문서 목록                              ← 직속 하위만

import { NotionToMarkdown } from "notion-to-md";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeId } from "./notion.mjs";

const NOTION_HOSTS = /(?:www\.)?notion\.so|app\.notion\.com|[a-z0-9-]+\.notion\.site/i;
const NOTION_ASSET_HOSTS = /(amazonaws\.com|notion\.so|notion-static\.com|notion\.site)/i;
const FOOTER = `---\n_이 문서는 Notion 에서 자동 동기화되었습니다. 직접 편집하지 마세요._`;

export function createRenderer({ notion, ctx, config, stats, warn }) {
  const n2m = new NotionToMarkdown({ notionClient: notion });

  // 하위 페이지/DB 링크는 본문에 인라인으로 남기지 않는다.
  // (탐색은 "하위 문서" 섹션과 사이드바가 담당 → 중복·깨진 텍스트 방지)
  n2m.setCustomTransformer("child_page", async () => "");
  n2m.setCustomTransformer("child_database", async () => "");
  n2m.setCustomTransformer("table_of_contents", async () => "");
  n2m.setCustomTransformer("breadcrumb", async () => "");
  n2m.setCustomTransformer("unsupported", async () => "");
  n2m.setCustomTransformer("link_to_page", async (block) => {
    const targetId = block?.link_to_page?.page_id || block?.link_to_page?.database_id || "";
    const target = ctx.idToNode.get(normalizeId(targetId));
    return target ? `- ${wikiLink(target)}` : "";
  });

  const assetsDir = path.join(config.outputDir, config.assetsSubdir);

  async function renderPage(node) {
    const body = node.kind === "db" ? "" : await renderNotionBody(node);

    const parts = [];
    const crumb = breadcrumb(node);
    if (crumb) parts.push(crumb);
    parts.push(`# ${titleWithIcon(node)}`);
    if (body) parts.push(body);
    const index = renderChildIndex(node);
    if (index) parts.push(index);
    parts.push(FOOTER);

    return parts.join("\n\n") + "\n";
  }

  async function renderNotionBody(node) {
    // Home 은 NOTION_HOME_PAGE_ID 가 있으면 그 페이지 내용을 쓴다.
    const sourceId = node.slug === "Home" && config.homePageId ? config.homePageId : node.id;
    let md = "";
    try {
      const blocks = await n2m.pageToMarkdown(sourceId);
      md = n2m.toMarkdownString(blocks).parent || "";
    } catch (e) {
      warn(`"${node.title}" 변환 실패: ${e.message}`);
      stats.pageErrors.push({ title: node.title, message: e.message });
      return `> [!WARNING]\n> 이 페이지를 마크다운으로 변환하지 못했습니다: ${e.message}`;
    }
    md = await processImages(md);
    md = rewriteInternalLinks(md);
    return tidy(md);
  }

  async function processImages(markdown) {
    const matches = [...markdown.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)];
    let out = markdown;
    for (const [full, alt, url] of matches) {
      // 만료되는 노션 첨부만 내려받는다. 외부 정적 이미지는 원본 링크를 그대로 둔다.
      if (!NOTION_ASSET_HOSTS.test(url)) continue;
      const local = await downloadImage(url);
      if (local) out = out.replace(full, `![${alt || "이미지"}](${local})`);
    }
    return out;
  }

  async function downloadImage(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = createHash("sha1").update(url.split("?")[0] + buf.length).digest("hex").slice(0, 16);
      const filename = `${hash}${guessExtension(url, res.headers.get("content-type") || "")}`;
      await mkdir(assetsDir, { recursive: true });
      await writeFile(path.join(assetsDir, filename), buf);
      stats.imagesDownloaded++;
      return `${config.assetsSubdir}/${filename}`;
    } catch (e) {
      stats.imageErrors++;
      warn(`이미지 다운로드 실패: ${e.message}`);
      return null;
    }
  }

  /** 노션 내부 페이지 링크를 위키 슬러그로 치환한다. 위키에 없는 페이지면 원본 URL 을 남긴다. */
  function rewriteInternalLinks(markdown) {
    const urlPattern = new RegExp(`https?://(?:${NOTION_HOSTS.source})/[^\\s)\\]]*`, "gi");
    return markdown.replace(urlPattern, (url) => {
      const hex = url.match(/([0-9a-fA-F]{32})/) || url.match(/([0-9a-fA-F-]{36})/);
      if (!hex) return url;
      return ctx.idToSlug.get(normalizeId(hex[1])) || url;
    });
  }

  return { renderPage };
}

// ---------------------------------------------------------------------------
// 문서 조각
// ---------------------------------------------------------------------------

function breadcrumb(node) {
  const chain = [];
  for (let cur = node.parent; cur; cur = cur.parent) chain.unshift(cur);
  if (!chain.length) return "";
  const links = chain.map((n) => (n.parent ? wikiLink(n) : "[🏠 Home](Home)"));
  return `${links.join(" › ")} › **${escapeMd(titleWithIcon(node))}**`;
}

function renderChildIndex(node) {
  if (!node.children.length) return "";

  const heading =
    node.kind === "db"
      ? `## 📄 문서 ${node.children.length}건`
      : `## 📂 하위 문서 ${node.children.length}건`;

  const body = node.dateProp && node.children.every((c) => c.date)
    ? renderDateTable(node.children)
    : renderList(node.children);

  return `${heading}\n\n${body}`;
}

function renderDateTable(children) {
  const rows = children.map((c) => `| ${c.date} | ${wikiLink(c)} |`);
  return ["| 날짜 | 문서 |", "| --- | --- |", ...rows].join("\n");
}

function renderList(children) {
  return children
    .map((c) => {
      const sub = c.children.length ? ` — 하위 ${c.children.length}건` : "";
      return `- ${wikiLink(c)}${sub}`;
    })
    .join("\n");
}

export function titleWithIcon(node) {
  return node.icon ? `${node.icon} ${node.title}` : node.title;
}

function wikiLink(node) {
  return `[${escapeMd(titleWithIcon(node))}](${node.slug})`;
}

/** 링크 텍스트/표 셀에서 마크다운 구조를 깨는 문자만 최소로 이스케이프한다. */
function escapeMd(text) {
  return String(text).replace(/([\[\]|])/g, "\\$1");
}

function guessExtension(url, contentType) {
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("svg")) return ".svg";
  const m = url.split("?")[0].match(/\.(png|jpe?g|gif|webp|svg)$/i);
  return m ? `.${m[1].toLowerCase()}` : ".png";
}

/** 변환기가 남긴 빈 줄·공백을 정리한다. */
function tidy(markdown) {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^(?:>\s*)+$/gm, "") // 내용 없는 인용 줄
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
