-- Replies to comments (scope "room" in src/migrations.ts), as a posts room has them: a reply in a post's
-- thread names the post as its parent, as every reply does, and a reply to one of its comments, the replies
-- with no reply_to_id, names that comment too, two levels and no deeper. A reply to a reply to a comment
-- names the same comment, and so goes under it, beside the reply it answers.
ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
-- A comment's replies, and how many it has. Most messages aren't replies to comments, so most aren't in it.
CREATE INDEX IF NOT EXISTS index_messages_on_reply_to_id_and_id ON messages (reply_to_id, id) WHERE reply_to_id IS NOT NULL;
-- A post's comments, without the replies to them, a page at a time.
CREATE INDEX IF NOT EXISTS index_messages_on_parent_id_and_id_for_comments ON messages (parent_id, id) WHERE parent_id IS NOT NULL AND reply_to_id IS NULL;
