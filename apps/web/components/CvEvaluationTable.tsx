"use client";
import { useState } from "react";
import type { CvChange, CvEvaluationRow } from "@/lib/cv-evaluation";
const CV_CHANGE_TYPES: readonly CvChange[] = [
  "None",
  "Fact",
  "Gap",
  "Improvement",
  "Uncertain",
];
import { CvContentBlockLink } from "./CvWorkspace";
import { CvDisclosure } from "./CvDisclosure";

const colours = {
  Red: "border-red-200 bg-red-50 text-red-800",
  Amber: "border-amber-200 bg-amber-50 text-amber-900",
};
const strengths = { None: 0, Weak: 1, Good: 2, Strong: 3 };
function Strength({ value }: { value: keyof typeof strengths }) {
  return (
    <div className="whitespace-nowrap text-xs font-semibold">
      {value}
      <span aria-hidden="true" className="mt-2 flex gap-1">
        {[1, 2, 3].map((level) => (
          <span
            key={level}
            className={`h-1.5 w-4 rounded-full ${level <= strengths[value] ? "bg-accent" : "bg-slate-200"}`}
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
              className={`rounded-md border px-2.5 py-1.5 text-xs font-medium ${filter === value ? "border-accent bg-accent text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
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
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-accent"
        >
          {visible ? "Hide" : "Show"} evaluation table
        </button>
      </div>
      <div id="cv-evaluation-table" hidden={!visible}>
        <div
          role="region"
          aria-label="CV evaluation table"
          tabIndex={0}
          className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200"
        >
          <table className="w-full min-w-[800px] table-fixed text-left text-sm">
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
            <thead className="sticky top-0 z-10 bg-slate-100 text-xs text-slate-600">
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
            <tbody className="divide-y divide-slate-200">
              {shown.map((row) => (
                <tr key={row.id} className="align-top even:bg-slate-50/60">
                  <td className="px-2 py-4 text-xs text-slate-500">
                    {row.number}
                  </td>
                  <th scope="row" className="break-words px-2 py-4 font-medium">
                    {row.requirement}
                    {row.importance && (
                      <span className="mt-2 block text-xs font-normal capitalize text-slate-500">
                        {row.importance}
                      </span>
                    )}
                  </th>
                  <td className="space-y-2 break-words px-2 py-4 text-slate-600">
                    {row.currentText.length ? (
                      row.currentText.map((text, index) => (
                        <p key={index}>
                          <em>{text}</em>
                        </p>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">
                        No cited CV text
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-4">
                    <span
                      className={`inline-flex items-center justify-center rounded-md border px-1.5 py-1 text-center text-[11px] font-medium ${row.change === "Fact" ? colours.Red : row.change === "Uncertain" ? colours.Amber : "border-slate-200 bg-white text-slate-700"}`}
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
                    </div>
                    <CvDisclosure label={`evidence for item ${row.number}`}>
                      {!row.suggestion.includes(row.reason) && (
                        <p className="text-xs text-slate-600">{row.reason}</p>
                      )}
                      {row.companyText && (
                        <p className="text-xs text-slate-600">
                          <strong>Company requirement:</strong>{" "}
                          {row.companyText}
                        </p>
                      )}
                      {row.sources.map((source, index) => (
                        <p key={index} className="text-xs text-slate-600">
                          <strong>Saved evidence:</strong> {source}
                        </p>
                      ))}
                    </CvDisclosure>
                  </td>
                  <td className="px-2 py-4">
                    <Strength value={row.evidence} />
                  </td>
                  <td className="px-2 py-4">
                    <Strength value={row.experience} />
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500">
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
