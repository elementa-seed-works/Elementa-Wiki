// 동기화 상태 파일
//
// 위키 저장소 안에 dotfile 로 함께 커밋한다. 위키는 .md 만 문서로 보여주므로 화면에는 나오지 않고,
// 산출물(.md)과 같은 커밋에 묶여 다음 실행이 "직전에 무엇을 어떤 모습으로 만들었는지" 를 그대로 알 수 있다.
//
// 담는 것
//  - pages: 페이지별 수정 시각·파일명·자식 순서. 변경 판정과 파일명 유지에 쓴다.
//  - blockOwners: 컬럼·토글 안에 든 페이지의 소유 페이지. 매번 다시 거슬러 올라가지 않으려고 캐시한다.
//
// version 또는 renderer 가 맞지 않으면 상태를 버리고 전체 동기화로 돌아간다.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const STATE_FILE = ".notion-sync-state.json";

// 상태 파일 스키마 버전. 구조가 바뀌면 올린다.
export const STATE_VERSION = 1;
// 마크다운 산출 규칙 버전. markdown.mjs 의 출력이 달라지면 올린다(캐시된 본문을 전부 다시 만든다).
export const RENDERER_VERSION = 1;

export function statePath(outputDir) {
  return path.join(outputDir, STATE_FILE);
}

/**
 * 이전 실행 상태를 읽는다. 없거나 읽을 수 없거나 버전이 다르면 null 을 돌려준다(= 전체 동기화).
 *
 * @param {string} outputDir
 * @param {(msg: string) => void} warn
 * @returns {Promise<{pages: object, blockOwners: object}|null>}
 */
export async function loadState(outputDir, warn = () => {}) {
  let raw;
  try {
    raw = await readFile(statePath(outputDir), "utf-8");
  } catch {
    return null;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    warn(`상태 파일을 읽지 못해 전체 동기화로 진행합니다: ${e.message}`);
    return null;
  }

  if (data.version !== STATE_VERSION || data.renderer !== RENDERER_VERSION) return null;
  if (!data.pages || typeof data.pages !== "object") return null;
  return { pages: data.pages, blockOwners: data.blockOwners || {} };
}

/**
 * 이번 실행 상태를 저장한다. 내용이 같으면 쓰지 않는다.
 * (실행 시각 같은 매번 달라지는 값을 넣지 않는 이유: 변경이 없는 실행이 위키 커밋을 만들지 않게 한다)
 *
 * @param {string} outputDir
 * @param {{pages: object, blockOwners: object}} state
 * @returns {Promise<boolean>} 실제로 썼는지
 */
export async function saveState(outputDir, { pages, blockOwners }) {
  const body = {
    version: STATE_VERSION,
    renderer: RENDERER_VERSION,
    pages,
    blockOwners,
  };
  const content = JSON.stringify(body, null, 2) + "\n";
  const file = statePath(outputDir);
  let existing = null;
  try {
    existing = await readFile(file, "utf-8");
  } catch {
    existing = null;
  }
  if (existing === content) return false;
  await writeFile(file, content, "utf-8");
  return true;
}

// 이 비율 미만으로 줄면 노션 쪽 사고(목록 응답 결손, 통합 연결 해제)로 본다.
// 실제로 절반 넘게 지웠다면 --full 로 한 번 돌려 상태를 새로 만들면 된다.
const MASS_LOSS_RATIO = 0.5;
// 문서가 몇 개 안 되는 위키에서는 정상적인 정리도 비율상 큰 폭이 된다.
const MASS_LOSS_MIN_PAGES = 10;

/**
 * 직전 실행보다 문서가 급격히 줄었는지 본다.
 *
 * 노션 목록 응답이 일부만 오면 멀쩡한 문서가 "삭제됨" 으로 판정돼 위키에서 통째로 사라진다.
 * 되돌리기 어려운 쪽이므로 지우기 전에 멈춘다.
 *
 * @param {{pages: object}|null} state 직전 실행 상태
 * @param {object[]} nodes 이번 실행 트리의 노드 배열
 * @returns {{known: number, current: number, suspicious: boolean}}
 */
export function detectMassLoss(state, nodes) {
  const known = Object.keys(state?.pages || {}).length;
  const current = nodes.length;
  const suspicious = known >= MASS_LOSS_MIN_PAGES && current < known * MASS_LOSS_RATIO;
  return { known, current, suspicious };
}

/**
 * 트리에서 다음 실행이 쓸 상태를 만든다.
 *
 * @param {object[]} nodes flatten 한 노드 배열
 * @returns {object} normId -> { kind, slug, title, lastEdited, childOrder }
 */
export function collectPageState(nodes) {
  const pages = {};
  for (const node of nodes) {
    pages[node.normId] = {
      kind: node.kind,
      slug: node.slug,
      title: node.title,
      lastEdited: node.lastEdited,
      childOrder: node.children.map((c) => c.normId),
    };
  }
  return pages;
}
