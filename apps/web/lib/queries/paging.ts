/**
 * One page of a list and the count that pages it, read side by side rather than count first: the
 * page asked for is read beside the count, and read again at the last page only when it turns out
 * to be past the end (a link written before the list shrank). One round trip on every ordinary
 * render instead of two.
 */
export async function readClampedPage<R>(
  requestedPage: number,
  count: () => Promise<number>,
  read: (page: number) => Promise<R>,
  size = 50,
): Promise<{ rows: R; total: number; page: number }> {
  const asked = Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1);
  const [total, first] = await Promise.all([count(), read(asked)]);
  const page = Math.min(asked, Math.max(1, Math.ceil(total / size)));
  return { rows: page === asked ? first : await read(page), total, page };
}
