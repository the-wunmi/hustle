ALTER TABLE "agent_sales" ADD COLUMN "royalty" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "creator_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_creator_id_players_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "agents" SET "creator_id" = COALESCE(
  (SELECT s."seller_id" FROM "agent_sales" s WHERE s."agent_id" = "agents"."id" ORDER BY s."created_at" LIMIT 1),
  "owner_id"
) WHERE "creator_id" IS NULL;
