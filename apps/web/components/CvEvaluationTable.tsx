"use client";
import { useState } from "react";
import type { CvChange, CvEvaluationRow } from "@/lib/cv-evaluation";
// Repeated rather than imported: the lib module this type comes from is server-side, and a
// client bundle should not pull it in for a list of labels.
const CV_CHANGE_TYPES: readonly CvChange[] = [
  "None",
  "Fact",
  "Gap",
  "Improvement",
  "Uncertain",
  "Comment",
];
import { CvContentBlockLink } from "./CvWorkspace";
import { CvDisclosure } from "./CvDisclosure";

const colours = {
  Red: "border-danger text-danger",
  Amber: "border-warn text-warn",
  // A reader's note is information, not a finding against the CV.
  Blue: "border-info text-info",
};
const strengths = { None: 0, Weak: 1, Good: 2, Strong: 3 };
/** A reader's note rates nothing, so the two strength columns say so instead of reading as a gap. */
function NotRated() {
  return <span className="text-12 text-muted">Not rated</span>;
}
function Strength({ value }: { value: keyof typeof strengths }) {
  return (
    <div className="whitespace-nowrap text-12 font-semibold">
      {value}
      <span aria-hidden="true" className="mt-2 flex gap-1">
        {[1, 2, 3].map((level) => (
          <span
            key={level}
            className={`h-1.5 w-4 ${level <= strengths[value] ? "bg-accent" : "bg-track"}`}
          />
        ))}
      </span>
    </div>
  );
}
export function CvEvaluationTable({ rows }: { rows: CvEvaluationRow[] }) {
  const [filter, setFilter] = useState<CvChange | "All">("All");
  const [visible, setVisible] = useState(true);
  const shown = rows
    .map((row, index) => ({ ...row, number: index + 1 }))
    .filter((row) => filter === "All" || row.change === filter);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Filter evaluation by change"
          className="flex flex-wrap gap-1"
        >
          {(["All", ...CV_CHANGE_TYPES] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setVisible(true);
              }}
              className={`ds-pixel border-2 px-2.5 py-1.5 text-10 ${filter === value ? "border-accent bg-accent text-accent-fg" : "border-line-muted bg-raised text-muted hover:bg-sunken"}`}
            >
              {value}{" "}
              <span className="opacity-75">
                {value === "All"
                  ? rows.length
                  : rows.filter((row) => row.change === value).length}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-expanded={visible}
          aria-controls="cv-evaluation-table"
          onClick={() => setVisible((value) => !value)}
          className="border border-line-muted px-3 py-1.5 text-12 font-medium text-fg"
        >
          {visible ? "Hide" : "Show"} evaluation table
        </button>
      </div>
      <div id="cv-evaluation-table" hidden={!visible}>
        <div
          role="region"
          aria-label="CV evaluation table"
          tabIndex={0}
          className="max-h-[70vh] overflow-auto border border-line-muted"
        >
          <table className="w-full min-w-[800px] table-fixed text-left text-14">
            <caption className="sr-only">
              Requirements, evidence gaps and factual review for the saved CV.
              Current CV wording is italicised.
            </caption>
            <colgroup>
              <col style={{ width: "2.75rem" }} />
              <col />
              <col />
              <col style={{ width: "6.25rem" }} />
              <col />
              <col style={{ width: "4.75rem" }} />
              <col style={{ width: "5.5rem" }} />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-sunken text-12 text-muted">
              <tr>
                {[
                  "Item",
                  "Requirement",
                  "Current text",
                  "Change",
                  "Guidance",
                  "Evidence",
                  "Experience",
                ].map((label) => (
                  <th
                    key={label}
                    scope="col"
                    className="whitespace-nowrap px-2 py-3 font-semibold"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-muted">
              {shown.map((row) => (
                <tr key={row.id} className="align-top even:bg-sunken">
                  <td className="px-2 py-4 text-12 text-muted">
                    {row.number}
                  </td>
                  <th scope="row" className="break-words px-2 py-4 font-medium">
                    {row.requirement}
                    {row.importance && (
                      <span className="mt-2 block text-12 font-normal capitalize text-muted">
                        {row.importance}
                      </span>
                    )}
                  </th>
                  <td className="space-y-2 break-words px-2 py-4 text-muted">
                    {row.currentText.length ? (
                      row.currentText.map((text, index) => (
                        <p key={index}>
                          <em>{text}</em>
                        </p>
                      ))
                    ) : (
                      <span className="text-12 text-muted">
                        No cited CV text
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-4">
                    <span
                      className={`inline-flex items-center justify-center border px-1.5 py-1 text-center text-11 font-medium ${row.change === "Fact" ? colours.Red : row.change === "Uncertain" ? colours.Amber : row.change === "Comment" ? colours.Blue : "border-line-muted bg-raised text-fg"}`}
                    >
                      {row.change}
                    </span>
                  </td>
                  <td className="space-y-3 break-words px-2 py-4">
                    <p>{row.suggestion}</p>
                    <div className="space-y-1">
                      {row.contentLinks.length ? (
                        row.contentLinks.map((link) => (
                          <CvContentBlockLink key={link.id} id={link.id}>
                            Edit {link.label}
                          </CvContentBlockLink>
                        ))
                      ) : (
                        <CvContentBlockLink>Open Content</CvContentBlockLink>
                      )}
                      {/* The way out of a gap: the Library, with this need quoted and the job it
                          belongs to opened. Ordinary navigation, in this tab. */}
                      {row.libraryHref && (
                        <a
                          href={row.libraryHref}
                          className="block text-12 font-medium text-fg underline underline-offset-2"
                        >
                          Add evidence for this
                        </a>
                      )}
                    </div>
                    <CvDisclosure label={`evidence for item ${row.number}`}>
                      {!row.suggestion.includes(row.reason) && (
                        <p className="text-12 text-muted">{row.reason}</p>
                      )}
                      {row.companyText && (
                        <p className="text-12 text-muted">
                          <strong>Company requirement:</strong>{" "}
                          {row.companyText}
                        </p>
                      )}
                      {row.sources.map((source, index) => (
                        <p key={index} className="text-12 text-muted">
                          <strong>{row.change === "Comment" ? "Also said:" : "Saved evidence:"}</strong>{" "}
                          {source}
                        </p>
                      ))}
                    </CvDisclosure>
                  </td>
                  <td className="px-2 py-4">
                    {row.change === "Comment" ? <NotRated /> : <Strength value={row.evidence} />}
                  </td>
                  <td className="px-2 py-4">
                    {row.change === "Comment" ? <NotRated /> : <Strength value={row.experience} />}
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted">
                    No {filter.toLowerCase()} items in this revision.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
