# Elementa-Wiki

Notion의 SeedWork 페이지 트리를 GitHub Wiki로 한 방향 동기화하는 워크플로 저장소다.
위키 본문은 이 저장소가 아니라 `Elementa-Wiki.wiki.git` 에 push 된다.

| 경로 | 내용 |
| --- | --- |
| [.github/workflows/notion-wiki-sync.yml](.github/workflows/notion-wiki-sync.yml) | 매시간/수동 실행 워크플로 |
| [.github/scripts/discord-notify.mjs](.github/scripts/discord-notify.mjs) | 실행 결과 Discord 알림 |
| [scripts/notion-wiki-sync/](scripts/notion-wiki-sync/) | 변환 스크립트와 설정 문서 |

설정과 동작 규칙은 [scripts/notion-wiki-sync/README.md](scripts/notion-wiki-sync/README.md)를 본다.

## 산출물 미리보기

`Actions` → `Notion → Wiki Sync` → `Run workflow` → 미리보기 체크박스를 켜고 실행하면,
위키에 push 하지 않고 생성된 문서를 `wiki-preview` 아티팩트로 받아볼 수 있다.

로컬에서 돌리려면 Notion 토큰이 필요하다.

```powershell
cd scripts/notion-wiki-sync
npm install
Copy-Item .env.example .env   # NOTION_TOKEN 채우기
npm run preview               # wiki-preview/ 에 생성
```
