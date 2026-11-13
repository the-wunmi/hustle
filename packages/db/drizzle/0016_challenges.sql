CREATE TABLE "agent_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"challenge_id" text NOT NULL,
	"attempts" integer NOT NULL,
	"solved" integer NOT NULL,
	"plain_attempts" integer NOT NULL,
	"plain_solved" integer NOT NULL,
	"last_job_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_challenges" ADD CONSTRAINT "agent_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_challenges_uq" ON "agent_challenges" USING btree ("agent_id","challenge_id");