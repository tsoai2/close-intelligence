-- CLOSE INTELLIGENCE schema v1. Amounts are INTEGER minor units (e.g. cents). Datetimes are
-- naive local ISO strings (YYYY-MM-DDTHH:mm) in the organization timezone unless noted.
CREATE TABLE orgs(id INTEGER PRIMARY KEY, name TEXT NOT NULL, base_currency TEXT NOT NULL DEFAULT 'USD',
  timezone TEXT NOT NULL DEFAULT 'America/Chicago', settings TEXT NOT NULL DEFAULT '{}', onboarding TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE calendars(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id), name TEXT NOT NULL,
  workdays TEXT NOT NULL DEFAULT '[1,2,3,4,5]', holidays TEXT NOT NULL DEFAULT '[]', day_start INTEGER NOT NULL DEFAULT 540, day_end INTEGER NOT NULL DEFAULT 1020);
CREATE TABLE entities(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id), code TEXT NOT NULL, name TEXT NOT NULL,
  currency TEXT NOT NULL, timezone TEXT, calendar_id INTEGER REFERENCES calendars(id), active INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id, code));
CREATE TABLE users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id), email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, title TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin','close_manager','preparer','reviewer','executive','auditor','external')),
  password_hash TEXT, active INTEGER NOT NULL DEFAULT 1, backup_user_id INTEGER, capacity_min INTEGER NOT NULL DEFAULT 360,
  external_org TEXT, out_from TEXT, out_to TEXT, created_at TEXT NOT NULL);
CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), org_id INTEGER NOT NULL, csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, preview INTEGER NOT NULL DEFAULT 0);
CREATE TABLE invitations(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, email TEXT NOT NULL, name TEXT, role TEXT NOT NULL, external_org TEXT,
  token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, created_by INTEGER, request_id INTEGER);

CREATE TABLE templates(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'custom', description TEXT);
CREATE TABLE template_versions(id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES templates(id), version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', notes TEXT, created_at TEXT NOT NULL, published_at TEXT);
CREATE TABLE template_tasks(id INTEGER PRIMARY KEY, template_version_id INTEGER NOT NULL REFERENCES template_versions(id), key TEXT NOT NULL, name TEXT NOT NULL,
  process TEXT, scope TEXT NOT NULL DEFAULT 'entity', account TEXT, description TEXT, purpose TEXT, instructions TEXT, recurrence TEXT NOT NULL DEFAULT 'monthly',
  offset_bd INTEGER NOT NULL DEFAULT 1, due_time TEXT NOT NULL DEFAULT '17:00', duration_min INTEGER, review_min INTEGER, priority TEXT DEFAULT 'normal', risk TEXT DEFAULT 'medium',
  evidence TEXT NOT NULL DEFAULT '[]', acceptance TEXT, steps TEXT NOT NULL DEFAULT '[]', deps TEXT NOT NULL DEFAULT '[]', owner_role TEXT);

CREATE TABLE periods(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id), name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'monthly',
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, day0 TEXT NOT NULL, target_close TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  template_version_id INTEGER, actual_close_at TEXT, locked_by INTEGER, lock_note TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id, name));
CREATE TABLE tasks(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL REFERENCES periods(id), entity_id INTEGER REFERENCES entities(id),
  template_task_id INTEGER, key TEXT NOT NULL, name TEXT NOT NULL, process TEXT, account TEXT, description TEXT, purpose TEXT, instructions TEXT,
  recurrence TEXT DEFAULT 'monthly', offset_bd INTEGER, due_at TEXT, duration_min INTEGER, review_min INTEGER, priority TEXT DEFAULT 'normal', risk TEXT DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'not_started', owner_id INTEGER, preparer_id INTEGER, reviewer_id INTEGER, backup_id INTEGER,
  consulted TEXT NOT NULL DEFAULT '[]', informed TEXT NOT NULL DEFAULT '[]', evidence_req TEXT NOT NULL DEFAULT '[]', acceptance TEXT, wait_reason TEXT,
  started_at TEXT, submitted_at TEXT, approved_at TEXT, review_rounds INTEGER NOT NULL DEFAULT 0, reopened_count INTEGER NOT NULL DEFAULT 0,
  needs_rereview INTEGER NOT NULL DEFAULT 0, upstream_changed INTEGER NOT NULL DEFAULT 0, override_note TEXT, accepted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT);
