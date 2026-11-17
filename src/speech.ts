const CODE_FENCE = /```[\s\S]*?```/g;
const TILDE_FENCE = /~~~[\s\S]*?~~~/g;
const INLINE_CODE = /`([^`]+)`/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]+\)/g;
const URL = /https?:\/\/\S+/g;
const HTML_TAG = /<[^>]+>/g;
const FILE_PATH = /(?:\/[\w.@+-]+){2,}/g;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
const TABLE_RULE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/gm;

export function cleanForSpeech(input: string): string {
  let text = input;
  text = text.replace(CODE_FENCE, ' ');
  text = text.replace(TILDE_FENCE, ' ');
  text = text.replace(INLINE_CODE, '$1');
  text = text.replace(IMAGE, ' ');
  text = text.replace(LINK, '$1');
  text = text.replace(URL, ' ');
  text = text.replace(HTML_TAG, ' ');
  text = text.replace(TABLE_RULE, ' ');
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s*[-+*]\s+/gm, '');
  text = text.replace(/^\s*\d+[.)]\s+/gm, '');
  text = text.replace(/^\s*[-=*_]{3,}\s*$/gm, ' ');
  text = text.replace(/[*_~]+/g, '');
  text = text.replace(/\|/g, ' ');
  text = text.replace(FILE_PATH, ' ');
  text = text.replace(EMOJI, ' ');
  text = text.replace(/\\n/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

export function chunkForSpeech(text: string, limit: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const sentence = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('; '),
    );
    let cut: number;
    if (sentence >= Math.floor(limit * 0.4)) {
      cut = sentence + 1;
    } else {
      const space = rest.lastIndexOf(' ', limit);
      cut = space > 0 ? space : limit;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

export function prepareForSpeech(text: string, maxChars: number): string {
  const clean = cleanForSpeech(text);
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > maxChars * 0.5 ? cut.slice(0, end + 1) : cut).trim();
}
