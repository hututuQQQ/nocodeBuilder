import { describe, expect, it } from "vitest";
import { compileTaskContract, validateTaskContract } from "./taskContract";

describe("TaskContract", () => {
  it("infers task type and bounded budgets", () => {
    const contract = compileTaskContract({
      objective: "Update the homepage hero color",
      selectedSiteNodeId: "home.hero",
    });

    expect(contract.taskType).toBe("style_edit");
    expect(contract.scope.componentIds).toEqual(["home.hero"]);
    expect(contract.budget.maxModelTurns).toBeGreaterThan(1);
    expect(contract.budget.maxModelTurns).toBeLessThan(20);
  });

  it("requires production deployment approval", () => {
    const contract = compileTaskContract({ objective: "Deploy to production" });

    expect(contract.taskType).toBe("deployment");
    expect(contract.permissions.productionDeployment).toBe("ask");
    expect(() =>
      validateTaskContract({
        ...contract,
        permissions: {
          ...contract.permissions,
          productionDeployment: "deny" as "ask",
        },
      }),
    ).toThrow(/Production deployment/);
  });

  it("allows dependency changes by default while keeping risky actions guarded", () => {
    const contract = compileTaskContract({ objective: "Build a complete landing page" });

    expect(contract.permissions.dependencyChange).toBe("allow");
    expect(contract.permissions.fileDelete).toBe("ask");
    expect(contract.permissions.databaseChange).toBe("deny");
    expect(contract.permissions.productionDeployment).toBe("ask");
  });
});
