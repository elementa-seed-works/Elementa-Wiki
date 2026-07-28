// 실행 통계와 요약 출력 (콘솔 + GitHub Actions Step Summary)

import { writeFile } from "node:fs/promises";

export function createStats() {
  return {
    startMs: Date.now(),
    pagesFound: 0,
    filesWritten: 0,
    pageErrors: [], // { title, message }
    imagesDownloaded: 0,
    imagesSkipped: 0,
    imageErrors: 0,
    warnings: 0,
  };
}

export async function writeSummary(stats, { rootTitle, outputDir, preview }) {
  const elapsedSec = ((Date.now() - stats.startMs) / 1000).toFixed(1);
  const ok = stats.pageErrors.length === 0;
  await writeStepOutputs(stats, { rootTitle, elapsedSec });

  const lines = [
    `## 🔄 Notion → Wiki 동기화 결과`,
    "",
    `- 상태: ${ok ? "✅ 성공" : "⚠️ 일부 실패"}${preview ? " (미리보기 실행)" : ""}`,
    `- 기준 페이지: ${rootTitle}`,
    `- 출력 경로: \`${outputDir}\``,
    `- 동기화된 페이지: ${stats.filesWritten} / ${stats.pagesFound}`,
    `- 변환 실패: ${stats.pageErrors.length}건`,
    `- 이미지: 다운로드 ${stats.imagesDownloaded}개 · 생략 ${stats.imagesSkipped}개 · 실패 ${stats.imageErrors}개`,
    `- 경고: ${stats.warnings}건`,
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

/** 후속 스텝(알림 등)이 읽을 수 있게 통계를 GitHub Actions step output 으로 내보낸다. */
async function writeStepOutputs(stats, { rootTitle, elapsedSec }) {
  if (!process.env.GITHUB_OUTPUT) return;
  const outputs = {
    root_title: rootTitle.replace(/[\r\n]+/g, " "),
    pages_found: stats.pagesFound,
    files_written: stats.filesWritten,
    page_errors: stats.pageErrors.length,
    images_downloaded: stats.imagesDownloaded,
    image_errors: stats.imageErrors,
    warnings: stats.warnings,
    elapsed_sec: elapsedSec,
    // 실패한 페이지 제목은 알림 본문에 넣기 좋게 앞 5건만
    failed_titles: stats.pageErrors.slice(0, 5).map((e) => e.title).join(", ").replace(/[\r\n]+/g, " "),
  };
  const body = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join("\n");
  try {
    await writeFile(process.env.GITHUB_OUTPUT, body + "\n", { flag: "a" });
  } catch (e) {
    console.warn(`[warn] step output 기록 실패: ${e.message}`);
  }
}