CREATE INDEX tasks_period ON tasks(org_id, period_id);
CREATE TABLE task_steps(id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), label TEXT NOT NULL, mandatory INTEGER NOT NULL DEFAULT 1,
  done INTEGER NOT NULL DEFAULT 0, done_by INTEGER, done_at TEXT, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE dependencies(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, from_task_id INTEGER NOT NULL REFERENCES tasks(id),
  to_task_id INTEGER NOT NULL REFERENCES tasks(id), type TEXT NOT NULL DEFAULT 'FS' CHECK(type IN ('FS','SS')), lag_min INTEGER NOT NULL DEFAULT 0,
  gate TEXT NOT NULL DEFAULT 'approved' CHECK(gate IN ('prepared','approved')), kind TEXT NOT NULL DEFAULT 'execution' CHECK(kind IN ('execution','informational')),
  UNIQUE(from_task_id, to_task_id, kind));
CREATE TABLE relationships(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL, rel TEXT NOT NULL, note TEXT);
CREATE TABLE task_events(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, task_id INTEGER NOT NULL, type TEXT NOT NULL,
  from_status TEXT, to_status TEXT, user_id INTEGER, note TEXT, at TEXT NOT NULL);
CREATE INDEX task_events_task ON task_events(task_id);
CREATE TABLE comments(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'comment', at TEXT NOT NULL);

