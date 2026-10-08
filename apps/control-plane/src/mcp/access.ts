const RUN_CONTROL_ROLES = ["owner", "admin", "member"];

export const canControlRuns = (role: string): boolean => role.split(",").some((r) => RUN_CONTROL_ROLES.includes(r.trim()));

export const RUN_CONTROL_ROLE = "Your role in this workspace does not allow controlling runs, so this connection can read but not start or stop runs.";
