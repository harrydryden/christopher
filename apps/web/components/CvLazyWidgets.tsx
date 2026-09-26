"use client";
/**
 * The CV page's occasional widgets, each in a chunk of its own rather than in the page's first
 * load: the gap quiz (only while a build is waiting for answers), the share-link form (only once a
 * revision is ready and assessed) and the evaluation table (in the Evaluation tab). A CV page that
 * shows none of them never downloads them.
 *
 * They still render on the server, so the HTML is complete and nothing moves when they hydrate: the
 * chunk of one that is on the page is fetched with the page. The fallback shows only where one
 * mounts in the browser before its chunk has arrived, and it is the product's one loading
 * indicator, the monogram turning at 16px, as for a description loading.
 *
 * `next/dynamic` has to be called in a client module for a client component to be split, which is
 * why these live here and the server components import them from this file.
 */
import dynamic from "next/dynamic";
import { Monogram } from "@/components/brand";

function Loading() {
  return (
    <span role="status" aria-live="polite" className="inline-flex text-muted">
      <Monogram size={16} searching title="Loading" />
    </span>
  );
}

export const CvGapQuiz = dynamic(() => import("./CvGapQuiz").then((module) => module.CvGapQuiz), { loading: Loading });
export const CvShareCreateForm = dynamic(() => import("./CvShareCreateForm").then((module) => module.CvShareCreateForm), { loading: Loading });
export const CvEvaluationTable = dynamic(() => import("./CvEvaluationTable").then((module) => module.CvEvaluationTable), { loading: Loading });