CREATE TABLE requests(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, title TEXT NOT NULL, deliverable TEXT, sender_id INTEGER,
  recipient_name TEXT, recipient_org TEXT, recipient_user_id INTEGER, classification TEXT NOT NULL DEFAULT 'internal' CHECK(classification IN ('internal','external')),
  due_at TEXT, expected_at TEXT, status TEXT NOT NULL DEFAULT 'draft', last_response_at TEXT, last_response TEXT, next_action TEXT, delay_reason TEXT,
  reminders TEXT NOT NULL DEFAULT '[]', received_at TEXT, reviewed_at TEXT, links TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE request_tasks(request_id INTEGER NOT NULL REFERENCES requests(id), task_id INTEGER NOT NULL REFERENCES tasks(id), PRIMARY KEY(request_id, task_id));

CREATE TABLE accounts(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, statement TEXT, line TEXT, is_ic INTEGER NOT NULL DEFAULT 0, UNIQUE(org_id, code));
CREATE TABLE imports(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER, kind TEXT NOT NULL, filename TEXT, sha256 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'committed',
  row_count INTEGER, rejected TEXT NOT NULL DEFAULT '[]', totals TEXT NOT NULL DEFAULT '{}', mapping TEXT NOT NULL DEFAULT '{}', created_by INTEGER, at TEXT NOT NULL,
  superseded_by INTEGER, relied_on INTEGER NOT NULL DEFAULT 0, note TEXT);
CREATE TABLE tb_lines(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, import_id INTEGER NOT NULL REFERENCES imports(id), period_id INTEGER NOT NULL, entity_id INTEGER NOT NULL,
  account TEXT NOT NULL, account_name TEXT, currency TEXT NOT NULL, debit INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0, current INTEGER NOT NULL DEFAULT 1);
CREATE INDEX tb_lookup ON tb_lines(org_id, period_id, entity_id, account, current);
CREATE TABLE budgets(org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, account TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(org_id, period_id, entity_id, account));
CREATE TABLE fx_rates(org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, from_ccy TEXT NOT NULL, to_ccy TEXT NOT NULL, rate_type TEXT NOT NULL, rate TEXT NOT NULL, rate_date TEXT, source TEXT,
  PRIMARY KEY(org_id, period_id, from_ccy, to_ccy, rate_type));
CREATE TABLE variance_notes(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, account TEXT NOT NULL, comparison TEXT NOT NULL,
  explanation TEXT, status TEXT NOT NULL DEFAULT 'explained', user_id INTEGER, reviewed_by INTEGER, at TEXT, UNIQUE(org_id, period_id, entity_id, account, comparison));
CREATE TABLE ic_items(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, counterparty_id INTEGER NOT NULL, side TEXT NOT NULL,
  amount INTEGER NOT NULL, currency TEXT NOT NULL, reference TEXT, status TEXT NOT NULL DEFAULT 'open', owner_id INTEGER, resolution TEXT, settlement TEXT DEFAULT 'unsettled');

CREATE TABLE reconciliations(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, task_id INTEGER, account TEXT NOT NULL, name TEXT NOT NULL,
  currency TEXT NOT NULL, beginning INTEGER, activity INTEGER, gl_balance INTEGER, support_balance INTEGER, support_source TEXT, threshold INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_started', preparer_id INTEGER, reviewer_id INTEGER, explanation TEXT, workpaper_version INTEGER NOT NULL DEFAULT 1, source_version INTEGER NOT NULL DEFAULT 1,
  source_import_id INTEGER, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT);
CREATE TABLE rec_items(id INTEGER PRIMARY KEY, rec_id INTEGER NOT NULL REFERENCES reconciliations(id), description TEXT NOT NULL, amount INTEGER NOT NULL, item_date TEXT,
  category TEXT, explanation TEXT, owner_id INTEGER, resolved INTEGER NOT NULL DEFAULT 0);
-- Approvals are version-bound and never overwritten: a new row is written for each decision.
CREATE TABLE approvals(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, target_version INTEGER, source_version INTEGER,
  user_id INTEGER NOT NULL, decision TEXT NOT NULL, note TEXT, sod_exception TEXT, at TEXT NOT NULL);
CREATE TABLE journals(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, ref TEXT NOT NULL, description TEXT, type TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'draft', lines TEXT NOT NULL DEFAULT '[]', support TEXT, preparer_id INTEGER, approver_id INTEGER, approved_at TEXT, posting_ref TEXT, posted_confirmed_at TEXT,
  posted_confirmed_by INTEGER, reverses_id INTEGER, late INTEGER NOT NULL DEFAULT 0, task_id INTEGER, version INTEGER NOT NULL DEFAULT 1, created_at TEXT);

CREATE TABLE documents(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, title TEXT NOT NULL, doc_class TEXT NOT NULL DEFAULT 'workpaper', owner_id INTEGER, purpose TEXT, entity_id INTEGER, process TEXT,
  period_id INTEGER, source_system TEXT, cadence TEXT, preparer_id INTEGER, reviewer_id INTEGER, upstream TEXT, retention TEXT, legal_hold INTEGER NOT NULL DEFAULT 0,
  classification TEXT NOT NULL DEFAULT 'unclassified', classification_note TEXT, classified_by INTEGER, classified_at TEXT, link_url TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT);
CREATE TABLE document_versions(id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id), version INTEGER NOT NULL, filename TEXT NOT NULL, mime TEXT, size INTEGER,
  sha256 TEXT NOT NULL, storage_key TEXT NOT NULL, extracted TEXT, extraction_status TEXT NOT NULL DEFAULT 'pending', extraction_notes TEXT, scan_status TEXT NOT NULL DEFAULT 'not_scanned',
  uploaded_by INTEGER, at TEXT NOT NULL);
