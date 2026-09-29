(() => {
  if (window.__avaTextZoomState) {
    for (const [element, value, priority] of window.__avaTextZoomState) {
      if (value) element.style.setProperty("font-size", value, priority);
      else element.style.removeProperty("font-size");
    }
  }
  const elements = [document.documentElement, document.body, ...document.body.querySelectorAll("*")]
    .filter(element => !element.closest("svg, [data-nextjs-dialog]"));
  const sizes = elements.map(element => [element, Number.parseFloat(getComputedStyle(element).fontSize),
    element.style.getPropertyValue("font-size"), element.style.getPropertyPriority("font-size")]);
  window.__avaTextZoomState = sizes.map(([element, , value, priority]) => [element, value, priority]);
  for (const [element, size] of sizes) {
    if (Number.isFinite(size)) element.style.setProperty("font-size", `${size * 2}px`, "important");
  }
  const main = document.querySelector("main");
  const heading = main?.querySelector("h1");
  return JSON.stringify({ method: "computed font sizes doubled once after page load", elements: sizes.length,
    viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    h1FontSize: heading ? getComputedStyle(heading).fontSize : null });
})()
