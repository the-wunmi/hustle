CREATE TABLE "nearai_budget" (
	"day" text PRIMARY KEY NOT NULL,
	"spent_nano" bigint DEFAULT 0 NOT NULL,
	"reserved_nano" bigint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"exhausted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inference_calls" ADD COLUMN "reasoning_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_calls" ADD COLUMN "source" text DEFAULT 'recorded' NOT NULL;