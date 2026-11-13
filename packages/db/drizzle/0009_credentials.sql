CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"exam_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"passed" integer NOT NULL,
	"checks" integer NOT NULL,
	"baseline" integer NOT NULL,
	"model" text NOT NULL,
	"certified" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_exam_uq" ON "agent_credentials" USING btree ("agent_id","exam_id");