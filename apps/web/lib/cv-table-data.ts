export type CvRow = {
  id: string;
  company: string;
  jobTitle: string;
  status: string;
  revision: number;
  createdAt: Date | string;
};
export type CvPage = { rows: CvRow[]; total: number; page: number };
export type CvPages = { saved: CvPage; archived: CvPage };

/** Validate the response before it can replace a working table. */
export function isCvPage(value: unknown): value is CvPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(page.total) &&
    Number(page.total) >= 0 &&
    Number.isSafeInteger(page.page) &&
    Number(page.page) >= 1 &&
    Array.isArray(page.rows) &&
    page.rows.length <= 50 &&
    page.rows.every(
      (row) =>
        row &&
        typeof row === "object" &&
        typeof row.id === "string" &&
        typeof row.company === "string" &&
        typeof row.jobTitle === "string" &&
        ["queued", "generating", "ready", "failed"].includes(row.status) &&
        Number.isSafeInteger(row.revision) &&
        row.revision >= 0 &&
        (typeof row.createdAt === "string" || row.createdAt instanceof Date) &&
        Number.isFinite(new Date(row.createdAt).getTime()),
    )
  );
}
