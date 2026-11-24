export * from "../schema.js";
export * from "../sqlite-adapter.js";
export * from "../attachments.js";

// Both modules expose the same table with different types. Keep the schema's
// inferred type and give the narrower Drizzle bridge view its own name.
export {
  briefingsTable as drizzleBriefingsTable,
  desc,
  eq,
  openControlPlaneDrizzle,
  sql,
  type ControlPlaneBriefingRow,
  type ControlPlaneBriefingsTable,
  type ControlPlaneDrizzleDatabase,
  type ControlPlaneDrizzleOperator,
  type ControlPlaneDrizzlePredicate,
  type ControlPlaneDrizzleSqlTag,
} from "../drizzle.js";
