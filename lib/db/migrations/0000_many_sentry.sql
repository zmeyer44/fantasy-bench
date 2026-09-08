CREATE TYPE "public"."draft_type" AS ENUM('snake', 'auction');--> statement-breakpoint
CREATE TYPE "public"."injection_policy" AS ENUM('permitted', 'prohibited');--> statement-breakpoint
CREATE TYPE "public"."league_role" AS ENUM('commissioner', 'owner', 'spectator');--> statement-breakpoint
CREATE TYPE "public"."league_status" AS ENUM('setup', 'drafting', 'in_season', 'complete');--> statement-breakpoint
CREATE TYPE "public"."scoring_preset" AS ENUM('ppr', 'half_ppr', 'standard');--> statement-breakpoint
CREATE TYPE "public"."transparency_mode" AS ENUM('live', 'delayed');--> statement-breakpoint
CREATE TYPE "public"."week_status" AS ENUM('upcoming', 'active', 'complete');--> statement-breakpoint
CREATE TYPE "public"."position" AS ENUM('QB', 'RB', 'WR', 'TE', 'K', 'DEF');--> statement-breakpoint
CREATE TYPE "public"."acquired_via" AS ENUM('draft', 'waiver', 'free_agent', 'trade');--> statement-breakpoint
CREATE TYPE "public"."lineup_source" AS ENUM('agent', 'autopilot', 'carryover', 'draft_default');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('add', 'drop', 'trade', 'draft');--> statement-breakpoint
CREATE TYPE "public"."skill_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('team', 'commissioner');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'succeeded', 'partial', 'failed', 'timed_out', 'fallback', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."window_status" AS ENUM('scheduled', 'open', 'closing', 'closed');--> statement-breakpoint
CREATE TYPE "public"."window_type" AS ENUM('draft', 'waiver', 'trade', 'lineup', 'forum', 'commissioner');--> statement-breakpoint
CREATE TYPE "public"."trade_status" AS ENUM('proposed', 'countered', 'accepted', 'rejected', 'expired', 'in_review', 'vetoed', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."trade_vote" AS ENUM('veto', 'approve');--> statement-breakpoint
CREATE TYPE "public"."waiver_status" AS ENUM('pending', 'won', 'lost', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."forum_flair" AS ENUM('trash_talk', 'trade_block', 'analysis', 'announcement');--> statement-breakpoint
CREATE TYPE "public"."vote_target_type" AS ENUM('post', 'comment');--> statement-breakpoint
CREATE TYPE "public"."budget_period" AS ENUM('week', 'season');--> statement-breakpoint
CREATE TYPE "public"."custom_provider_kind" AS ENUM('http_json');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "league_role" DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"scoring_preset" "scoring_preset" DEFAULT 'ppr' NOT NULL,
	"superflex" boolean DEFAULT false NOT NULL,
	"te_premium" boolean DEFAULT false NOT NULL,
	"roster_slots" jsonb DEFAULT '{"QB":1,"RB":2,"WR":2,"TE":1,"FLEX":1,"K":1,"DEF":1,"BENCH":6}'::jsonb NOT NULL,
	"faab_budget" integer DEFAULT 100 NOT NULL,
	"playoff_teams" integer DEFAULT 6 NOT NULL,
	"playoff_start_week" integer DEFAULT 15 NOT NULL,
	"regular_season_weeks" integer DEFAULT 14 NOT NULL,
	"season_weeks" integer DEFAULT 17 NOT NULL,
	"transparency_mode" "transparency_mode" DEFAULT 'live' NOT NULL,
	"injection_policy" "injection_policy" DEFAULT 'permitted' NOT NULL,
	"model_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fallback_model_id" text,
	"weekly_token_cap_per_team" integer,
	"league_usd_hard_cap" numeric(14, 8),
	"context_char_limit" integer DEFAULT 8000 NOT NULL,
	"max_steps_cap" integer DEFAULT 30 NOT NULL,
	"edit_lock" jsonb DEFAULT '{"unlockDay":"tue","unlockTime":"06:00","lockDay":"wed","lockTime":"03:00"}'::jsonb NOT NULL,
	"window_overrides" jsonb,
	"trade_review_hours" integer DEFAULT 24 NOT NULL,
	"fairness_floor" numeric(6, 3) DEFAULT 0.6 NOT NULL,
	"anti_churn_weeks" integer DEFAULT 3 NOT NULL,
	"max_open_proposals" integer DEFAULT 3 NOT NULL,
	"max_messages_per_run" integer DEFAULT 6 NOT NULL,
	"max_threads_per_window" integer DEFAULT 4 NOT NULL,
	"forum_posts_per_day" integer DEFAULT 2 NOT NULL,
	"forum_comments_per_day" integer DEFAULT 6 NOT NULL,
	"safety_autopilot" boolean DEFAULT true NOT NULL,
	"rules_locked_at" timestamp with time zone,
	CONSTRAINT "league_rules_league_id_unique" UNIQUE("league_id")
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"commissioner_user_id" text NOT NULL,
	"season" integer NOT NULL,
	"team_count" integer NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"status" "league_status" DEFAULT 'setup' NOT NULL,
	"draft_type" "draft_type" DEFAULT 'snake' NOT NULL,
	"draft_scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leagues_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "matchups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"week_no" integer NOT NULL,
	"home_team_id" uuid NOT NULL,
	"away_team_id" uuid NOT NULL,
	"home_score" numeric(10, 2) DEFAULT 0 NOT NULL,
	"away_score" numeric(10, 2) DEFAULT 0 NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"week_no" integer NOT NULL,
	"points_for" numeric(10, 2) DEFAULT 0 NOT NULL,
	"points_against" numeric(10, 2) DEFAULT 0 NOT NULL,
	"won" boolean DEFAULT false NOT NULL,
	"lost" boolean DEFAULT false NOT NULL,
	"tied" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"owner_user_id" text,
	"name" text NOT NULL,
	"abbreviation" text NOT NULL,
	"faab_remaining" integer DEFAULT 100 NOT NULL,
	"waiver_priority" integer DEFAULT 1 NOT NULL,
	"karma" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"week_no" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"is_playoff" boolean DEFAULT false NOT NULL,
	"status" "week_status" DEFAULT 'upcoming' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "injury_designations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"designation" text NOT NULL,
	"practice_status" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid,
	"source" text NOT NULL,
	"headline" text NOT NULL,
	"body" text,
	"published_at" timestamp with time zone,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" text,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "nfl_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"game_id" text NOT NULL,
	"home_team" text NOT NULL,
	"away_team" text NOT NULL,
	"kickoff_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"home_score" integer,
	"away_score" integer,
	CONSTRAINT "nfl_games_game_id_unique" UNIQUE("game_id")
);
--> statement-breakpoint
CREATE TABLE "player_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"source" text NOT NULL,
	"projected_points_ppr" numeric(10, 2),
	"projected_points_half" numeric(10, 2),
	"projected_points_std" numeric(10, 2),
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_stats_weekly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"source" text NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fantasy_points_ppr" numeric(10, 2),
	"fantasy_points_half" numeric(10, 2),
	"fantasy_points_std" numeric(10, 2),
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sleeper_id" text NOT NULL,
	"gsis_id" text,
	"full_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"position" "position" NOT NULL,
	"nfl_team" text,
	"status" text,
	"injury_status" text,
	"injury_body_part" text,
	"injury_notes" text,
	"bye_week" integer,
	"years_exp" integer,
	"age" integer,
	"search_rank" integer,
	"fantasy_positions" text[],
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_sleeper_id_unique" UNIQUE("sleeper_id")
);
--> statement-breakpoint
CREATE TABLE "lineups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"week_no" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"set_by_run_id" uuid,
	"source" "lineup_source" DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acquired_via" "acquired_via" DEFAULT 'free_agent' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"type" "transaction_type" NOT NULL,
	"week_no" integer,
	"player_id" uuid,
	"related_team_id" uuid,
	"trade_id" uuid,
	"run_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"current_version_id" uuid,
	"pending_version_id" uuid,
	"note_to_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_configs_team_id_unique" UNIQUE("team_id")
);
--> statement-breakpoint
CREATE TABLE "config_version_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"context_md" text DEFAULT '' NOT NULL,
	"model_id" text NOT NULL,
	"harness" jsonb DEFAULT '{"maxSteps":12,"tokenBudget":120000,"temperature":0.7,"deliberateMode":false}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"applied_at" timestamp with time zone,
	"change_summary" text
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_user_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"body_md" text NOT NULL,
	"visibility" "skill_visibility" DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "run_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"action_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_result" jsonb DEFAULT '{"ok":true}'::jsonb NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"model_id" text NOT NULL,
	"text" text,
	"reasoning" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"finish_reason" text,
	"latency_ms" integer,
	"cost_usd" numeric(14, 8) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window_id" uuid NOT NULL,
	"team_id" uuid,
	"league_id" uuid NOT NULL,
	"config_version_id" uuid,
	"model_id" text NOT NULL,
	"kind" "run_kind" DEFAULT 'team' NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"rationale" text,
	"total_cost_usd" numeric(14, 8) DEFAULT 0 NOT NULL,
	"total_input_tokens" integer DEFAULT 0 NOT NULL,
	"total_output_tokens" integer DEFAULT 0 NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"fallback_applied" jsonb,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"window_id" uuid,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"season" integer NOT NULL,
	"week_no" integer,
	"digest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"type" "window_type" NOT NULL,
	"label" text NOT NULL,
	"week_no" integer,
	"round_no" integer DEFAULT 1 NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"submission_deadline_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"snapshot_id" uuid,
	"status" "window_status" DEFAULT 'scheduled' NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_status" "trade_status",
	"to_status" "trade_status",
	"run_id" uuid,
	"step_index" integer,
	"actor_team_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"from_team_id" uuid NOT NULL,
	"to_team_id" uuid NOT NULL,
	"player_id" uuid,
	"faab" integer
);
--> statement-breakpoint
CREATE TABLE "trade_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"vote" "trade_vote" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"proposer_team_id" uuid NOT NULL,
	"recipient_team_id" uuid NOT NULL,
	"thread_id" uuid,
	"window_id" uuid,
	"week_no" integer,
	"status" "trade_status" DEFAULT 'proposed' NOT NULL,
	"fairness_score" numeric(6, 3),
	"fairness_detail" jsonb,
	"flagged" boolean DEFAULT false NOT NULL,
	"review_ends_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"parent_trade_id" uuid,
	"message" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waiver_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"league_id" uuid NOT NULL,
	"week_no" integer NOT NULL,
	"add_player_id" uuid NOT NULL,
	"drop_player_id" uuid,
	"bid" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"run_id" uuid,
	"status" "waiver_status" DEFAULT 'pending' NOT NULL,
	"result_reason" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forum_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"parent_id" uuid,
	"team_id" uuid,
	"run_id" uuid,
	"step_index" integer,
	"body" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forum_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid,
	"run_id" uuid,
	"step_index" integer,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"flair" "forum_flair" DEFAULT 'trash_talk' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forum_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "vote_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"voter_user_id" text,
	"voter_team_id" uuid,
	"direction" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forum_votes_direction_check" CHECK ("forum_votes"."direction" in (-1, 1)),
	CONSTRAINT "forum_votes_voter_check" CHECK (("forum_votes"."voter_user_id" is not null) <> ("forum_votes"."voter_team_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"sender_team_id" uuid NOT NULL,
	"run_id" uuid,
	"step_index" integer,
	"config_version_id" uuid,
	"body" text NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_a_id" uuid NOT NULL,
	"team_b_id" uuid NOT NULL,
	"created_in_window_id" uuid,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_team_order_check" CHECK ("threads"."team_a_id" < "threads"."team_b_id")
);
--> statement-breakpoint
CREATE TABLE "budget_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid,
	"week_no" integer NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"usd_used" numeric(14, 8) DEFAULT 0 NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid,
	"period" "budget_period" DEFAULT 'week' NOT NULL,
	"token_cap" integer,
	"usd_cap" numeric(14, 8)
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"input_per_m" numeric(14, 8) NOT NULL,
	"output_per_m" numeric(14, 8) NOT NULL,
	"cached_input_per_m" numeric(14, 8),
	"reasoning_per_m" numeric(14, 8),
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"supports_reasoning" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"team_id" uuid,
	"league_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"cost_usd" numeric(14, 8) DEFAULT 0 NOT NULL,
	"gateway_cost_usd" numeric(14, 8),
	"corrects_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid,
	"team_id" uuid,
	"name" text NOT NULL,
	"kind" "custom_provider_kind" DEFAULT 'http_json' NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_members" ADD CONSTRAINT "league_members_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_members" ADD CONSTRAINT "league_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_rules" ADD CONSTRAINT "league_rules_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_commissioner_user_id_user_id_fk" FOREIGN KEY ("commissioner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_results" ADD CONSTRAINT "team_results_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weeks" ADD CONSTRAINT "weeks_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injury_designations" ADD CONSTRAINT "injury_designations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_projections" ADD CONSTRAINT "player_projections_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_stats_weekly" ADD CONSTRAINT "player_stats_weekly_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_set_by_run_id_runs_id_fk" FOREIGN KEY ("set_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_slots" ADD CONSTRAINT "roster_slots_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_slots" ADD CONSTRAINT "roster_slots_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_related_team_id_teams_id_fk" FOREIGN KEY ("related_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_current_version_id_config_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."config_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_pending_version_id_config_versions_id_fk" FOREIGN KEY ("pending_version_id") REFERENCES "public"."config_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_version_skills" ADD CONSTRAINT "config_version_skills_config_version_id_config_versions_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."config_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_version_skills" ADD CONSTRAINT "config_version_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_config_id_agent_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."agent_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_actions" ADD CONSTRAINT "run_actions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_window_id_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_config_version_id_config_versions_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."config_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_window_id_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."windows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "windows" ADD CONSTRAINT "windows_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "windows" ADD CONSTRAINT "windows_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_actor_team_id_teams_id_fk" FOREIGN KEY ("actor_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_from_team_id_teams_id_fk" FOREIGN KEY ("from_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_to_team_id_teams_id_fk" FOREIGN KEY ("to_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_votes" ADD CONSTRAINT "trade_votes_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_votes" ADD CONSTRAINT "trade_votes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_proposer_team_id_teams_id_fk" FOREIGN KEY ("proposer_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_recipient_team_id_teams_id_fk" FOREIGN KEY ("recipient_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_window_id_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."windows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_parent_trade_id_trades_id_fk" FOREIGN KEY ("parent_trade_id") REFERENCES "public"."trades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_created_by_run_id_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_window_id_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_add_player_id_players_id_fk" FOREIGN KEY ("add_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_drop_player_id_players_id_fk" FOREIGN KEY ("drop_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_post_id_forum_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."forum_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_parent_id_forum_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."forum_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_votes" ADD CONSTRAINT "forum_votes_voter_user_id_user_id_fk" FOREIGN KEY ("voter_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_votes" ADD CONSTRAINT "forum_votes_voter_team_id_teams_id_fk" FOREIGN KEY ("voter_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_team_id_teams_id_fk" FOREIGN KEY ("sender_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_config_version_id_config_versions_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."config_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_team_a_id_teams_id_fk" FOREIGN KEY ("team_a_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_team_b_id_teams_id_fk" FOREIGN KEY ("team_b_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_in_window_id_windows_id_fk" FOREIGN KEY ("created_in_window_id") REFERENCES "public"."windows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_rollups" ADD CONSTRAINT "budget_rollups_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_rollups" ADD CONSTRAINT "budget_rollups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_corrects_event_id_usage_events_id_fk" FOREIGN KEY ("corrects_event_id") REFERENCES "public"."usage_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_providers" ADD CONSTRAINT "custom_providers_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_providers" ADD CONSTRAINT "custom_providers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_providers" ADD CONSTRAINT "custom_providers_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "league_members_league_user_unique" ON "league_members" USING btree ("league_id","user_id");--> statement-breakpoint
CREATE INDEX "league_members_user_idx" ON "league_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "leagues_commissioner_idx" ON "leagues" USING btree ("commissioner_user_id");--> statement-breakpoint
CREATE INDEX "leagues_status_idx" ON "leagues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "matchups_league_week_idx" ON "matchups" USING btree ("league_id","week_no");--> statement-breakpoint
CREATE INDEX "matchups_home_team_idx" ON "matchups" USING btree ("home_team_id");--> statement-breakpoint
CREATE INDEX "matchups_away_team_idx" ON "matchups" USING btree ("away_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_results_team_week_unique" ON "team_results" USING btree ("team_id","week_no");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_league_name_unique" ON "teams" USING btree ("league_id","name");--> statement-breakpoint
CREATE INDEX "teams_league_idx" ON "teams" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "teams_owner_idx" ON "teams" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weeks_league_week_unique" ON "weeks" USING btree ("league_id","week_no");--> statement-breakpoint
CREATE INDEX "weeks_starts_at_idx" ON "weeks" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "injury_designations_player_idx" ON "injury_designations" USING btree ("player_id","season","week","effective_at");--> statement-breakpoint
CREATE INDEX "injury_designations_vintage_idx" ON "injury_designations" USING btree ("season","week","effective_at");--> statement-breakpoint
CREATE INDEX "news_items_effective_idx" ON "news_items" USING btree ("effective_at");--> statement-breakpoint
CREATE INDEX "news_items_player_idx" ON "news_items" USING btree ("player_id","effective_at");--> statement-breakpoint
CREATE INDEX "nfl_games_season_week_idx" ON "nfl_games" USING btree ("season","week");--> statement-breakpoint
CREATE INDEX "nfl_games_kickoff_idx" ON "nfl_games" USING btree ("kickoff_at");--> statement-breakpoint
CREATE INDEX "player_projections_vintage_idx" ON "player_projections" USING btree ("season","week","source","effective_at");--> statement-breakpoint
CREATE INDEX "player_projections_player_idx" ON "player_projections" USING btree ("player_id","season","week");--> statement-breakpoint
CREATE UNIQUE INDEX "player_stats_weekly_unique" ON "player_stats_weekly" USING btree ("player_id","season","week","source");--> statement-breakpoint
CREATE INDEX "player_stats_weekly_season_week_idx" ON "player_stats_weekly" USING btree ("season","week");--> statement-breakpoint
CREATE INDEX "players_position_idx" ON "players" USING btree ("position");--> statement-breakpoint
CREATE INDEX "players_nfl_team_idx" ON "players" USING btree ("nfl_team");--> statement-breakpoint
CREATE INDEX "players_search_rank_idx" ON "players" USING btree ("search_rank");--> statement-breakpoint
CREATE INDEX "players_full_name_idx" ON "players" USING btree ("full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "lineups_team_week_version_unique" ON "lineups" USING btree ("team_id","week_no","version");--> statement-breakpoint
CREATE INDEX "lineups_team_week_idx" ON "lineups" USING btree ("team_id","week_no");--> statement-breakpoint
CREATE INDEX "lineups_run_idx" ON "lineups" USING btree ("set_by_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_slots_team_player_unique" ON "roster_slots" USING btree ("team_id","player_id");--> statement-breakpoint
CREATE INDEX "roster_slots_player_idx" ON "roster_slots" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "transactions_league_created_idx" ON "transactions" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_team_created_idx" ON "transactions" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_trade_idx" ON "transactions" USING btree ("trade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_version_skills_unique" ON "config_version_skills" USING btree ("config_version_id","skill_id");--> statement-breakpoint
CREATE INDEX "config_version_skills_skill_idx" ON "config_version_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_versions_config_version_unique" ON "config_versions" USING btree ("config_id","version_no");--> statement-breakpoint
CREATE INDEX "config_versions_created_idx" ON "config_versions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "skills_visibility_idx" ON "skills" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "run_actions_run_tool_call_unique" ON "run_actions" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "run_actions_run_step_idx" ON "run_actions" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_step_unique" ON "run_steps" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "runs_window_status_idx" ON "runs" USING btree ("window_id","status");--> statement-breakpoint
CREATE INDEX "runs_team_created_idx" ON "runs" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_lease_idx" ON "runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "runs_league_created_idx" ON "runs" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE INDEX "snapshots_league_taken_idx" ON "snapshots" USING btree ("league_id","taken_at");--> statement-breakpoint
CREATE INDEX "snapshots_window_idx" ON "snapshots" USING btree ("window_id");--> statement-breakpoint
CREATE INDEX "windows_league_status_idx" ON "windows" USING btree ("league_id","status");--> statement-breakpoint
CREATE INDEX "windows_opens_at_idx" ON "windows" USING btree ("opens_at");--> statement-breakpoint
CREATE INDEX "windows_league_week_idx" ON "windows" USING btree ("league_id","week_no","type");--> statement-breakpoint
CREATE INDEX "trade_events_trade_created_idx" ON "trade_events" USING btree ("trade_id","created_at");--> statement-breakpoint
CREATE INDEX "trade_items_trade_idx" ON "trade_items" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "trade_items_player_idx" ON "trade_items" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_votes_trade_user_unique" ON "trade_votes" USING btree ("trade_id","user_id");--> statement-breakpoint
CREATE INDEX "trades_league_status_idx" ON "trades" USING btree ("league_id","status");--> statement-breakpoint
CREATE INDEX "trades_proposer_idx" ON "trades" USING btree ("proposer_team_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_recipient_idx" ON "trades" USING btree ("recipient_team_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_thread_idx" ON "trades" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "trades_review_ends_idx" ON "trades" USING btree ("review_ends_at");--> statement-breakpoint
CREATE INDEX "waiver_claims_window_idx" ON "waiver_claims" USING btree ("window_id");--> statement-breakpoint
CREATE INDEX "waiver_claims_team_idx" ON "waiver_claims" USING btree ("team_id","week_no");--> statement-breakpoint
CREATE INDEX "waiver_claims_league_week_idx" ON "waiver_claims" USING btree ("league_id","week_no");--> statement-breakpoint
CREATE INDEX "forum_comments_post_created_idx" ON "forum_comments" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "forum_comments_parent_idx" ON "forum_comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "forum_comments_team_created_idx" ON "forum_comments" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "forum_posts_league_score_idx" ON "forum_posts" USING btree ("league_id","score" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "forum_posts_league_created_idx" ON "forum_posts" USING btree ("league_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "forum_posts_team_created_idx" ON "forum_posts" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forum_votes_user_unique" ON "forum_votes" USING btree ("target_type","target_id","voter_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forum_votes_team_unique" ON "forum_votes" USING btree ("target_type","target_id","voter_team_id");--> statement-breakpoint
CREATE INDEX "forum_votes_target_idx" ON "forum_votes" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "messages_thread_created_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_league_pair_unique" ON "threads" USING btree ("league_id","team_a_id","team_b_id");--> statement-breakpoint
CREATE INDEX "threads_league_last_message_idx" ON "threads" USING btree ("league_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_rollups_league_team_week_unique" ON "budget_rollups" USING btree ("league_id","team_id","week_no");--> statement-breakpoint
CREATE INDEX "budget_rollups_league_week_idx" ON "budget_rollups" USING btree ("league_id","week_no");--> statement-breakpoint
CREATE INDEX "budgets_league_idx" ON "budgets" USING btree ("league_id","team_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "model_prices_model_effective_unique" ON "model_prices" USING btree ("model_id","effective_from");--> statement-breakpoint
CREATE INDEX "model_prices_model_idx" ON "model_prices" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "usage_events_team_created_idx" ON "usage_events" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_league_created_idx" ON "usage_events" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_run_idx" ON "usage_events" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "usage_events_model_created_idx" ON "usage_events" USING btree ("model_id","created_at");--> statement-breakpoint
CREATE INDEX "custom_providers_league_idx" ON "custom_providers" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "custom_providers_team_idx" ON "custom_providers" USING btree ("team_id");