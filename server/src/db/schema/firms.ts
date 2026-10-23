import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { channels, users } from "./core";
import { jsonb } from "./json";

export const firmType = pgEnum("firm_type", [
  "law_firm",
  "in_house",
  "lbh",
  "solo",
]);

export const legalRole = pgEnum("legal_role", [
  "managing_partner",
  "partner",
  "senior_associate",
  "associate",
  "paralegal",
  "of_counsel",
]);

export const membershipStatus = pgEnum("membership_status", [
  "active",
  "invited",
  "suspended",
]);

export const matterCaseType = pgEnum("matter_case_type", [
  "litigation",
  "corporate_transaction",
  "contract_review",
  "general_advisory",
]);

export const matterStatus = pgEnum("matter_status", [
  "open",
  "active",
  "closed",
]);

export const matterAccessLevel = pgEnum("matter_access_level", [
  "lead",
  "editor",
  "viewer",
]);

export type FirmType = (typeof firmType.enumValues)[number];
export type LegalRole = (typeof legalRole.enumValues)[number];
export type MembershipStatus = (typeof membershipStatus.enumValues)[number];
export type MatterCaseType = (typeof matterCaseType.enumValues)[number];
export type MatterStatus = (typeof matterStatus.enumValues)[number];
export type MatterAccessLevel = (typeof matterAccessLevel.enumValues)[number];

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const firms = pgTable("firms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  firmType: firmType("firm_type").notNull(),
  domain: text("domain"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const firmMemberships = pgTable(
  "firm_memberships",
  {
    firmId: text("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: legalRole("role").notNull(),
    status: membershipStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.firmId, table.userId] }),
    index("firm_memberships_user_idx").on(table.userId),
    index("firm_memberships_firm_status_idx").on(table.firmId, table.status),
  ],
);

export const matters = pgTable(
  "matters",
  {
    id: text("id").primaryKey(),
    firmId: text("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    caseNumber: text("case_number"),
    clientName: text("client_name"),
    caseType: matterCaseType("case_type").notNull(),
    status: matterStatus("status").notNull().default("open"),
    leadPartnerId: text("lead_partner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    workspacePath: text("workspace_path"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("matters_firm_status_idx").on(table.firmId, table.status),
    index("matters_channel_idx").on(table.channelId),
    index("matters_lead_partner_idx").on(table.leadPartnerId),
    index("matters_firm_case_number_idx").on(table.firmId, table.caseNumber),
  ],
);

export const matterMemberships = pgTable(
  "matter_memberships",
  {
    matterId: text("matter_id")
      .notNull()
      .references(() => matters.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessLevel: matterAccessLevel("access_level").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.matterId, table.userId] }),
    index("matter_memberships_user_idx").on(table.userId),
  ],
);

export const firmPlaybooks = pgTable(
  "firm_playbooks",
  {
    id: text("id").primaryKey(),
    firmId: text("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    playbookJson: jsonb("playbook_json").notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("firm_playbooks_firm_idx").on(table.firmId),
    index("firm_playbooks_created_by_idx").on(table.createdBy),
    index("firm_playbooks_firm_default_idx").on(table.firmId, table.isDefault),
  ],
);
