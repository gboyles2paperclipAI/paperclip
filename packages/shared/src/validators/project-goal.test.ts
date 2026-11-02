import { describe, expect, it } from "vitest";
import { updateGoalSchema } from "./goal.js";
import { updateProjectSchema } from "./project.js";

describe("project and goal update validators", () => {
  it("does not inject create defaults into sparse project updates", () => {
    expect(updateProjectSchema.parse({ name: "Renamed project" })).toEqual({
      name: "Renamed project",
    });
  });

  it("does not inject create defaults into sparse goal updates", () => {
    expect(updateGoalSchema.parse({ title: "Renamed goal" })).toEqual({
      title: "Renamed goal",
    });
  });
});
