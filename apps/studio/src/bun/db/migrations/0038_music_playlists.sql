CREATE TABLE `music_playlist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`record_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `music_playlist_items_playlist_idx` ON `music_playlist_items` (`playlist_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `music_playlist_items_playlist_id_record_id_unique` ON `music_playlist_items` (`playlist_id`,`record_id`);--> statement-breakpoint
CREATE TABLE `music_playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`builtin` integer DEFAULT 0 NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
