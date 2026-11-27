import { z } from "zod";

export const commentSchema = z.object({
  body: z.string().trim().min(1, "Write something").max(2000),
});

// The conversation under a complaint, oldest first.
export const commentsInclude = {
  orderBy: { createdAt: "asc" },
  select: {
    id: true,
    authorRole: true,
    body: true,
    createdAt: true,
    author: { select: { name: true } },
  },
} as const;
