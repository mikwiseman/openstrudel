/** Quoted UI labels and product names often use a different language from the surrounding request. */
export function projectUsesRussian(request: string): boolean {
  const body = request.replace(/(?:__)?(?:Отправлено AI-помощником\.|Sent by an AI assistant\.)(?:__)?\s*$/u, "");
  const prose = body.replace(/«[^»]*»|“[^”]*”|‘[^’]*’|"[^"]*"|`[^`]*`|https?:\/\/\S+/gu, " ");
  const words = prose.match(/\p{L}+/gu) ?? body.match(/\p{L}+/gu) ?? [];
  const narrative = words.filter((word, i) => word === word.toLowerCase() || (i === 0 && /^\p{Lu}\p{Ll}*$/u.test(word)));
  const counted = narrative.length ? narrative : words;
  const cyrillic = (word: string) => /\p{Script=Cyrillic}/u.test(word);
  const russianWords = counted.filter(cyrillic).length;
  if (russianWords * 2 === counted.length) return cyrillic(counted[0] ?? "");
  return russianWords * 2 > counted.length;
}
