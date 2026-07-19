"""The hosted waddle platform server.

Multi-tenant experiment tracking to the W&B standard: Postgres owns
transactional metadata (projects/runs/workers/batch ledger), ClickHouse owns
metric and log serving, R2 owns blobs and the org-partitioned Parquet layer.
Company isolation is the central identity control plane's ``Principal.org``
(audience ``waddle``); every row carries the org id derived server-side.
"""
