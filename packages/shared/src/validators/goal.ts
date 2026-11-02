import { z } from "zod";
import { GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";

const goalFields = {
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  level: z.enum(GOAL_LEVELS).optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  parentId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
};

export const createGoalSchema = z.object({
  ...goalFields,
  level: z.enum(GOAL_LEVELS).optional().default("task"),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = z.object(goalFields).partial();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;
