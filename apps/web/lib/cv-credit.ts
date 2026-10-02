import { getBillingSummary } from "@/lib/billing/service";

export interface CvCreditOffer {
  line: string;
  refusal: string | null;
}

/** A CV has a fixed product price regardless of advert length or provider token use. */
export async function cvCreditOffer(userId: string): Promise<CvCreditOffer> {
  const { cv } = await getBillingSummary(userId);
  return {
    line: `Uses 1 CV credit · ${cv.available} ${cv.available === 1 ? "credit" : "credits"} available`,
    refusal: cv.available > 0 ? null : "You have no CV credits available.",
  };
}
