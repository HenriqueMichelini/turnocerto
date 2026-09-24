INSERT OR IGNORE INTO management_spaces (id, name)
VALUES ('preview-space', 'Espaço de demonstração');

INSERT OR IGNORE INTO schedules (id, management_space_id, name)
VALUES ('preview-fixture', 'preview-space', 'Escala de demonstração');
