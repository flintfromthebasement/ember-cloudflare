-- Whether only those who can change a posts room, its administrators and its creator, start posts in it,
-- kept by the Workspace (scope "workspace" in src/migrations.ts): 1 for a room where everyone else comments
-- and replies only, as an announcements room has it, and 0 for one where anyone in it posts.
ALTER TABLE rooms ADD COLUMN posts_by_admins INTEGER NOT NULL DEFAULT 0;
