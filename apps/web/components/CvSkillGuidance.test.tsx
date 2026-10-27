import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CvSkillGuidance } from "./CvSkillGuidance";
import { CvLibrarySkillGuidance } from "./CvLibrarySkillGuidance";

const render = (context: "library" | "cv", labels: string[]) => renderToStaticMarkup(createElement(CvSkillGuidance, { context, labels }));

it("lets the Library hold a broader set without calling it excessive", () => {
  const html = renderToStaticMarkup(createElement(CvLibrarySkillGuidance, { count: 12 }));
  expect(html).toContain("12 saved skills");
  expect(html).toContain("Keep a broad collection here");
  expect(html).not.toContain("too many");
  expect(html).not.toContain("maximum");
});

it("counts a balanced ten across categories and treats eleven as soft guidance", () => {
  const leadership = ["A", "B", "C", "D"];
  const delivery = ["E", "F", "G"];
  const tools = ["H", "I", "J"];
  const ten = [...leadership, ...delivery, ...tools];
  expect(render("cv", [...ten, " a "])).toContain("10 highlighted skills");
  const eleven = render("cv", [...ten, "K"]);
  expect(eleven).toContain("11 highlighted skills");
  expect(eleven).toContain("Aim for about 10");
  expect(eleven).toContain("use fewer or more");
  expect(eleven).not.toContain("maximum");
});
