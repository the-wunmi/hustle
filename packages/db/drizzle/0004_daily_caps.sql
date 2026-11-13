CREATE TABLE "daily_caps" (
	"day" text NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_caps_day_kind_pk" PRIMARY KEY("day","kind")
);
