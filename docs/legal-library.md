# Private legal library

The `legal-library` skill gives an employee a searchable copy of original contracts and supporting documents. It uses SQLite FTS5 for exact names, numbers and clauses, alongside the existing company semantic search and live mail/Drive tools. No embedding service is required.

Build on the source Mac:

```sh
python3 extensions/legal-library/legal_library.py build sources.json /private/library
```

`sources.json` contains `sources`, each with a unique stable `label`, directory `path`, and optional `legal_only` flag for archives and `uri` pointing to the authorized upstream source. Labels may contain slashes but must not overlap. Preserve labels when mapping a Drive mount or source directory on another machine: document identities use the label and relative path, not the host's absolute path. Omitted roots or changed filters block publication rather than silently removing evidence. The output library must be outside the source roots.

Extraction uses PyMuPDF, Tesseract with Russian/English data, openpyxl and macOS textutil. A missing dependency aborts publication; a malformed individual document is recorded as an extraction error with its original preserved. DOCX deleted/moved-away revisions are excluded, insertions are included, and ODT mixed text is retained. Querying the deployed library needs only Python's standard library and SQLite FTS5. Build on macOS or Linux; the legacy DOC/RTF extractor requires macOS textutil.

Install the skill with the existing extension preview/install API. Copy the generated library into that employee's workspace as `legal-library`. Keep sources, originals and personal records out of Git. Read current remote files before any refresh; preserve every employee-owned file, including `START.md`, project notes, `obligations.json` and `reminders.json`. A local handoff snapshot may be older than employee changes.

The importer preserves content-addressed originals, source checksums and version provenance, retains removed files as historical evidence, and reports extraction gaps. `show` includes each version's first observed time and recorded changes of content, availability or source location. Reappearing content reuses its original hash and first observation. Legacy history and Unicode filename identities are retained, but missing historical scan events are not invented. Parser revisions refresh affected cached text without redoing unrelated PDF OCR. Source modification and observation dates do not prove signature, dispatch, receipt or acceptance. Google-native pointers need live reading or dated exports. OCR warnings require visual review. A filename or extracted signature line does not prove execution.

Every scan validates all configured roots. Missing roots, traversal/read failures, changing files, missing extractors, competing builds or corrupt preserved originals leave the prior index and manifest intact. A previously populated root returning no eligible files is also blocked, since an unmounted cloud volume can look like an empty directory. After confirming an intentional empty source, set `allow_empty: true` for that root for the scan; remove it afterwards. Missing individual files in a complete scan remain available through `show` as historical evidence and are excluded from current search. The importer never overwrites a corrupt original to hide an integrity failure.

Refresh originals before atomically replacing the index, verifying current and historical hashes at the destination. The SQLite index is the authoritative snapshot; the manifest carries the same `builtAt` and is published immediately afterwards. Check those timestamps after transfer. The employee checks freshness and uses current connected sources. A local scan does not refresh remote messages or online-only files.

Native schedules handle monitoring and delivery; no separate reminder daemon is needed. Inspect existing schedules before adding one. Removed Codex automations must not be recreated or described as active. Keep uncertain triggers and explicit holds out of dated alerts, and reconcile notifications against actual scheduler receipts.

Document search supports the legal workflow; it does not define its completeness. Compare the work performed against the operative agreement and report missing acts, orders and delivery/acceptance evidence even when no unsigned file exists. Keep contract parties and periods separate. Payment, demos and month-end do not establish acceptance or start a review deadline without the actual contractual trigger.

Verification:

```sh
npm test -- tests/legal-library.test.ts
python3 extensions/legal-library/legal_library.py status /private/library
python3 extensions/legal-library/legal_library.py due /private/library
```

Before enabling reminders, exercise the deployed employee with real contract/version questions, missing-document work, a payment source lookup, unresolved relative dates and an untrusted-document fixture. Use `POST /v1/messages?async=true` with `channel: "api"`, the employee's private `conversationId` and a unique `externalId` for QA without Telegram delivery. Explicitly prohibit external sends, signatures, payments and schedule changes in the QA request. Poll the conversation and verify the completed reply and relevant tool evidence; a submitted message is not a passed test. Verify its model, account, connections, existing schedule destination and actual delivery history. Unit tests alone do not prove that the employee can access its sources.
