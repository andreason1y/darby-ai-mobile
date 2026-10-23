CREATE TYPE "public"."firm_type" AS ENUM('law_firm', 'in_house', 'lbh', 'solo');--> statement-breakpoint
CREATE TYPE "public"."legal_role" AS ENUM('managing_partner', 'partner', 'senior_associate', 'associate', 'paralegal', 'of_counsel');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'invited', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."matter_case_type" AS ENUM('litigation', 'corporate_transaction', 'contract_review', 'general_advisory');--> statement-breakpoint
CREATE TYPE "public"."matter_status" AS ENUM('open', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."matter_access_level" AS ENUM('lead', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "firms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"firm_type" "firm_type" NOT NULL,
	"domain" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "firm_memberships" (
	"firm_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "legal_role" NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_memberships_firm_id_user_id_pk" PRIMARY KEY("firm_id","user_id"),
	CONSTRAINT "firm_memberships_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "firm_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "matters" (
	"id" text PRIMARY KEY NOT NULL,
	"firm_id" text NOT NULL,
	"channel_id" text,
	"title" text NOT NULL,
	"case_number" text,
	"client_name" text,
	"case_type" "matter_case_type" NOT NULL,
	"status" "matter_status" DEFAULT 'open' NOT NULL,
	"lead_partner_id" text,
	"workspace_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matters_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "matters_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "matters_lead_partner_id_users_id_fk" FOREIGN KEY ("lead_partner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "matter_memberships" (
	"matter_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_level" "matter_access_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matter_memberships_matter_id_user_id_pk" PRIMARY KEY("matter_id","user_id"),
	CONSTRAINT "matter_memberships_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "matter_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "firm_playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"firm_id" text NOT NULL,
	"title" text NOT NULL,
	"playbook_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_playbooks_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "firm_playbooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "firm_memberships_user_idx" ON "firm_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "firm_memberships_firm_status_idx" ON "firm_memberships" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "matters_firm_status_idx" ON "matters" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "matters_channel_idx" ON "matters" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "matters_lead_partner_idx" ON "matters" USING btree ("lead_partner_id");--> statement-breakpoint
CREATE INDEX "matters_firm_case_number_idx" ON "matters" USING btree ("firm_id","case_number");--> statement-breakpoint
CREATE INDEX "matter_memberships_user_idx" ON "matter_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "firm_playbooks_firm_idx" ON "firm_playbooks" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "firm_playbooks_created_by_idx" ON "firm_playbooks" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "firm_playbooks_firm_default_idx" ON "firm_playbooks" USING btree ("firm_id","is_default");
