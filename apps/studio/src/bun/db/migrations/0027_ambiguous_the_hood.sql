-- 云服务商：可同时启用多个（enabled）+ 生视频接口协议（video_api）。
-- （drizzle-kit 生成时顺带重复了 0026 已加过的 agent_events.subagent_id，已剔除。）
ALTER TABLE `cloud_providers` ADD `enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cloud_providers` ADD `video_api` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `cloud_providers` SET `enabled` = 1 WHERE `id` = (SELECT `value` FROM `settings` WHERE `key` = 'CLOUD_PROVIDER');--> statement-breakpoint
UPDATE `cloud_providers` SET `video_api` = 'minimax' WHERE `id` = 'minimax';--> statement-breakpoint
UPDATE `cloud_providers` SET `video_api` = 'seedance' WHERE `id` = 'doubao';
