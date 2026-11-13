ALTER TABLE "jobs" ADD COLUMN "subcontracting" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "parent_job_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "parent_step" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_parent_step_uq" ON "jobs" USING btree ("parent_job_id","parent_step");