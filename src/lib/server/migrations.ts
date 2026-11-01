import type { Database } from 'bun:sqlite';

export function allowUnlinkedAppleAccounts(db: Database) {
	const columns = db.query('PRAGMA table_info(users)').all() as { name: string; notnull: number }[];
	if (!columns.some((column) => column.name === 'apple_sub' && column.notnull)) return;
	// Rebuild the parent table without cascading deletions into mail, sessions or passkeys
	db.exec('PRAGMA foreign_keys=OFF');
	try {
		db.transaction(() => {
			db.exec(`CREATE TABLE users_unlink_migration (id TEXT PRIMARY KEY, apple_sub TEXT UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
				INSERT INTO users_unlink_migration SELECT id,apple_sub,name,email,revision FROM users;
				DROP TABLE users;
				ALTER TABLE users_unlink_migration RENAME TO users;`);
			if (db.query('PRAGMA foreign_key_check').all().length)
				throw new Error('Apple account migration failed foreign key validation');
		})();
	} finally {
		db.exec('PRAGMA foreign_keys=ON');
	}
}
