# Notion → GitHub Wiki 자동 동기화

Notion을 원본(source of truth)으로 두고, 매시간 GitHub Wiki로 한 방향 동기화한다.
사이드바(`_Sidebar.md`)는 페이지 계층에 따라 `<details>` 토글 형식으로 자동 생성된다.

## 구성 파일

- `.github/workflows/notion-wiki-sync.yml` — 매시간/수동 실행 워크플로
- `scripts/notion-wiki-sync/sync.mjs` — 변환·생성 스크립트
- `scripts/notion-wiki-sync/package.json` — 의존성 정의

이 파일들은 **위키 저장소가 아니라 코드 저장소(`Elementa-Wiki`)의 기본 브랜치**에 넣는다.
워크플로가 실행되면서 위키(`Elementa-Wiki.wiki.git`)에 결과를 push 한다.

## 설정 절차

### 1. Notion 통합(integration) 생성

1. https://www.notion.so/my-integrations 에서 `New integration` 생성 (Internal 유형)
2. 발급된 `Internal Integration Token` 복사 → GitHub Secret `NOTION_TOKEN` 값으로 사용
3. 동기화할 **최상위 Notion 페이지**를 열고, 우측 상단 `...` → `Connections` → 방금 만든 통합을 연결
   - 하위 페이지는 상위에 연결하면 자동 상속되므로 최상위 한 번만 연결하면 된다

### 2. 최상위 페이지 ID 확인

동기화 기준 페이지 ID는 코드에 박아두지 않고 **저장소 Variable 로만** 주입한다(노출 방지).
페이지 ID = 노션 URL 끝의 32자리 hex. SeedWork 페이지면 `37335566982b8053ace6d928bdf49f47`.

### 3. GitHub 저장소 설정 (`Elementa-Wiki`)

Settings → Secrets and variables → Actions 에서 아래를 등록한다.

**Secrets 탭**

- `NOTION_TOKEN` (필수) = 1번 통합 토큰
- `WIKI_TOKEN` (사실상 필수) = 위키 push 용 classic PAT(`repo` 스코프).
  아래 "토큰 두 개의 차이" 참고. 조직 정책상 이걸 넣는 게 안전하다.

**Variables 탭**

- `NOTION_ROOT_PAGE_ID` (필수) = 트리 루트 페이지 ID (하위 페이지 탐색 기준. 예: SeedWork `37335566982b8053ace6d928bdf49f47`)
- `NOTION_HOME_PAGE_ID` (선택) = 위키 Home 에 표시할 페이지 ID.
  지정하면 루트 대신 이 페이지 내용이 `Home.md` 가 된다. (예: Main `3ab35566982b80a09a8ce9d306179d2f`)
  통합(integration)이 이 페이지에도 연결돼 있어야 한다.

**그 외**

- Settings → General → Features → `Wikis` 활성화 + 위키에 페이지 1개 이상 존재(현재 충족)

#### 토큰 두 개의 차이 (`GITHUB_TOKEN` vs `WIKI_TOKEN`)

- `GITHUB_TOKEN` — GitHub Actions 가 실행할 때 **자동으로 주입하는 내장 토큰**. 직접 만들지 않는다.
  조직이 기본 권한을 읽기 전용으로 잠가두면 이 토큰으로는 위키 push 가 막힌다.
- `WIKI_TOKEN` — **사용자가 직접 발급해 등록하는 PAT**. 조직 정책과 무관하게 push 가 된다.
- 워크플로는 `secrets.WIKI_TOKEN || secrets.GITHUB_TOKEN` 순으로 쓴다.
  즉 **`WIKI_TOKEN` 을 등록하면 그게 우선 사용**되고, 없으면 자동으로 `GITHUB_TOKEN` 으로 폴백한다.
  결론: 조직 정책이 걸려 있으면 `WIKI_TOKEN` 을 등록하면 되고, Actions 의 "Workflow permissions" 는 건드릴 필요 없다.

### 4. 파일 배치 후 커밋

위 3개 파일을 코드 저장소에 그대로 넣고 기본 브랜치에 push 한다.

### 5. 첫 실행

`Actions` 탭 → `Notion → Wiki Sync` → `Run workflow` 로 수동 실행해 결과를 확인한다.
이후에는 매시간 정각(UTC 기준)에 자동 실행된다.

## 동작 방식

- 루트 페이지 하위의 `child_page` / `child_database` 를 **재귀적으로** 수집한다.
  컬럼·토글·콜아웃·synced block 같은 컨테이너 안에 중첩된 하위 페이지도 파고들어 찾는다.
- 하위 페이지/DB 링크는 본문에 인라인으로 남기지 않고, `## 하위 페이지` 섹션과 사이드바로만 노출한다(중복 방지).
- 각 페이지를 마크다운으로 변환 (`notion-to-md`)
- 만료되는 Notion 이미지 URL 은 다운로드해 위키 `assets/` 에 커밋하고 링크를 로컬 경로로 치환
- 노션 페이지 간 내부 링크를 위키 슬러그로 치환
- `Home.md` = `NOTION_HOME_PAGE_ID`(Main) 내용, 나머지(Wiki·회의록 등) → `<제목-슬러그>.md`
  (`NOTION_HOME_PAGE_ID` 미지정 시 Home 은 루트 페이지 내용)
- 하위 페이지가 있는 문서에는 본문 아래 `## 하위 페이지` 하이퍼링크 목록이 자동 삽입됨 (Home → Wiki·회의록 링크)
- 삭제된 노션 페이지 반영을 위해 매 실행 시 위키의 기존 `.md`/`assets` 를 재생성 (`.git` 제외)
- 실행이 끝나면 Actions 실행 페이지의 **Summary** 패널에 통계(동기화 페이지 수, 변환 실패, 이미지 다운로드, 소요 시간)를 출력하고, 실패한 페이지는 표로 정리한다

## 알아둘 점

- **한 방향 동기화**다. 위키에서 직접 수정한 내용은 다음 실행 때 덮어써진다. 편집은 노션에서만.
- **변환 손실**: 토글·콜아웃·데이터베이스 뷰·임베드 등 일부 블록은 마크다운으로 단순화된다.
- **스케줄 지연/중단**: GitHub Actions 의 cron 은 부하에 따라 수 분 지연될 수 있고, 저장소가 60일간 비활성이면 스케줄이 자동 중단된다(수동 실행하면 재개).
- **push 권한**: 기본 `GITHUB_TOKEN` 으로 같은 저장소의 위키에 push 한다.
  조직(예: elementa-seed-works) 정책으로 "Read and write permissions" 가 회색 처리되어 못 고르는 경우,
  아래 둘 중 하나로 해결한다.
  - (권장) classic PAT 를 `repo` 스코프로 발급 → 저장소 Secret `WIKI_TOKEN` 으로 등록.
    워크플로가 `WIKI_TOKEN` 이 있으면 자동으로 그것을 사용한다. 조직 설정은 건드릴 필요 없음.
  - 또는 조직 Owner 가 Organization → Settings → Actions → General → Workflow permissions 를
    Read and write 로 바꾸면 저장소 레벨 설정이 활성화된다.
