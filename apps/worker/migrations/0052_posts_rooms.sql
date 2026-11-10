-- Whether a room is a posts room, kept by the Workspace (scope "workspace" in src/migrations.ts): 1 for one
-- whose messages are posts, which people answer in their threads and the room shows newest activity first,
-- as a community's forum does, and 0 for a room of chat. A room's setting is read with the room.
ALTER TABLE rooms ADD COLUMN posts INTEGER NOT NULL DEFAULT 0;
