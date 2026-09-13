import { z } from "zod";
import { zUuid } from "./validation";

export const CvSelectionSchema = z.object({
  ids: z.array(zUuid()).min(1).max(50),
  action: z.enum(["archive", "restore", "delete"]),
});
