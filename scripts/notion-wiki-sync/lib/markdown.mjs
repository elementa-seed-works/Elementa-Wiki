// 페이지 → 마크다운 변환
//
// 산출 문서 구조
//   [🏠 Home](Home) › [📑 Wiki](Wiki) › **현재 문서**   ← 위치 표시
//   # 아이콘 제목
//   <!-- notion-sync:body -->
//   <노션 본문>
//   <!-- /notion-sync:body -->
//   ## 하위 문서 / 문서 목록                              ← 직속 하위만
//
// 본문을 주석 마커로 감싸는 이유: 변경되지 않은 페이지는 노션을 다시 부르지 않고
// 직전 실행이 만든 .md 에서 본문만 떼어내 재사용한다. 마커 바깥(위치 표시·하위 목록)은
// 트리만 알면 만들 수 있으므로 매 실행 다시 만든다.
//
// 본문 산출 규칙을 바꾸면 state.mjs 의 RENDERER_VERSION 을 올려야 캐시된 본문이 새로 만들어진다.
//
// 문서 하단 공통 문구는 각 페이지에 넣지 않고 _Footer.md 하나로 처리한다.

import { NotionToMarkdown } from "notion-to-md";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { listAllChildren, normalizeId } from "./notion.mjs";

const NOTION_HOSTS = /(?:www\.)?notion\.so|app\.notion\.com|[a-z0-9-]+\.notion\.site/i;
const NOTION_ASSET_HOSTS = /(amazonaws\.com|notion\.so|notion-static\.com|notion\.site)/i;

const BODY_START = "<!-- notion-sync:body -->";
const BODY_END = "<!-- /notion-sync:body -->";

/**
 * 이미 만들어 둔 문서에서 본문 부분만 떼어낸다.
 * @param {string} fileContent 직전 실행이 만든 .md 내용
 * @returns {string|null} 마커가 없으면 null(=다시 만들어야 함)
 */
export function extractBody(fileContent) {
  const text = String(fileContent || "");
  const start = text.indexOf(BODY_START);
  // 본문 안에 마커와 같은 문자열이 들어 있어도 잘리지 않도록 끝 마커는 마지막 것을 쓴다.
  const end = text.lastIndexOf(BODY_END);
  if (start < 0 || end < 0 || end < start) return null;
  return text.slice(start + BODY_START.length, end).replace(/^\n+|\n+$/g, "");
}

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

  /** 노션을 호출해 본문을 만든다. 변경된 페이지에만 쓴다. */
  async function renderBody(node) {
    if (node.kind === "db") return "";

    // Home 은 NOTION_HOME_PAGE_ID 가 있으면 그 페이지 내용을 쓴다.
    const sourceId = node.slug === "Home" && config.homePageId ? config.homePageId : node.id;
    let md = "";
    try {
      // 블록은 트리 구성 때 이미 받아둔 것이 캐시에 있다. pageToMarkdown 대신 넘겨 재조회를 막는다.
      const blocks = await listAllChildren(notion, sourceId);
      const parsed = await n2m.blocksToMarkdown(numberOrderedItems(blocks));
      md = n2m.toMarkdownString(parsed).parent || "";
    } catch (e) {
      warn(`"${node.title}" 변환 실패: ${e.message}`);
      stats.pageErrors.push({ title: node.title, message: e.message });
      return `> [!WARNING]\n> 이 페이지를 마크다운으로 변환하지 못했습니다: ${e.message}`;
    }
    md = await processImages(md);
    return tidy(md);
  }

  /** 본문(새로 만든 것이든 캐시된 것이든)에 위치 표시·하위 목록을 붙여 문서 한 장을 만든다. */
  function composePage(node, body) {
    const parts = [];
    const crumb = breadcrumb(node);
    if (crumb) parts.push(crumb);
    parts.push(`# ${titleWithIcon(node)}`);
    parts.push(`${BODY_START}\n${refreshLinks(body)}\n${BODY_END}`);
    const index = renderChildIndex(node);
    if (index) parts.push(index);

    return parts.join("\n\n") + "\n";
  }

  /**
   * 본문에 남은 링크를 지금 트리 기준으로 맞춘다.
   *  - 아직 노션 URL 로 남은 링크: 그 사이 위키에 생긴 문서면 슬러그로 바꾼다.
   *  - 파일명이 바뀐 문서를 가리키는 링크: 새 파일명으로 바꾼다(캐시된 본문에 옛 이름이 남아 있다).
   */
  function refreshLinks(markdown) {
    const renames = ctx.slugRenames;
    const out = rewriteInternalLinks(markdown);
    if (!renames?.size) return out;
    // 한 번에 훑는다. 두 문서가 이름을 맞바꾼 경우 순차 치환하면 A→B→C 로 흘러간다.
    return out.replace(/\]\(([^)\s]+)\)/g, (full, target) => (renames.has(target) ? `](${renames.get(target)})` : full));
  }

  async function processImages(markdown) {
    const matches = [...markdown.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)];
    let out = markdown;
    for (const [full, alt, url] of matches) {
      // 만료되는 노션 첨부만 내려받는다. 외부 정적 이미지는 원본 링크를 그대로 둔다.
      if (!NOTION_ASSET_HOSTS.test(url)) continue;
      if (config.skipImages) {
        stats.imagesSkipped++;
        continue;
      }
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

  return { renderBody, composePage };
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

/**
 * 번호 목록 항목에 번호를 매긴다.
 *
 * notion-to-md 는 자기 블록 조회 경로에서만 이 번호를 채운다. 우리는 이미 받아둔 블록을
 * 직접 넘기므로(재조회 방지) 최상위 블록의 번호는 여기서 채워야 한다. 비우면 1. 2. 3. 이 아니라
 * 불릿으로 출력된다. 중간에 다른 블록이 끼면 번호는 1부터 다시 시작한다.
 */
function numberOrderedItems(blocks) {
  let n = 0;
  for (const block of blocks) {
    if (block?.type === "numbered_list_item") block.numbered_list_item.number = ++n;
    else n = 0;
  }
  return blocks;
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