CREATE TABLE doc_links(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, document_id INTEGER NOT NULL REFERENCES documents(id), target_type TEXT NOT NULL, target_id INTEGER NOT NULL, rel TEXT NOT NULL);
CREATE TABLE doc_usage(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, document_id INTEGER NOT NULL, user_id INTEGER, kind TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE evidence(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, task_id INTEGER NOT NULL REFERENCES tasks(id), period_id INTEGER NOT NULL, document_version_id INTEGER NOT NULL,
  requirement TEXT, attached_by INTEGER, at TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE controls(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, objective TEXT, process TEXT, frequency TEXT, owner_id INTEGER,
  evidence_required TEXT, precision TEXT, policy_ref TEXT, task_keys TEXT NOT NULL DEFAULT '[]');
CREATE TABLE deficiencies(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, control_id INTEGER NOT NULL, period_id INTEGER, description TEXT NOT NULL, severity TEXT, remediation TEXT, owner_id INTEGER, due_at TEXT, status TEXT NOT NULL DEFAULT 'open');
CREATE TABLE exceptions(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, exposure INTEGER, currency TEXT, owner_id INTEGER, due_at TEXT,
  disposition TEXT, status TEXT NOT NULL DEFAULT 'open', carryforward INTEGER NOT NULL DEFAULT 0, approved_by INTEGER, source_type TEXT, source_id INTEGER, created_at TEXT);
CREATE TABLE signoffs(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, level TEXT NOT NULL, label TEXT NOT NULL, required_role TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER, at TEXT, note TEXT, status TEXT NOT NULL DEFAULT 'pending', snapshot TEXT);

CREATE TABLE findings(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER, rule TEXT NOT NULL, fingerprint TEXT NOT NULL, category TEXT, title TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', confirmed_cause TEXT, reviewed_by INTEGER, reviewed_at TEXT, first_seen TEXT, last_seen TEXT, UNIQUE(org_id, fingerprint));
CREATE TABLE improvements(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, finding_id INTEGER, title TEXT NOT NULL, kind TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'proposed',
  owner_id INTEGER, approver_id INTEGER, effort TEXT, details TEXT NOT NULL DEFAULT '{}', history TEXT NOT NULL DEFAULT '[]', created_by INTEGER, created_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE scenarios(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, name TEXT NOT NULL, overrides TEXT NOT NULL DEFAULT '{}', result TEXT, status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER, at TEXT, published_at TEXT, published_by INTEGER);
CREATE TABLE retro_items(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, period_id INTEGER NOT NULL, section TEXT NOT NULL, text TEXT NOT NULL, owner_id INTEGER, due_at TEXT, status TEXT DEFAULT 'open', created_by INTEGER, at TEXT);

CREATE TABLE notifications(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, read INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
CREATE TABLE saved_views(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, screen TEXT NOT NULL, name TEXT NOT NULL, filters TEXT NOT NULL);
CREATE TABLE jobs(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0, payload TEXT, result TEXT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE ai_settings(org_id INTEGER PRIMARY KEY, key_cipher TEXT, key_hint TEXT, model TEXT, status TEXT NOT NULL DEFAULT 'disconnected', last_tested_at TEXT, last_error TEXT,
  spend_limit_cents INTEGER NOT NULL DEFAULT 2000, price_in_per_mtok_cents INTEGER, price_out_per_mtok_cents INTEGER, allowed_classes TEXT NOT NULL DEFAULT '["procedure","policy"]',
  redact INTEGER NOT NULL DEFAULT 1, user_rate_per_hour INTEGER NOT NULL DEFAULT 30, updated_by INTEGER, updated_at TEXT);
CREATE TABLE ai_usage(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER, mode TEXT NOT NULL, model TEXT, purpose TEXT, input_tokens INTEGER, output_tokens INTEGER, est_cost_cents REAL, status TEXT, at TEXT NOT NULL);

-- Append-only audit trail with a hash chain. Triggers block UPDATE/DELETE through the application
-- connection; anyone with file-system access to the database can still alter it (see docs/SECURITY.md).
CREATE TABLE audit_events(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, at TEXT NOT NULL, wall_at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, target_type TEXT, target_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}', prev_hash TEXT, hash TEXT NOT NULL);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
