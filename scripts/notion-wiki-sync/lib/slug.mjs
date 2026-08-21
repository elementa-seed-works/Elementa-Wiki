// 위키 파일명/링크에 쓸 슬러그 생성
//
// GitHub 위키는 파일명의 "-" 를 표시상 공백으로 되돌려 보여준다.
// 마크다운 링크 목적지에 괄호가 들어가면 링크가 깨지므로 괄호류는 슬러그에서 제거한다.
// (원래 제목은 페이지 본문 H1 과 사이드바에 그대로 남는다.)

const FORBIDDEN = /[\/\\:*?"<>|#\[\]()&%{}`^~;,'’“”]/g;

export function slugify(title) {
  const cleaned = String(title || "Untitled")
    .replace(/\p{Extended_Pictographic}️?/gu, " ") // 이모지는 파일명에서 뺀다
    .replace(FORBIDDEN, " ")
    .replace(/\s+/g, " ")
    .trim();

  const slug = cleaned
    .replace(/ /g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return slug || "Untitled";
}

/** 슬러그 충돌 방지 레지스트리. 대소문자 무시(위키 파일명은 대소문자를 구분하지 않는다). */
export function createSlugRegistry(reserved = ["Home", "_Sidebar", "_Footer"]) {
  const used = new Set(reserved.map((s) => s.toLowerCase()));
  return {
    take(title) {
      const base = slugify(title);
      let slug = base;
      let n = 2;
      while (used.has(slug.toLowerCase())) slug = `${base}-${n++}`;
      used.add(slug.toLowerCase());
      return slug;
    },
    /**
     * 특정 슬러그를 그대로 잡는다(이전 실행에서 쓰던 파일명 유지용).
     * @returns {boolean} 이미 쓰이고 있으면 false
     */
    claim(slug) {
      const key = String(slug || "").toLowerCase();
      if (!key || used.has(key)) return false;
      used.add(key);
      return true;
    },
  };
}
