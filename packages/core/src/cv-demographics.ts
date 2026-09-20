/** Attributes a recruitment judgement may never rest on, however a page or model phrases it. */
const DEMOGRAPHIC_ATTRIBUTES = /\b(gender|ethnicity|race|religion|marital status|sexual orientation|date of birth)\b/i;
export function mentionsDemographicAttribute(text: string): boolean {
  return DEMOGRAPHIC_ATTRIBUTES.test(text);
}
