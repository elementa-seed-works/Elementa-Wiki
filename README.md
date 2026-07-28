# Elementa-Wiki

Notion의 SeedWork 페이지 트리를 GitHub Wiki로 한 방향 동기화하는 워크플로 저장소다.
위키 본문은 이 저장소가 아니라 `Elementa-Wiki.wiki.git` 에 push 된다.

| 경로 | 내용 |
| --- | --- |
| [.github/workflows/notion-wiki-sync.yml](.github/workflows/notion-wiki-sync.yml) | 매시간/수동 실행 워크플로 |
| [scripts/notion-wiki-sync/](scripts/notion-wiki-sync/) | 변환 스크립트와 설정 문서 |
| `wiki-preview/` | 로컬에서 뽑아본 위키 산출물(검수용, push 대상 아님) |

설정과 동작 규칙은 [scripts/notion-wiki-sync/README.md](scripts/notion-wiki-sync/README.md)를 본다.

## 산출물 미리보기

```powershell
cd scripts/notion-wiki-sync
npm install
Copy-Item .env.example .env   # NOTION_TOKEN 채우기
npm run preview               # wiki-preview/ 에 생성
```
