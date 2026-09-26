"use client";
/**
 * The CV page's occasional widgets, each in a chunk of its own rather than in the page's first
 * load: the gap quiz (only while a build is waiting for answers), the share-link form (only once a
 * revision is ready and assessed) and the evaluation table (in the Evaluation tab). A CV page that
 * shows none of them never downloads them.
 *
 * They still render on the server, so the HTML is complete and nothing moves when they hydrate: the
 * chunk of one that is on the page is fetched with the page.
 *
 * No `loading` fallback, deliberately. With one, `next/dynamic` wraps each widget in a Suspense
 * boundary of its own, and a boundary that mounts during a navigation or a refresh shows its
 * fallback even inside a transition: arriving at a CV page from another page, or the refresh that
 * brings the gap quiz in, would flash a spinner where the widget goes and then swap it in. Without
 * one there is no boundary here, so a widget whose chunk is still on its way holds the transition
 * instead, and the page appears (or updates) with the widget already in place, as it did before the
 * split. Nothing mounts these outside a transition: the CV tabs hide panels rather than unmount them.
 *
 * `next/dynamic` has to be called in a client module for a client component to be split, which is
 * why these live here and the server components import them from this file.
 */
import dynamic from "next/dynamic";

export const CvGapQuiz = dynamic(() => import("./CvGapQuiz").then((module) => module.CvGapQuiz));
export const CvShareCreateForm = dynamic(() => import("./CvShareCreateForm").then((module) => module.CvShareCreateForm));
export const CvEvaluationTable = dynamic(() => import("./CvEvaluationTable").then((module) => module.CvEvaluationTable));
