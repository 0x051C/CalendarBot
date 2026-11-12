CREATE TABLE "alert_deliveries" (
	"event_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"claimed_by" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"channel_id" text,
	"message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	CONSTRAINT "alert_deliveries_event_id_starts_at_pk" PRIMARY KEY("event_id","starts_at")
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"alert_lead_minutes" integer NOT NULL,
	"alert_channel_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rsvps" (
	"event_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rsvps_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_events" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"location" text,
	"url" text NOT NULL,
	"creator_id" text,
	"channel_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"status" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_event_id_scheduled_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."scheduled_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_event_id_scheduled_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."scheduled_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_events" ADD CONSTRAINT "scheduled_events_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_events_guild_idx" ON "scheduled_events" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "scheduled_events_starts_idx" ON "scheduled_events" USING btree ("starts_at");