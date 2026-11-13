CREATE TABLE "job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"action" text NOT NULL,
	"args" text DEFAULT '' NOT NULL,
	"thought" text DEFAULT '' NOT NULL,
	"input" text DEFAULT '' NOT NULL,
	"observation" text DEFAULT '' NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"tick" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_steps_n_uq" ON "job_steps" USING btree ("job_id","agent_id","n");