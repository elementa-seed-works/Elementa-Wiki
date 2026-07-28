// 페이지 → 마크다운 변환
//
// 제목 헤더 + 노션 본문 + 하위 페이지 링크 목록 + 공통 꼬리말로 문서를 만든다.

import { NotionToMarkdown } from "notion-to-md";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeId } from "./notion.mjs";

const FOOTER = `\n\n---\n_이 문서는 Notion 에서 자동 동기화되었습니다. 직접 편집하지 마세요._\n`;

export function createRenderer({ notion, ctx, config, stats, warn }) {
  const n2m = new NotionToMarkdown({ notionClient: notion });

  // 하위 페이지/DB 링크는 본문에 인라인으로 렌더링하지 않는다.
  // (탐색은 별도 "## 하위 페이지" 섹션과 사이드바가 담당 → 중복/깨진 텍스트 방지)
  n2m.setCustomTransformer("child_page", async () => "");
  n2m.setCustomTransformer("child_database", async () => "");

  const assetsDir = path.join(config.outputDir, config.assetsSubdir);

  async function renderPage(node) {
    // Home 은 NOTION_HOME_PAGE_ID 가 지정되면 그 페이지 내용을 사용
    const sourceId = node.slug === "Home" && config.homePageId ? config.homePageId : node.id;
    let md = "";
    try {
      const blocks = await n2m.pageToMarkdown(sourceId);
      md = n2m.toMarkdownString(blocks).parent || "";
    } catch (e) {
      warn(`"${node.title}" 변환 실패: ${e.message}`);
      stats.pageErrors.push({ title: node.title, message: e.message });
      md = `> ⚠ 이 페이지 변환에 실패했습니다: ${e.message}\n`;
    }

    md = await processImages(md);
    md = rewriteInternalLinks(md);

    const header = `# ${node.title}\n\n`;

    // 하위 페이지가 있으면 본문 아래에 하이퍼링크 목록을 자동 삽입
    let childSection = "";
    if (node.children.length > 0) {
      const links = node.children.map((c) => `- [${c.title}](${c.slug})`).join("\n");
      childSection = `\n\n## 하위 페이지\n\n${links}\n`;
    }

    return header + md + childSection + FOOTER;
  }

  /** 마크다운 내 이미지 URL 을 로컬 경로로 치환 */
  async function processImages(markdown) {
    const matches = [...markdown.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)];
    let out = markdown;
    for (const [full, alt, url] of matches) {
      // Notion S3 / 첨부 이미지만 다운로드 (외부 정적 이미지는 그대로 둠)
      if (!/(amazonaws\.com|notion\.so|notion-static\.com)/.test(url)) continue;
      const local = await downloadImage(url);
      if (local) out = out.replace(full, `![${alt}](${local})`);
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

  /** 노션 페이지 링크(https://www.notion.so/...<32hex>)를 위키 슬러그로 치환 */
  function rewriteInternalLinks(markdown) {
    return markdown.replace(/https?:\/\/(?:www\.)?notion\.so\/[^\s)]*/g, (url) => {
      const hex =
        url.match(/([0-9a-fA-F]{32})/) ||
        url.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
      if (!hex) return url;
      return ctx.idToSlug.get(normalizeId(hex[1])) || url; // 위키에 없는 페이지면 원본 유지
    });
  }

  return { renderPage };
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
