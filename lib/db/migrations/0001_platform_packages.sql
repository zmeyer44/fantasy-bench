CREATE TABLE "league_rule_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"user_id" text,
	"field" text NOT NULL,
	"from_value" jsonb,
	"to_value" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auction_bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nomination_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"run_id" uuid,
	"window_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auction_nominations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"lot_no" integer NOT NULL,
	"nominating_team_id" uuid NOT NULL,
	"player_id" uuid,
	"opening_bid" integer DEFAULT 1 NOT NULL,
	"window_id" uuid,
	"run_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"winning_team_id" uuid,
	"winning_bid" integer,
	"tiebreak" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"pick_no" integer NOT NULL,
	"overall_no" integer NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" uuid,
	"price" integer,
	"made_by_run_id" uuid,
	"window_id" uuid,
	"auto" boolean DEFAULT false NOT NULL,
	"rationale" text,
	"made_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_versions" ALTER COLUMN "harness" SET DEFAULT '{"maxSteps":12,"tokenBudget":60000,"temperature":0.3,"reasoningEffort":null,"deliberateMode":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "snapshots" ALTER COLUMN "digest" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "snapshots" ALTER COLUMN "payload" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "league_rules" ADD COLUMN "run_wallclock_seconds" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "league_rules" ADD COLUMN "draft_pick_seconds" integer DEFAULT 240 NOT NULL;--> statement-breakpoint
ALTER TABLE "league_rules" ADD COLUMN "reuse_snapshot_within_ms" integer DEFAULT 600000 NOT NULL;--> statement-breakpoint
ALTER TABLE "league_rules" ADD COLUMN "draft_budget" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "join_code" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "draft_budget_remaining" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "nfl_games" ADD COLUMN "espn_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "forked_from_skill_id" uuid;--> statement-breakpoint
ALTER TABLE "run_actions" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "prompt_sections" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "messages" jsonb;--> statement-breakpoint
ALTER TABLE "budget_rollups" ADD COLUMN "cap_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "computed_cost_usd" numeric(14, 8) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "league_rule_changes" ADD CONSTRAINT "league_rule_changes_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_rule_changes" ADD CONSTRAINT "league_rule_changes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_nomination_id_auction_nominations_id_fk" FOREIGN KEY ("nomination_id") REFERENCES "public"."auction_nominations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_window_id_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."windows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_nominations" ADD CONSTRAINT "auction_nominations_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_nominations" ADD CONSTRAINT "auction_nominations_nominating_team_id_teams_id_fk" FOREIGN KEY ("nominating_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_nominations" ADD CONSTRAINT "auction_nominations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_nominations" ADD CONSTRAINT "auction_nominations_window_id_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."windows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_nominations" ADD CONSTRAINT "auction_nominations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_nominations" ADD CONSTRAINT "auction_nominations_winning_team_id_teams_id_fk" FOREIGN KEY ("winning_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_made_by_run_id_runs_id_fk" FOREIGN KEY ("made_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_window_id_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."windows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "league_rule_changes_league_created_idx" ON "league_rule_changes" USING btree ("league_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "auction_bids_nomination_team_unique" ON "auction_bids" USING btree ("nomination_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auction_nominations_league_lot_unique" ON "auction_nominations" USING btree ("league_id","lot_no");--> statement-breakpoint
CREATE INDEX "auction_nominations_league_status_idx" ON "auction_nominations" USING btree ("league_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_picks_league_overall_unique" ON "draft_picks" USING btree ("league_id","overall_no");--> statement-breakpoint
CREATE INDEX "draft_picks_league_team_idx" ON "draft_picks" USING btree ("league_id","team_id");--> statement-breakpoint
CREATE INDEX "draft_picks_player_idx" ON "draft_picks" USING btree ("player_id");--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_forked_from_skill_id_skills_id_fk" FOREIGN KEY ("forked_from_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skills_author_idx" ON "skills" USING btree ("author_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "windows_league_label_week_round_unique" ON "windows" USING btree ("league_id","label","week_no","round_no");--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_join_code_unique" UNIQUE("join_code");