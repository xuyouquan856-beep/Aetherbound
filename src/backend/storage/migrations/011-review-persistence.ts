export const reviewPersistenceStatements = [
  "ALTER TABLE librarian_conversations ADD COLUMN review_json TEXT",
  "ALTER TABLE librarian_conversations ADD COLUMN review_status TEXT NOT NULL DEFAULT 'none' CHECK(review_status IN ('none','pending','applied','expired','cancelled','failed'))",
] as const;
