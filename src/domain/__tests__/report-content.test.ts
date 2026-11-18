import { describe, expect, it } from 'vitest';
import { hasReportText, reportHtmlToText, sanitizeReportHtml } from '../report-content.js';

describe('report rich text', () => {
  it('keeps the formatting the editor can produce', () => {
    const html =
      '<p><strong>Gate</strong> was <em>open</em></p><ul><li>Latch broken</li><li>Reported to the lead</li></ul>';
    const clean = sanitizeReportHtml(html);
    expect(clean).toContain('<strong>Gate</strong>');
    expect(clean).toContain('<em>open</em>');
    expect(clean).toContain('<li>Latch broken</li>');
  });

  it('drops scripts, event handlers, images and styles', () => {
    const html =
      '<p onclick="steal()">Delivered</p><script>alert(1)</script><img src="x" onerror="alert(2)"><style>body{display:none}</style>';
    const clean = sanitizeReportHtml(html);
    expect(clean).toBe('<p>Delivered</p>');
  });

  it('refuses javascript and data links', () => {
    const clean = sanitizeReportHtml('<a href="javascript:alert(1)">tap</a><a href="data:text/html,x">x</a>');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('data:');
  });

  it('keeps ordinary web links', () => {
    const clean = sanitizeReportHtml('<a href="https://example.com/log" title="Log">Log</a>');
    expect(clean).toContain('href="https://example.com/log"');
  });

  it('treats markup without text as empty', () => {
    expect(hasReportText('<p>   </p><ul><li></li></ul>')).toBe(false);
    expect(hasReportText('<p>&nbsp;</p>')).toBe(false);
    expect(hasReportText('<p>Something happened</p>')).toBe(true);
  });

  it('flattens rich text to text without markup', () => {
    const text = reportHtmlToText('<p>Line one</p><p>Line two</p>');
    expect(text).toContain('Line one');
    expect(text).toContain('Line two');
    expect(text).not.toContain('<');
  });
});
