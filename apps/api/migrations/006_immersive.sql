-- The v2 runtime uses the existing game_sessions, commands, results and outbox tables.
INSERT INTO module_flags(id,enabled) VALUES('immersive',true) ON CONFLICT(id) DO NOTHING;
