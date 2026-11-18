import sanitizeHtml from 'sanitize-html';

/**
 * Reports are written in a WebView rich text editor, so the body is HTML from
 * the client. Only formatting that the app itself can produce is kept: no
 * scripts, no styles, no images, no event handlers. The stored document is
 * therefore safe to render back into a WebView.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'div',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'strike',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'blockquote',
  'a',
  'code',
  'pre',
];

export function sanitizeReportHtml(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'discard',
    parseStyleAttributes: false,
    enforceHtmlBoundary: true,
  }).trim();
}

/** Text content only, used for emptiness checks, list previews and audit text. */
export function reportHtmlToText(input: string): string {
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function hasReportText(html: string): boolean {
  return reportHtmlToText(html).replace(/\s+/g, '').length > 0;
}
