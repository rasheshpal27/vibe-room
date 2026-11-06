CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"user_name" text DEFAULT 'Guest' NOT NULL,
	"user_color" text DEFAULT '#a78bfa' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"is_open" boolean DEFAULT true NOT NULL,
	"current_queue_id" integer,
	"video_id" text,
	"title" text,
	"artist" text,
	"thumbnail" text,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"is_playing" boolean DEFAULT false NOT NULL,
	"position_sec" real DEFAULT 0 NOT NULL,
	"started_by_name" text DEFAULT '',
	"play_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"title" text NOT NULL,
	"artist" text DEFAULT '' NOT NULL,
	"thumbnail" text DEFAULT '' NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"added_by_id" uuid,
	"added_by_name" text DEFAULT 'Guest' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"color" text DEFAULT '#a78bfa' NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
