export const librarianConversationStatements = [
  `CREATE TABLE librarian_conversations (
    id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE librarian_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES librarian_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
    content TEXT NOT NULL,
    tool_name TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX librarian_messages_conversation_idx ON librarian_messages(conversation_id,created_at,id)",
] as const;
