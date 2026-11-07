export const collectionImportAliasStatements = [
  `CREATE TABLE collection_import_aliases (
    folder_path TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX collection_import_aliases_collection_idx
    ON collection_import_aliases(collection_id)`,
] as const;
