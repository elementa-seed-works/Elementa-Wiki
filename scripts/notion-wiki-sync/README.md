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

### 2. 최상위 페이지 ID (이미 설정됨)

동기화 기준 페이지는 **SeedWork** (`37335566982b8053ace6d928bdf49f47`)로 스크립트에 기본값이 박혀 있다.
따라서 별도 설정 없이 `NOTION_TOKEN` 만 넣으면 된다.
다른 페이지로 바꾸려면 저장소 Variable `NOTION_ROOT_PAGE_ID` 에 새 페이지 ID를 넣으면 기본값을 덮어쓴다.
(페이지 ID = 노션 URL 끝의 32자리 hex)

### 3. GitHub 저장소 설정 (`Elementa-Wiki`)

Settings 에서:

- **Secrets and variables → Actions → Secrets**
  - `NOTION_TOKEN` = 1번에서 복사한 통합 토큰 (필수, 이것만 넣으면 됨)
- **Secrets and variables → Actions → Variables** *(선택)*
  - `NOTION_ROOT_PAGE_ID` — 기본 페이지를 바꾸고 싶을 때만
- **Actions → General → Workflow permissions**
  - `Read and write permissions` 선택 (위키 push 에 필요)
- **Settings → General → Features**
  - `Wikis` 활성화 + 위키에 페이지가 최소 1개 존재해야 push 가 된다 (현재 위키가 있으니 충족)

### 4. 파일 배치 후 커밋

위 3개 파일을 코드 저장소에 그대로 넣고 기본 브랜치에 push 한다.

### 5. 첫 실행

`Actions` 탭 → `Notion → Wiki Sync` → `Run workflow` 로 수동 실행해 결과를 확인한다.
이후에는 매시간 정각(UTC 기준)에 자동 실행된다.

## 동작 방식

- 최상위 페이지의 하위 `child_page` / `child_database` 를 재귀 수집
- 각 페이지를 마크다운으로 변환 (`notion-to-md`)
- 만료되는 Notion 이미지 URL 은 다운로드해 위키 `assets/` 에 커밋하고 링크를 로컬 경로로 치환
- 노션 페이지 간 내부 링크를 위키 슬러그로 치환
- 최상위(SeedWork) → `Home.md`, 나머지(Wiki·회의록 등) → `<제목-슬러그>.md`
- 하위 페이지가 있는 문서에는 본문 아래 `## 하위 페이지` 하이퍼링크 목록이 자동 삽입됨 (Home → Wiki·회의록 링크)
- 삭제된 노션 페이지 반영을 위해 매 실행 시 위키의 기존 `.md`/`assets` 를 재생성 (`.git` 제외)

## 알아둘 점

- **한 방향 동기화**다. 위키에서 직접 수정한 내용은 다음 실행 때 덮어써진다. 편집은 노션에서만.
- **변환 손실**: 토글·콜아웃·데이터베이스 뷰·임베드 등 일부 블록은 마크다운으로 단순화된다.
- **스케줄 지연/중단**: GitHub Actions 의 cron 은 부하에 따라 수 분 지연될 수 있고, 저장소가 60일간 비활성이면 스케줄이 자동 중단된다(수동 실행하면 재개).
- **push 권한**: 기본 `GITHUB_TOKEN` 으로 같은 저장소의 위키에 push 한다. 조직 정책으로 막히면
  별도 PAT(`repo` 권한)를 Secret 으로 추가하고 워크플로의 `x-access-token:${GH_TOKEN}` 부분을 그 PAT 로 바꾸면 된다.
