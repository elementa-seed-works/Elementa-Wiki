// 실행 설정 로딩

import path from "node:path";

export function loadConfig() {
  return {
    notionToken: process.env.NOTION_TOKEN || "",
    // 동기화 기준(트리 루트) 페이지 ID. 반드시 저장소 Variable 로 주입한다.
    rootPageId: process.env.NOTION_ROOT_PAGE_ID || "",
    // Home(위키 첫 페이지)에 표시할 페이지 ID. 지정 시 루트 대신 이 페이지 내용을 Home 으로 쓴다.
    homePageId: process.env.NOTION_HOME_PAGE_ID || "",
    outputDir: path.resolve(process.env.OUTPUT_DIR || "./wiki"),
    assetsSubdir: "assets",
  };
}

/** 필수값 검증. 부족하면 사람이 읽을 수 있는 오류 메시지 배열을 돌려준다. */
export function validateConfig(config) {
  const errors = [];
  if (!config.notionToken) {
    errors.push("환경변수 NOTION_TOKEN 이 필요합니다.");
  }
  if (!config.rootPageId) {
    errors.push("환경변수 NOTION_ROOT_PAGE_ID 가 필요합니다. (저장소 Settings → Variables 에 등록)");
  }
  return errors;
}
