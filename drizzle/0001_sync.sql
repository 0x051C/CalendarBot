CREATE TABLE "sync_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_guild_id" text NOT NULL,
	"source_guild_id" text NOT NULL,
	"source_event_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_links_unique" UNIQUE NULLS NOT DISTINCT("target_guild_id","source_guild_id","source_event_id")
);
--> statement-breakpoint
CREATE TABLE "sync_mirrors" (
	"target_guild_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"target_event_id" text,
	"status" text NOT NULL,
	"source_sequence" integer DEFAULT -1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_mirrors_target_guild_id_source_event_id_pk" PRIMARY KEY("target_guild_id","source_event_id"),
	CONSTRAINT "sync_mirrors_target_event_id_unique" UNIQUE("target_event_id")
);
--> statement-breakpoint
ALTER TABLE "sync_links" ADD CONSTRAINT "sync_links_target_guild_id_guilds_id_fk" FOREIGN KEY ("target_guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_mirrors" ADD CONSTRAINT "sync_mirrors_target_guild_id_guilds_id_fk" FOREIGN KEY ("target_guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_links_source_idx" ON "sync_links" USING btree ("source_guild_id");