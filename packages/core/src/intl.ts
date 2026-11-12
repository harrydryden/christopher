/** Reuse native formatters without retaining user data or an unbounded set of time zones. */
let dateFormats: Map<string, Intl.DateTimeFormat> | undefined;
const MAX_DATE_FORMATS = 32;

export function dateTimeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const formats = dateFormats ??= new Map<string, Intl.DateTimeFormat>();
  const key = JSON.stringify(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)));
  const existing = formats.get(key);
  if (existing) return existing;
  // Construct first: invalid options must throw without evicting a valid formatter.
  const formatter = new Intl.DateTimeFormat("en-GB", options);
  if (formats.size >= MAX_DATE_FORMATS) formats.delete(formats.keys().next().value!);
  formats.set(key, formatter);
  return formatter;
}
