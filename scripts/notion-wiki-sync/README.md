# Notion → GitHub Wiki 자동 동기화

Notion을 원본(source of truth)으로 두고, 매시간 GitHub Wiki로 한 방향 동기화한다.

## 구성 파일

```
.github/workflows/notion-wiki-sync.yml   매시간/수동 실행 워크플로
scripts/notion-wiki-sync/
├── sync.mjs          진입점 (오케스트레이션)
├── .env.example      로컬 실행용 설정 예시
└── lib/
    ├── config.mjs    설정 로딩(.env + 환경변수 + CLI 플래그)
    ├── notion.mjs    Notion API 접근 (페이지네이션, 값 추출)
    ├── tree.mjs      페이지 트리 구성 (DB 그룹화, 관계 기반 계층)
    ├── slug.mjs      위키 파일명 슬러그
    ├── markdown.mjs  페이지 → 마크다운 변환, 이미지/링크 치환
    ├── sidebar.mjs   _Sidebar.md / _Footer.md
    └── summary.mjs   실행 통계
```

이 파일들은 **위키 저장소가 아니라 코드 저장소(`Elementa-Wiki`)의 기본 브랜치**에 넣는다.
워크플로가 실행되면서 위키(`Elementa-Wiki.wiki.git`)에 결과를 push 한다.

## 로컬에서 결과 미리보기

위키에 push 하지 않고 산출물을 눈으로 확인할 수 있다.

```powershell
cd scripts/notion-wiki-sync
npm install
Copy-Item .env.example .env   # NOTION_TOKEN 채우기
npm run preview               # <repo>/wiki-preview 에 생성
npm run preview:fast          # 이미지 다운로드 생략 (빠른 반복 확인)
```

`.env` 는 `.gitignore` 에 있어 커밋되지 않는다. `wiki-preview/` 는 검수용으로 커밋한다.

CLI 플래그: `--preview`(출력 경로 고정), `--out <dir>`(경로 직접 지정), `--skip-images`.

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
- `WIKI_TOKEN` (사실상 필수) = 위키 push 용 classic PAT(`repo` 스코프). 아래 "토큰 두 개의 차이" 참고

**Variables 탭**

| 이름 | 필수 | 뜻 |
| --- | --- | --- |
| `NOTION_ROOT_PAGE_ID` | 필수 | 트리 루트 페이지 ID (예: SeedWork `37335566982b8053ace6d928bdf49f47`) |
| `NOTION_HOME_PAGE_ID` | 선택 | 위키 Home 에 표시할 페이지 ID (예: Main `3ab35566982b80a09a8ce9d306179d2f`). 통합이 이 페이지에도 연결돼 있어야 한다 |
| `NOTION_DB_PARENT_PROP` | 선택 | 데이터베이스 계층을 만드는 자기참조 관계 속성 이름. 비우면 자동 추론 |
| `NOTION_SKIP_IDS` | 선택 | 트리에서 통째로 뺄 페이지/DB ID (쉼표 구분) |
| `WIKI_TITLE` | 선택 | 사이드바·푸터에 쓰는 위키 이름 (기본 `Elementa Wiki`) |

**그 외**

- Settings → General → Features → `Wikis` 활성화 + 위키에 페이지 1개 이상 존재

#### 토큰 두 개의 차이 (`GITHUB_TOKEN` vs `WIKI_TOKEN`)

- `GITHUB_TOKEN` — GitHub Actions 가 실행할 때 **자동으로 주입하는 내장 토큰**. 직접 만들지 않는다.
  조직이 기본 권한을 읽기 전용으로 잠가두면 이 토큰으로는 위키 push 가 막힌다.
- `WIKI_TOKEN` — **사용자가 직접 발급해 등록하는 PAT**. 조직 정책과 무관하게 push 가 된다.
- 워크플로는 `secrets.WIKI_TOKEN || secrets.GITHUB_TOKEN` 순으로 쓴다.

### 4. 첫 실행

