CREATE TABLE "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"category" text NOT NULL,
	"client" text NOT NULL,
	"outcome" text NOT NULL,
	"rating" integer,
	"price" bigint NOT NULL,
	"lesson" text,
	"reflected_at" timestamp with time zone,
	"tick" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "playbook" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "playbook_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "memory_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memories_job_uq" ON "agent_memories" USING btree ("agent_id","job_id");--> statement-breakpoint
CREATE INDEX "agent_memories_agent_ix" ON "agent_memories" USING btree ("agent_id","tick");--> statement-breakpoint
CREATE INDEX "agent_memories_queue_ix" ON "agent_memories" USING btree ("tick") WHERE "agent_memories"."reflected_at" is null;--> statement-breakpoint
CREATE INDEX "inference_agent_ix" ON "inference_calls" USING btree ("agent_id","tick");