"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { CvRefineMode } from "./CvRefineMode";
import type { CvManualMode } from "./CvManualMode";

/** A mode is fetched when first visited; CvContextModes keeps its mounted editor thereafter. */
export const CvRefineModeLazy = dynamic<ComponentProps<typeof CvRefineMode>>(
  () => import("./CvRefineMode").then(module => module.CvRefineMode),
  { loading: () => <p role="status" className="text-14 text-muted">Loading Refine controls…</p> });
export const CvManualModeLazy = dynamic<ComponentProps<typeof CvManualMode>>(
  () => import("./CvManualMode").then(module => module.CvManualMode),
  { loading: () => <p role="status" className="text-14 text-muted">Loading Manual editor…</p> });