`Actions` 탭 → `Notion → Wiki Sync` → `Run workflow` 로 수동 실행해 결과를 확인한다.
이후에는 매시간 정각(UTC 기준)에 자동 실행된다.

## 트리 구성 규칙

노션 구조를 위키 계층으로 옮길 때 적용하는 규칙이다.

- `child_page` 는 그대로 하위 문서가 된다. 컬럼·토글·콜아웃·synced block 안에 중첩된 것도 찾아낸다.
- **데이터베이스는 그룹 문서**가 되고, 행(row)이 그 아래에 붙는다.
  (행을 루트 직속으로 쏟아부으면 Home 하위 목록이 평면 100줄이 된다)
- 데이터베이스가 **자기참조 관계**(`상위 항목`/`하위 항목`)를 가지면 그 관계로 계층을 복원한다.
  자식 순서는 `하위 항목` 관계 배열의 순서를 그대로 쓴다(노션에서 정렬한 순서).
- 정렬: 날짜 속성이 있으면 최신순, 없으면 제목 자연순(`1-2` 가 `1-10` 보다 앞).
- `NOTION_HOME_PAGE_ID` 페이지는 `Home.md` 로 흡수되고 별도 문서를 만들지 않는다.
  그 페이지의 하위 문서는 Home 아래로 끌어올린다.
- 같은 페이지가 두 경로로 닿아도 문서는 하나만 만든다.

## 산출물

| 파일 | 내용 |
| --- | --- |
| `Home.md` | `NOTION_HOME_PAGE_ID` 페이지 내용 (미지정 시 루트 페이지) |
| `<슬러그>.md` | 페이지별 문서 |
| `_Sidebar.md` | 계층 전체를 담은 접이식 HTML 트리 |
| `_Footer.md` | 모든 문서 하단에 붙는 공통 안내 |
| `assets/` | 내려받은 노션 이미지 |

각 문서는 이렇게 구성된다.

```markdown
[🏠 Home](Home) › [📑 Wiki](Wiki) › **1. 게임 PRD**   ← 현재 위치

# 🎮 1. 게임 PRD

<노션 본문>

## 📂 하위 문서 3건                                   ← 직속 하위만
- [1-1. 게임 개요](1-1.-게임-개요)
```

### 슬러그 규칙

제목에서 이모지와 파일명 금칙 문자를 지우고 공백을 `-` 로 바꾼다.
**괄호(`(`, `)`)도 지운다** — 마크다운 링크 목적지에 괄호가 들어가면 링크가 깨지기 때문이다.
제목이 겹치면 뒤에 `-2`, `-3` 을 붙인다. 원래 제목은 문서 H1 과 사이드바에 그대로 남는다.

### 사이드바를 HTML 로만 쓰는 이유

GitHub 는 HTML 블록 안의 마크다운 목록(`- `)을 리스트로 파싱하지 않는다.
`<details>` 안에 `- [제목](링크)` 를 넣으면 전부 한 문단으로 뭉개져 `- 링크 - 링크 -` 처럼 보인다.
그래서 사이드바는 `<ul>`/`<li>`/`<details>` 만 쓰고, **HTML 블록 중간에 빈 줄을 넣지 않는다**(빈 줄에서 블록이 끊긴다).
최상위 항목만 펼친 상태이고 그 아래는 접혀 있다.

## 알아둘 점

- **한 방향 동기화**다. 위키에서 직접 수정한 내용은 다음 실행 때 덮어써진다. 편집은 노션에서만.
- **변환 손실**: 콜아웃·데이터베이스 뷰·임베드 등 일부 블록은 마크다운으로 단순화된다.
- **스케줄 지연/중단**: cron 은 부하에 따라 수 분 지연될 수 있고, 저장소가 60일간 비활성이면 스케줄이 자동 중단된다(수동 실행하면 재개).
- 삭제된 노션 페이지를 반영하려고 매 실행 시 위키의 기존 파일을 재생성한다(`.git` 제외).
- 실행이 끝나면 Actions 실행 페이지의 **Summary** 패널에 통계가 출력되고, 실패한 페이지는 표로 정리된다.
