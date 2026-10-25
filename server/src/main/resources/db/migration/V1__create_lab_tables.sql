CREATE TABLE lab_post (
  id BIGINT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE lab_comment (
  id BIGINT PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES lab_post(id) ON DELETE CASCADE,
  content VARCHAR(500) NOT NULL
);
CREATE INDEX idx_lab_comment_post_id ON lab_comment(post_id);
CREATE TABLE lab_attachment (
  id BIGINT PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES lab_post(id) ON DELETE CASCADE,
  file_name VARCHAR(200) NOT NULL,
  byte_size BIGINT NOT NULL
);
CREATE INDEX idx_lab_attachment_post_id ON lab_attachment(post_id);
CREATE TABLE lab_dataset_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  post_count INTEGER NOT NULL,
  comments_per_post INTEGER NOT NULL,
  attachments_per_post INTEGER NOT NULL,
  body_bytes INTEGER NOT NULL,
  seed BIGINT NOT NULL,
  distribution VARCHAR(20) NOT NULL
);
