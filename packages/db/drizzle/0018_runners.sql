CREATE TABLE "runner_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"command" text NOT NULL,
	"status" text NOT NULL,
	"exit_code" integer,
	"output" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"token_hash" text,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"machine" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "local_ok" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_tasks" ADD CONSTRAINT "runner_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_owner_id_players_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_tasks_step_uq" ON "runner_tasks" USING btree ("job_id","n");--> statement-breakpoint
CREATE INDEX "runner_tasks_agent_ix" ON "runner_tasks" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_agent_uq" ON "runners" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_token_uq" ON "runners" USING btree ("token_hash");