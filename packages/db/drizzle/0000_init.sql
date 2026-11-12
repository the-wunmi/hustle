CREATE TABLE "agent_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"price" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"day" integer NOT NULL,
	"request_id" text NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"look" jsonb NOT NULL,
	"traits" jsonb NOT NULL,
	"specialty" text NOT NULL,
	"skills" jsonb NOT NULL,
	"strategy" jsonb NOT NULL,
	"rulebook" jsonb NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"rep_xp" integer DEFAULT 0 NOT NULL,
	"rating_sum" integer DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"disputes" integer DEFAULT 0 NOT NULL,
	"scams_blocked" integer DEFAULT 0 NOT NULL,
	"practice_done" integer DEFAULT 0 NOT NULL,
	"dormant_since_day" integer,
	"busy_job_id" uuid,
	"inference_key_id" text,
	"inference_key_sealed" text,
	"achievements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_paid_tick" integer,
	"streak" integer DEFAULT 0 NOT NULL,
	"best_streak" integer DEFAULT 0 NOT NULL,
	"next_call_tick" integer DEFAULT 0 NOT NULL,
	"next_contract_tick" integer DEFAULT 0 NOT NULL,
	"awaiting_confirm" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"backer_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"day" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"price" bigint NOT NULL,
	"pitch" text NOT NULL,
	"status" text NOT NULL,
	"created_tick" integer NOT NULL,
	"score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"job_id" uuid,
	"status" text NOT NULL,
	"card" jsonb NOT NULL,
	"choice" text,
	"outcome" jsonb,
	"opened_tick" integer NOT NULL,
	"expires_tick" integer NOT NULL,
	"resolved_tick" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "day_reports" (
	"day" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_reports_day_agent_id_pk" PRIMARY KEY("day","agent_id")
);
--> statement-breakpoint
CREATE TABLE "feed" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"day" integer NOT NULL,
	"tick" integer NOT NULL,
	"kind" text NOT NULL,
	"tone" text NOT NULL,
	"text" text NOT NULL,
	"agent_id" uuid,
	"job_id" uuid,
	"player_id" uuid,
	"amount" bigint,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"job_id" uuid,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"tier" text NOT NULL,
	"status" text NOT NULL,
	"tick" integer,
	"inference_id" text,
	"chat_id" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_nano" bigint,
	"cost" bigint,
	"request_hash" text,
	"response_hash" text,
	"verification" jsonb,
	"output" jsonb,
	"spend_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_job_id" text,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"budget" bigint NOT NULL,
	"min_level" integer DEFAULT 1 NOT NULL,
	"client_player_id" uuid,
	"client_name" text NOT NULL,
	"client_style" text NOT NULL,
	"sponsor_pool_id" text,
	"scam" boolean DEFAULT false NOT NULL,
	"scam_vendor" text,
	"scam_amount" bigint,
	"answer_keywords" jsonb,
	"reserved_for_agent_id" uuid,
	"auto_award" boolean DEFAULT true NOT NULL,
	"status" text NOT NULL,
	"stage" text,
	"next_at" integer DEFAULT 0 NOT NULL,
	"opened_tick" integer NOT NULL,
	"closes_tick" integer,
	"review_until_tick" integer,
	"awarded_agent_id" uuid,
	"price" bigint,
	"plan" jsonb,
	"deliverable" text,
	"work_hash" text,
	"embedded_instructions" text,
	"quality" double precision,
	"rating" integer,
	"helper_agent_id" uuid,
	"helper_price" bigint,
	"helper_task" text,
	"market_ref" text,
	"specialist" text,
	"rookie" boolean DEFAULT false NOT NULL,
	"contract_tier" integer,
	"bond" bigint,
	"outside_price" bigint,
	"disputed" boolean DEFAULT false NOT NULL,
	"created_day" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"day" integer NOT NULL,
	"agent_id" uuid,
	"player_id" uuid,
	"job_id" uuid,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"related" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"login_method" text NOT NULL,
	"auth_subject" text NOT NULL,
	"account_id" text NOT NULL,
	"is_house" boolean DEFAULT false NOT NULL,
	"allowance_day" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_accounts" (
	"account_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_ft" (
	"account_id" text PRIMARY KEY NOT NULL,
	"balance" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_jobs" (
	"job_id" integer PRIMARY KEY NOT NULL,
	"job_key" text NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_listings" (
	"token_id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"price" bigint NOT NULL,
	"approval_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_nft" (
	"token_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"rotation_seq" integer DEFAULT 0 NOT NULL,
	"approvals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_approval_id" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_reputation" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_txs" (
	"block" bigserial PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"signer" text NOT NULL,
	"receiver" text NOT NULL,
	"method" text NOT NULL,
	"args" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"result" jsonb,
	"events" jsonb NOT NULL,
	"error" text,
	"key" text,
	"signed" text,
	"timestamp_ms" bigint NOT NULL,
	"chain_block" bigint,
	"tick" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_wallets" (
	"account_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"job_id" uuid,
	"kind" text NOT NULL,
	"receiver" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"request_id" integer,
	"memo" text NOT NULL,
	"receipt" text,
	"tx_hash" text,
	"day" integer DEFAULT 0 NOT NULL,
	"tick" integer,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"remaining" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sales" ADD CONSTRAINT "agent_sales_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sales" ADD CONSTRAINT "agent_sales_seller_id_players_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sales" ADD CONSTRAINT "agent_sales_buyer_id_players_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_players_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backings" ADD CONSTRAINT "backings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backings" ADD CONSTRAINT "backings_backer_id_players_id_fk" FOREIGN KEY ("backer_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_reports" ADD CONSTRAINT "day_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_calls" ADD CONSTRAINT "inference_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_client_player_id_players_id_fk" FOREIGN KEY ("client_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spends" ADD CONSTRAINT "spends_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sales_request_uq" ON "agent_sales" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_account_uq" ON "agents" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "agents_owner_ix" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bids_job_agent_uq" ON "bids" USING btree ("job_id","agent_id");--> statement-breakpoint
CREATE INDEX "bids_agent_ix" ON "bids" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "calls_player_ix" ON "calls" USING btree ("player_id","opened_tick");--> statement-breakpoint
CREATE INDEX "calls_job_ix" ON "calls" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_one_open_uq" ON "calls" USING btree ("agent_id") WHERE "calls"."status" = 'open';--> statement-breakpoint
CREATE INDEX "feed_agent_ix" ON "feed" USING btree ("agent_id","seq");--> statement-breakpoint
CREATE INDEX "feed_job_ix" ON "feed" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_key_uq" ON "inference_calls" USING btree ("key");--> statement-breakpoint
CREATE INDEX "inference_job_ix" ON "inference_calls" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_status_ix" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_agent_ix" ON "jobs" USING btree ("awarded_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_chain_uq" ON "jobs" USING btree ("chain_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_ref_uq" ON "ledger" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "ledger_agent_day_ix" ON "ledger" USING btree ("agent_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "players_account_uq" ON "players" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_subject_uq" ON "players" USING btree ("auth_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_jobs_key_uq" ON "sim_jobs" USING btree ("job_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_txs_hash_uq" ON "sim_txs" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "sim_txs_key_ix" ON "sim_txs" USING btree ("key");--> statement-breakpoint
CREATE INDEX "sim_txs_args_job_ix" ON "sim_txs" USING gin ("args" jsonb_path_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "spends_key_uq" ON "spends" USING btree ("key");--> statement-breakpoint
CREATE INDEX "spends_agent_ix" ON "spends" USING btree ("agent_id");