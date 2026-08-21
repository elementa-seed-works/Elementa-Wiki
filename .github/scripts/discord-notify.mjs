// 동기화 결과를 Discord 웹훅으로 보낸다.
//
// 필요한 환경변수
//   DISCORD_WEBHOOK  웹훅 URL. 비어 있으면 아무것도 하지 않고 종료(선택 기능이므로)
//   JOB_STATUS       success | failure | cancelled
//   NOTIFY_ON        change(기본) | always | failure
//   CHANGED          위키에 실제로 push 했는지 ("true"/"false")
//   그 외 통계값은 아래 buildEmbed 참고
//
// 알림 전송에 실패해도 종료 코드 0 을 돌려준다. 위키 동기화 자체는 이미 끝났고,
// 알림 실패로 워크플로를 빨갛게 만들 이유가 없다. 대신 ::warning:: 주석을 남겨
// 실행 요약에 드러나게 한다.
//
// 로컬 확인: DISCORD_DRY_RUN=1 node .github/scripts/discord-notify.mjs

const env = (name, fallback = "") => process.env[name] || fallback;

const COLOR = {
  success: 0x2ecc71,
  neutral: 0x95a5a6,
  failure: 0xe74c3c,
};

/** 알림을 보낼지 판단한다. 매시간 도는 워크플로라 기본값은 "변경 있거나 실패했을 때만". */
function shouldNotify({ status, changed, notifyOn }) {
  if (notifyOn === "always") return true;
  if (notifyOn === "failure") return status !== "success";
  return status !== "success" || changed === "true";
}

function buildEmbed({ status, changed }) {
  const runUrl = env("RUN_URL");
  const wikiUrl = env("WIKI_URL");

  let title;
  let color;
  const lines = [];

  if (status === "success" && changed === "true") {
    title = "✅ 위키 동기화 완료";
    color = COLOR.success;
    lines.push(`문서 ${env("FILES_CHANGED", "?")}개가 갱신됐습니다.`);
  } else if (status === "success") {
    title = "➖ 위키 변경 없음";
    color = COLOR.neutral;
    lines.push("노션에 바뀐 내용이 없어 push 를 생략했습니다.");
  } else if (status === "cancelled") {
    title = "⏹️ 위키 동기화 취소";
    color = COLOR.neutral;
    lines.push("실행이 취소됐습니다.");
  } else {
    title = "❌ 위키 동기화 실패";
    color = COLOR.failure;
    lines.push("워크플로가 실패했습니다. 실행 로그를 확인하세요.");
  }

  const failedTitles = env("FAILED_TITLES");
  if (failedTitles) lines.push(`변환 실패: ${failedTitles}`);

  const links = [runUrl && `[실행 로그](${runUrl})`, wikiUrl && `[위키 열기](${wikiUrl})`].filter(Boolean);
  if (links.length) lines.push("", links.join(" · "));

  return {
    title,
    description: lines.join("\n"),
    url: wikiUrl || undefined,
    color,
    timestamp: new Date().toISOString(),
    fields: [
      { name: "문서", value: `${env("FILES_WRITTEN", "0")} / ${env("PAGES_FOUND", "0")}`, inline: true },
      { name: "본문 재생성", value: `${env("PAGES_RENDERED", "0")}개`, inline: true },
      { name: "변환 실패", value: `${env("PAGE_ERRORS", "0")}건`, inline: true },
      { name: "이미지", value: `${env("IMAGES_DOWNLOADED", "0")}개`, inline: true },
      { name: "노션 요청", value: `${env("API_REQUESTS", "0")}회`, inline: true },
      { name: "소요", value: `${env("ELAPSED_SEC", "0")}s`, inline: true },
    ],
    footer: { text: `${env("ROOT_TITLE", "Notion")} · ${env("MODE") === "full" ? "전체" : "증분"} 동기화` },
  };
}

async function main() {
  const webhook = env("DISCORD_WEBHOOK");
  const dryRun = env("DISCORD_DRY_RUN") === "1";
  if (!webhook && !dryRun) {
    console.log("DISCORD_WEBHOOK_URL 미설정 — 알림 생략");
    return;
  }

  const status = env("JOB_STATUS", "success");
  const changed = env("CHANGED", "false");
  const notifyOn = env("NOTIFY_ON", "change");

  if (!shouldNotify({ status, changed, notifyOn })) {
    console.log(`알림 조건 불충족 (notify_on=${notifyOn}, status=${status}, changed=${changed}) — 생략`);
    return;
  }

  const payload = {
    username: "Notion Wiki Sync",
    embeds: [buildEmbed({ status, changed })],
  };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    console.log(`Discord 알림 전송 완료 (HTTP ${res.status})`);
  } else {
    const body = await res.text().catch(() => "");
    console.log(`::warning::Discord 알림 전송 실패 (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
}

main().catch((e) => {
  console.log(`::warning::Discord 알림 처리 중 오류: ${e.message}`);
});
