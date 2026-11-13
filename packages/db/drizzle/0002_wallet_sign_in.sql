CREATE TABLE "wallet_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"binding_hash" text NOT NULL,
	"message" text NOT NULL,
	"recipient" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "wallet_account_id" text;