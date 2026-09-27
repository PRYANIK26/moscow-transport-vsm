INSERT INTO module_flags(id,enabled) VALUES('materials',true) ON CONFLICT(id) DO NOTHING;
