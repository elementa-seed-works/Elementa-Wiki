// 실행 통계와 요약 출력 (콘솔 + GitHub Actions Step Summary)

import { writeFile } from "node:fs/promises";

export function createStats() {
  return {
    startMs: Date.now(),
    pagesFound: 0,
    filesWritten: 0,
    pageErrors: [], // { title, message }
    imagesDownloaded: 0,
    imageErrors: 0,
  };
}

export async function writeSummary(stats, { rootTitle }) {
  const elapsedSec = ((Date.now() - stats.startMs) / 1000).toFixed(1);
  const ok = stats.pageErrors.length === 0;

  const lines = [
    `## 🔄 Notion → Wiki 동기화 결과`,
    "",
    `- 상태: ${ok ? "✅ 성공" : "⚠️ 일부 실패"}`,
    `- 기준 페이지: ${rootTitle}`,
    `- 동기화된 페이지: ${stats.filesWritten} / ${stats.pagesFound}`,
    `- 변환 실패: ${stats.pageErrors.length}건`,
    `- 이미지: 다운로드 ${stats.imagesDownloaded}개 · 실패 ${stats.imageErrors}개`,
    `- 소요 시간: ${elapsedSec}s`,
    "",
  ];

  if (stats.pageErrors.length > 0) {
    lines.push(`### ❌ 실패한 페이지`, "", `| 페이지 | 오류 |`, `| --- | --- |`);
    for (const e of stats.pageErrors) {
      const msg = (e.message || "").replace(/\|/g, "\\|").slice(0, 160);
      lines.push(`| ${e.title.replace(/\|/g, "\\|")} | ${msg} |`);
    }
    lines.push("");
  }

  const summary = lines.join("\n");
  console.log("\n" + summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await writeFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n", { flag: "a" });
    } catch (e) {
      console.warn(`[warn] step summary 기록 실패: ${e.message}`);
    }
  }
}
