/** Read one private role description; confirmation and job creation belong to the web action. */
import { and, eq } from "drizzle-orm";
import { extractMainText, extractPostingFromPage, JS_SHELL_TEXT, stripHtml, type TaskPayloads } from "@col/core";
import { schema, type Db, type Task } from "@col/db";
import { makeFetchContext, type WorkerDeps } from "../context";
import { documentToText, DocumentReadError, tidyDocumentText } from "../document-text";
import { HostBusyError, PrivateAddressError } from "../fetcher";

const MAX_ROLE_TEXT = 60_000;

type ReadResult = {
  title: string | null;
  companyName: string | null;
  location: string | null;
  descriptionText: string;
  truncated: boolean;
};

function readableError(error: unknown): string {
  if (error instanceof DocumentReadError) return error.message.replaceAll("CV", "job description");
  if (error instanceof PrivateAddressError) return "That address points to a private network. Paste the job description instead.";
  if (error instanceof HostBusyError) return "The website asked us to wait. Retry this link later or paste its job description.";
  const message = error instanceof Error ? error.message : "The description could not be read.";
  if (/bot challenge|captcha|robots\.txt|blocked|access denied/i.test(message))
    return "The website prevents automated reading. Paste the job description instead.";
  if (/role text too long/i.test(message))
    return "That page has more than 60,000 characters of role text. Paste only the job description instead.";
  if (/no readable role text/i.test(message))
    return "That link has too little readable job description text. Check it opens the role itself or paste its text.";
  return "The description could not be read from that link. Check it opens without signing in, then retry or paste its text.";
}

async function readLink(url: string, deps: WorkerDeps): Promise<ReadResult> {
  const ctx = makeFetchContext(deps);
  const response = await ctx.fetchText(url, { timeoutMs: 20_000, maxBodyBytes: 3_000_000 });
  if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
  let html = response.body;
  let finalUrl = response.url || url;
  if (stripHtml(html).length < JS_SHELL_TEXT && ctx.render) {
    // A Javascript shell may be rendered; a blocked/challenged fetch is never sent to a browser.
    const rendered = await ctx.render(url);
    if (rendered.status !== null && rendered.status >= 400) throw new Error(`HTTP ${rendered.status}`);
    if (rendered.html) { html = rendered.html; finalUrl = rendered.finalUrl || finalUrl; }
  }
  const posting = extractPostingFromPage(html, finalUrl);
  const descriptionText = tidyDocumentText(posting?.descriptionText ?? extractMainText(html) ?? "");
  if (descriptionText.length < 80) throw new Error("no readable role text");
  if (descriptionText.length > MAX_ROLE_TEXT) throw new Error("role text too long");
  return { title: posting?.title ?? null, companyName: posting?.companyName ?? null,
    location: posting?.location ?? null, descriptionText, truncated: false };
}

async function readPdf(sourceBytes: string): Promise<ReadResult> {
  const converted = await documentToText(Buffer.from(sourceBytes, "base64"), "application/pdf");
  if (converted.kind !== "pdf") throw new DocumentReadError("Upload a PDF exported from the job description.");
  if (converted.truncated) throw new DocumentReadError("That PDF's text is too long to read in full. Upload a shorter job description or paste its text.");
  if (converted.text.length < 80) throw new DocumentReadError("That PDF has too little readable job description text. Upload a text PDF or paste its text.");
  const labelledTitle = converted.text.match(/^\s*(?:role|job title|position)\s*:\s*([^\n\r]+)/im)?.[1]
    ?.split(/\s{2,}|\s+(?=(?:investors|location|reports to)\s*:)/i)[0]?.trim().slice(0, 200) || null;
  const labelledCompany = converted.text.match(/^\s*(?:company|employer|organisation)\s*:\s*([^\n\r]+)/im)?.[1]
    ?.split(/\s{2,}|\s+(?=(?:role|location|investors)\s*:)/i)[0]?.trim().slice(0, 200) || null;
  return { title: labelledTitle, companyName: labelledCompany, location: null,
    descriptionText: converted.text, truncated: false };
}

export async function handleImportRoleDescription(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, importId } = task.payload as TaskPayloads["import_role_description"];
  const [row] = await deps.db.select().from(schema.roleImports)
    .where(and(eq(schema.roleImports.id, importId), eq(schema.roleImports.userId, userId))).limit(1);
  if (!row || row.status !== "queued") return { skipped: "import no longer queued" };

  let result: ReadResult | null = null;
  let error: string | null = null;
  try {
    if (row.kind === "link" && row.url) result = await readLink(row.url, deps);
    else if (row.kind === "pdf" && row.sourceBytes) result = await readPdf(row.sourceBytes);
    else error = "The original link or PDF is missing. Add it again.";
  } catch (cause) {
    error = readableError(cause);
  }

  // The queue lease and row state are checked inside one transaction. A reclaimed worker cannot
  // overwrite a retry or a role the person has already confirmed.
  const published = await deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as Db);
    const [updated] = await tx.update(schema.roleImports).set(result ? {
      status: "ready", title: result.title, companyName: result.companyName,
      location: result.location, descriptionText: result.descriptionText,
      truncated: result.truncated, error: null, sourceBytes: null, updatedAt: deps.now(),
    } : {
      status: "failed", error: error ?? "The description could not be read.", updatedAt: deps.now(),
    }).where(and(eq(schema.roleImports.id, importId), eq(schema.roleImports.userId, userId),
      eq(schema.roleImports.status, "queued"))).returning({ id: schema.roleImports.id });
    return !!updated;
  });
  return published ? { ready: !!result, error } : { skipped: "import changed before publication" };
}
