// 위키 파일명/링크에 쓸 슬러그 생성
//
// 공백은 "-", 파일명에 못 쓰는 문자는 제거.
// GitHub 위키는 파일명의 "-" 를 표시상 공백으로 되돌려 보여준다.

export function slugify(title) {
  const cleaned = String(title || "Untitled")
    .replace(/[\/\\:\*\?"<>\|#\[\]]/g, " ") // 파일명/위키 금칙 문자
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.replace(/ /g, "-") || "Untitled";
}

/** 슬러그 충돌 방지 레지스트리. 대소문자 무시(위키 파일명은 대소문자를 구분하지 않는다). */
export function createSlugRegistry(reserved = ["Home", "_Sidebar"]) {
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
  };
}
