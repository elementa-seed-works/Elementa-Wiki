// 실행 통계와 요약 출력 (콘솔 + GitHub Actions Step Summary)

import { writeFile } from "node:fs/promises";

export function createStats() {
  return {
    startMs: Date.now(),
    incremental: false, // 상태 파일을 써서 변경분만 처리했는지
    pagesFound: 0,
    pagesRendered: 0, // 노션을 다시 불러 본문을 만든 문서
    pagesReused: 0, // 직전 산출물에서 본문을 그대로 쓴 문서
    orderRefreshes: 0, // 자식 순서를 다시 읽으려고 블록을 훑은 페이지
    adopted: 0, // 검색 목록에 없어 개별 조회한 항목
    recovered: 0, // 목록에서 빠졌지만 살아 있어 되살린 문서
    filesWritten: 0,
    filesDeleted: 0,
    pageErrors: [], // { title, message }
    imagesDownloaded: 0,
    imagesSkipped: 0,
    imageErrors: 0,
    assetsRemoved: 0,
    warnings: 0,
  };
}

export async function writeSummary(stats, { rootTitle, outputDir, preview, api = null }) {
  const elapsedSec = ((Date.now() - stats.startMs) / 1000).toFixed(1);
  const ok = stats.pageErrors.length === 0;
  await writeStepOutputs(stats, { rootTitle, elapsedSec, api });

  const lines = [
    `## 🔄 Notion → Wiki 동기화 결과`,
    "",
    `- 상태: ${ok ? "✅ 성공" : "⚠️ 일부 실패"}${preview ? " (미리보기 실행)" : ""}`,
    `- 방식: ${stats.incremental ? "증분(변경된 페이지만)" : "전체"}`,
    `- 기준 페이지: ${rootTitle}`,
    `- 출력 경로: \`${outputDir}\``,
    `- 문서: 총 ${stats.pagesFound}개 · 본문 재생성 ${stats.pagesRendered}개 · 재사용 ${stats.pagesReused}개`,
    `- 파일: 기록 ${stats.filesWritten}개 · 삭제 ${stats.filesDeleted}개`,
    `- 순서 재확인: ${stats.orderRefreshes}개 페이지 · 목록 밖 개별 조회: ${stats.adopted + stats.recovered}건`,
    `- 변환 실패: ${stats.pageErrors.length}건`,
    `- 이미지: 다운로드 ${stats.imagesDownloaded}개 · 생략 ${stats.imagesSkipped}개 · 실패 ${stats.imageErrors}개 · 미참조 정리 ${stats.assetsRemoved}개`,
    `- 경고: ${stats.warnings}건`,
    `- 소요 시간: ${elapsedSec}s`,
  ];

  if (api) {
    lines.push(
      `- 노션 API: 요청 ${api.requests}회 · 재시도 ${api.retries}회(429 ${api.rateLimited}회) · 블록 재사용 ${api.cacheHits}회`,
    );
  }
  lines.push("");

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
async function writeStepOutputs(stats, { rootTitle, elapsedSec, api }) {
  if (!process.env.GITHUB_OUTPUT) return;
  const outputs = {
    root_title: rootTitle.replace(/[\r\n]+/g, " "),
    mode: stats.incremental ? "incremental" : "full",
    pages_found: stats.pagesFound,
    pages_rendered: stats.pagesRendered,
    pages_reused: stats.pagesReused,
    files_written: stats.filesWritten,
    files_deleted: stats.filesDeleted,
    page_errors: stats.pageErrors.length,
    images_downloaded: stats.imagesDownloaded,
    image_errors: stats.imageErrors,
    api_requests: api ? api.requests : 0,
    api_rate_limited: api ? api.rateLimited : 0,
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
