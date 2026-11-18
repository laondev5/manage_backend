const DANGEROUS_PREFIX = /^[\s]*[=+\-@\t\r]/;

export function safeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (DANGEROUS_PREFIX.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(safeCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(safeCsvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
